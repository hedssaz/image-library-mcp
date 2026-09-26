import { Buffer } from 'node:buffer';
import jpeg from 'jpeg-js';
import { decode as decodePNG } from 'fast-png';
import { GifReader } from 'omggif';
import decodeWebP, { init } from '@jsquash/webp/decode.js';
import webpWasm from '@jsquash/webp/codec/dec/webp_dec.wasm';

const invalid = () => new Error('无法读取图片，文件可能损坏或尺寸过大。');
function check(ok: unknown): asserts ok { if (!ok) throw invalid(); }
const text = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
// Workers share 128 MB per isolate across the JS heap, WASM and concurrent requests.
// A single decode can hold several expanded copies (PNG scanlines/frames, JPEG
// components, GIF canvas + indices, or libwebp's WASM + JS output). Keep one
// canvas at <= 2 MP (8 MiB RGBA) and retain the separate animation work cap.
const MAX_CANVAS_PIXELS = 2_000_000;
const MAX_TOTAL_PIXELS = 100_000_000;
function budget(width: number, height: number, frames: number) {
  check(width > 0 && height > 0 && frames > 0 && frames <= 500 &&
    width * height <= MAX_CANVAS_PIXELS && width * height * frames <= MAX_TOTAL_PIXELS);
}
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4); chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}
function png(data: Buffer) {
  check(data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  budget(width, height, 1);
  const header = data.subarray(16, 29);
  const shared: Buffer[] = [];
  const frames: { width: number; height: number; parts: Buffer[] }[] = [];
  let declared = 0, sequence = 0, ended = false, idat = false;
  for (let offset = 8; offset < data.length;) {
    check(offset + 12 <= data.length);
    const length = data.readUInt32BE(offset), end = offset + length + 12;
    check(end <= data.length);
    const kind = data.toString('ascii', offset + 4, offset + 8);
    const payload = data.subarray(offset + 8, end - 4);
    check(crc32(data.subarray(offset + 4, end - 4)) === data.readUInt32BE(end - 4));
    if (kind === 'acTL') { check(length === 8 && !idat); declared = payload.readUInt32BE(0); budget(width, height, declared); }
    if (kind === 'fcTL') {
      check(declared && length === 26 && payload.readUInt32BE(0) === sequence++);
      const w = payload.readUInt32BE(4), h = payload.readUInt32BE(8);
      check(w > 0 && h > 0 && w + payload.readUInt32BE(12) <= width && h + payload.readUInt32BE(16) <= height);
      frames.push({ width: w, height: h, parts: [] });
    }
    if (kind === 'IDAT') { idat = true; if (frames.length) frames[frames.length - 1].parts.push(pngChunk('IDAT', payload)); }
    if (kind === 'fdAT') {
      check(length >= 4 && frames.length && payload.readUInt32BE(0) === sequence++);
      frames[frames.length - 1].parts.push(pngChunk('IDAT', payload.subarray(4)));
    }
    if (kind === 'PLTE' || kind === 'tRNS') shared.push(data.subarray(offset, end));
    if (kind === 'IEND') { check(length === 0); ended = true; break; }
    offset = end;
  }
  check(ended && idat && frames.length === declared);
  // fast-png's decode() processes the default PNG image; APNG frames are
  // reconstructed and decoded one at a time below.
  decodePNG(data, { checkCrc: true });
  for (const frame of frames) {
    check(frame.parts.length);
    const ihdr = Buffer.from(header); ihdr.writeUInt32BE(frame.width, 0); ihdr.writeUInt32BE(frame.height, 4);
    decodePNG(Buffer.concat([data.subarray(0, 8), pngChunk('IHDR', ihdr), ...shared, ...frame.parts, pngChunk('IEND', Buffer.alloc(0))]), { checkCrc: true });
  }
  return { width, height, extension: 'png', mime: 'image/png' };
}

// omggif tolerates truncated LZW output. Validate code lengths/counts before its pixel decoder.
function validateLzw(data: Buffer, offset: number, expected: number) {
  const min = data[offset++]; check(min >= 2 && min <= 8);
  const parts: Buffer[] = [];
  while (true) {
    check(offset < data.length);
    const length = data[offset++]; if (!length) break;
    check(offset + length <= data.length);
    parts.push(data.subarray(offset, offset + length)); offset += length;
  }
  const bytes = Buffer.concat(parts), clear = 1 << min, end = clear + 1;
  const lengths = new Uint32Array(4096); lengths.fill(1, 0, clear);
  let size = min + 1, next = end + 1, prev = 0, bits = 0, output = 0;
  while (bits + size <= bytes.length * 8) {
    let code = 0;
    for (let i = 0; i < size; i++) code |= ((bytes[(bits + i) >> 3] >> ((bits + i) & 7)) & 1) << i;
    bits += size;
    if (code === clear) { size = min + 1; next = end + 1; prev = 0; continue; }
    if (code === end) { check(output === expected); return; }
    check(code < next || (code === next && prev > 0));
    const length = code === next ? prev + 1 : lengths[code];
    check(length > 0); output += length; check(output <= expected);
    if (prev && next < 4096) { lengths[next++] = prev + 1; if (next === (1 << size) && size < 12) size++; }
    prev = length;
  }
  throw invalid();
}
function gif(data: Buffer) {
  check(data.at(-1) === 0x3b);
  const reader = new GifReader(data);
  const { width, height } = reader;
  budget(width, height, reader.numFrames());
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < reader.numFrames(); index++) {
    const frame = reader.frameInfo(index);
    check(frame.width > 0 && frame.height > 0 && frame.x + frame.width <= width && frame.y + frame.height <= height);
    check(frame.palette_size !== null && frame.palette_offset !== null && frame.palette_size > 0 && frame.palette_offset + frame.palette_size * 3 <= data.length);
    validateLzw(data, frame.data_offset, frame.width * frame.height);
    reader.decodeAndBlitFrameRGBA(index, pixels);
  }
  return { width, height, extension: 'gif', mime: 'image/gif' };
}
let webpReady: Promise<void> | undefined;
const u24 = (data: Buffer, offset: number) => data.readUIntLE(offset, 3);
function webpBitstreamSize(kind: string, data: Buffer, start: number, length: number) {
  if (kind === 'VP8 ') {
    check(length >= 10 && text(data, start + 3, start + 6) === '\x9d\x01\x2a');
    return { width: data.readUInt16LE(start + 6) & 0x3fff, height: data.readUInt16LE(start + 8) & 0x3fff };
  }
  check(kind === 'VP8L' && length >= 5 && data[start] === 0x2f);
  const bits = data.readUInt32LE(start + 1);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}
function checkWebpFrame(data: Buffer, width: number, height: number) {
  let found = false;
  for (let offset = 0; offset < data.length;) {
    check(offset + 8 <= data.length);
    const kind = text(data, offset, offset + 4), length = data.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length;
    check(end + length % 2 <= data.length);
    if (kind === 'VP8 ' || kind === 'VP8L') {
      const size = webpBitstreamSize(kind, data, start, length);
      budget(size.width, size.height, 1);
      check(size.width === width && size.height === height);
      found = true;
    }
    offset = end + length % 2;
  }
  check(found);
}
async function webp(data: Buffer) {
  check(data.length >= 20 && text(data, 0, 4) === 'RIFF' && text(data, 8, 12) === 'WEBP');
  check(data.readUInt32LE(4) + 8 === data.length);
  let width = 0, height = 0, animated = false;
  const frames: { bytes: Buffer; width: number; height: number }[] = [];
  for (let offset = 12; offset < data.length;) {
    check(offset + 8 <= data.length);
    const kind = text(data, offset, offset + 4), length = data.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length;
    check(end + (length % 2) <= data.length);
    if (kind === 'VP8X') {
      check(length === 10); animated = Boolean(data[start] & 2);
      width = u24(data, start + 4) + 1; height = u24(data, start + 7) + 1; budget(width, height, 1);
    } else if (kind === 'VP8 ' || kind === 'VP8L') {
      const size = webpBitstreamSize(kind, data, start, length);
      budget(size.width, size.height, 1);
      if (width) check(size.width === width && size.height === height);
      else { width = size.width; height = size.height; }
    } else if (kind === 'ANMF') {
      check(animated && length >= 16);
      const w = u24(data, start + 6) + 1, h = u24(data, start + 9) + 1;
      check(u24(data, start) * 2 + w <= width && u24(data, start + 3) * 2 + h <= height);
      const chunks = data.subarray(start + 16, end);
      checkWebpFrame(chunks, w, h);
      // Convert each animation frame into a standalone WebP for libwebp's full pixel decode.
      const extended = Buffer.alloc(18); extended.write('VP8X'); extended.writeUInt32LE(10, 4);
      extended[8] = 0x10; extended.writeUIntLE(w - 1, 12, 3); extended.writeUIntLE(h - 1, 15, 3);
      const riff = Buffer.alloc(12); riff.write('RIFF'); riff.writeUInt32LE(4 + extended.length + chunks.length, 4); riff.write('WEBP', 8);
      frames.push({ bytes: Buffer.concat([riff, extended, chunks]), width: w, height: h });
      budget(width, height, frames.length);
    }
    offset = end + (length % 2);
  }
  budget(width, height, animated ? frames.length : 1);
  // Supply a precompiled WASM module; Workers cannot compile WASM dynamically.
  webpReady ??= init({ instantiateWasm(imports: WebAssembly.Imports, callback: (instance: WebAssembly.Instance) => void) {
    const instance = new WebAssembly.Instance(webpWasm, imports); callback(instance); return instance.exports;
  } });
  await webpReady;
  for (const frame of animated ? frames : [{ bytes: data, width, height }]) {
    const result = await decodeWebP(Uint8Array.from(frame.bytes).buffer);
    check(result.width === frame.width && result.height === frame.height && result.data.length === frame.width * frame.height * 4);
  }
  return { width, height, extension: 'webp', mime: 'image/webp' };
}
export async function validateImage(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('图片不能为空，且不得超过 10 MiB。');
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (data[0] === 137 && text(data, 1, 4) === 'PNG') return png(data);
    if (text(data, 0, 3) === 'GIF') return gif(data);
    if (text(data, 0, 4) === 'RIFF') return await webp(data);
    if (data[0] === 0xff && data[1] === 0xd8) {
      // jpeg-js checks maxResolutionInMP while parsing SOF, before allocating
      // component planes or the RGBA output. The memory cap also covers its
      // internal allocations, which can exceed one RGBA canvas.
      const result = jpeg.decode(data, { useTArray: true, tolerantDecoding: false, maxResolutionInMP: MAX_CANVAS_PIXELS / 1_000_000, maxMemoryUsageInMB: 48 });
      budget(result.width, result.height, 1);
      return { width: result.width, height: result.height, extension: 'jpg', mime: 'image/jpeg' };
    }
  } catch { throw invalid(); }
  throw new Error('仅支持 PNG、JPEG、GIF、WebP 图片。');
}
