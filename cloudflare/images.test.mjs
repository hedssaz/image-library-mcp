import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { build } from 'esbuild';

const fixtures = JSON.parse(await readFile(new URL('./fixtures.json', import.meta.url)));
// Wrangler imports WASM as a compiled module. Mirror that in this Node test.
const directory = await mkdtemp(join(tmpdir(), 'image-validation-'));
let validateImage;
try {
  const bundle = await build({ entryPoints: [new URL('./images.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{
    name: 'compiled-wasm', setup(builder) {
      builder.onLoad({ filter: /\.wasm$/ }, async ({ path }) => ({
        contents: `export default new WebAssembly.Module(Uint8Array.from(Buffer.from('${(await readFile(path)).toString('base64')}', 'base64')));`, loader: 'js',
      }));
    },
  }] });
  const path = join(directory, 'images.mjs');
  await writeFile(path, bundle.outputFiles[0].contents);
  ({ validateImage } = await import(pathToFileURL(path)));
} finally { await rm(directory, { recursive: true, force: true }); }

function chunk(type, payload) {
  const bytes = Buffer.alloc(payload.length + 12);
  bytes.writeUInt32BE(payload.length); bytes.write(type, 4); payload.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4);
  return bytes;
}
function compressedPng(width, height, inflatedSize = (width + 1) * height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(inflatedSize))), chunk('IEND', Buffer.alloc(0))]);
}

function rewriteChunks(bytes, rewrite) {
  const chunks = [bytes.subarray(0, 8)];
  for (let offset = 8; offset < bytes.length;) {
    const end = offset + bytes.readUInt32BE(offset) + 12;
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    chunks.push(...rewrite(type, bytes.subarray(offset + 8, end - 4)));
    offset = end;
  }
  return Buffer.concat(chunks);
}

test('tiny PNG canvases reject excess inflated data, including split IDAT and APNG fdAT', async () => {
  for (const size of [3, 64 * 1024]) {
    const png = compressedPng(1, 1, size); // a valid 1x1 grayscale image needs exactly two bytes
    assert.ok(png.length < 64 * 1024);
    await assert.rejects(validateImage(png), /无法读取图片/);
    const split = rewriteChunks(png, (type, payload) => type === 'IDAT'
      ? [chunk(type, payload.subarray(0, 5)), chunk(type, payload.subarray(5))] : [chunk(type, payload)]);
    await assert.rejects(validateImage(split), /无法读取图片/);
  }
  const apng = Buffer.from(fixtures.find(x => x.name === 'apng').base64, 'base64');
  const oversizedFrame = rewriteChunks(apng, (type, payload) => [chunk(type, type === 'fdAT'
    ? Buffer.concat([payload.subarray(0, 4), deflateSync(Buffer.alloc(64 * 1024))]) : payload)]);
  await assert.rejects(validateImage(oversizedFrame), /无法读取图片/);
  assert.equal((await validateImage(compressedPng(1, 1))).width, 1);
});

test('PNG bounds retain packed, 16-bit, Adam7 and separate-default APNG images', async () => {
  // Exact scanline sizes for 9x5 images, including filter bytes and row padding.
  for (const [depth, color, interlace, size] of [[1, 0, 0, 15], [4, 3, 0, 30], [16, 2, 0, 275],
    [16, 4, 0, 185], [16, 6, 0, 365], [8, 2, 1, 146], [16, 6, 1, 371]]) {
    const png = rewriteChunks(compressedPng(9, 5, size), (type, payload) => {
      if (type !== 'IHDR') return [chunk(type, payload)];
      const header = Buffer.from(payload); header[8] = depth; header[9] = color; header[12] = interlace;
      return [chunk(type, header), ...(color === 3 ? [chunk('PLTE', Buffer.alloc(48))] : [])];
    });
    assert.equal((await validateImage(png)).width, 9, `${depth}/${color}/${interlace}`);
  }
  const apng = Buffer.from(fixtures.find(x => x.name === 'apng').base64, 'base64');
  const separate = rewriteChunks(apng, (type, payload) => {
    const copy = Buffer.from(payload);
    if (type === 'acTL') copy.writeUInt32BE(1);
    if (type === 'fcTL' && copy.readUInt32BE(0) === 0) return [];
    if (type === 'fcTL' || type === 'fdAT') copy.writeUInt32BE(copy.readUInt32BE(0) - 1);
    return [chunk(type, copy)];
  });
  assert.equal((await validateImage(separate)).width, 13);
});

test('PNG validation ignores compressed metadata and rejects header/stream bypasses', async () => {
  const png = compressedPng(1, 1);
  const profile = Buffer.concat([Buffer.from('profile\0\0'), deflateSync(Buffer.alloc(64 * 1024))]);
  const withProfile = rewriteChunks(png, (type, payload) => [chunk(type, payload), ...(type === 'IHDR' ? [chunk('iCCP', profile)] : [])]);
  assert.equal((await validateImage(withProfile)).width, 1);
  const withUnknown = (name) => rewriteChunks(png, (type, payload) =>
    [chunk(type, payload), ...(type === 'IHDR' ? [chunk(name, Buffer.from([1]))] : [])]);
  await assert.rejects(validateImage(withUnknown('ABCD')), /无法读取图片/);
  assert.equal((await validateImage(withUnknown('abCd'))).width, 1); // ancillary chunks may be ignored
  const duplicate = rewriteChunks(png, (type, payload) => [chunk(type, payload), ...(type === 'IHDR' ? [chunk(type, payload)] : [])]);
  await assert.rejects(validateImage(duplicate), /无法读取图片/);
  const trailing = rewriteChunks(png, (type, payload) => [chunk(type, type === 'IDAT'
    ? Buffer.concat([payload, deflateSync(Buffer.alloc(1024))]) : payload)]);
  await assert.rejects(validateImage(trailing), /无法读取图片/);
  await assert.rejects(validateImage(compressedPng(1, 1, 1)), /无法读取图片/);
});

test('PNG palette and transparency chunks are unique and bounded', async () => {
  const indexed = rewriteChunks(compressedPng(1, 1), (type, payload) => {
    if (type !== 'IHDR') return [chunk(type, payload)];
    const header = Buffer.from(payload); header[9] = 3;
    return [chunk(type, header), chunk('PLTE', Buffer.alloc(6)), chunk('tRNS', Buffer.from([0, 255]))];
  });
  assert.equal((await validateImage(indexed)).width, 1);
  for (const repeated of ['PLTE', 'tRNS']) {
    const duplicate = rewriteChunks(indexed, (type, payload) => type === repeated
      ? [chunk(type, payload), chunk(type, payload)] : [chunk(type, payload)]);
    await assert.rejects(validateImage(duplicate), /无法读取图片/);
  }
  const tooManyAlphaValues = rewriteChunks(indexed, (type, payload) => [chunk(type,
    type === 'tRNS' ? Buffer.alloc(3) : payload)]);
  await assert.rejects(validateImage(tooManyAlphaValues), /无法读取图片/);
});

test('all existing PNG, JPEG, GIF, WebP and animation fixtures remain valid', async () => {
  for (const fixture of fixtures) {
    const result = await validateImage(Buffer.from(fixture.base64, 'base64'));
    assert.equal(result.width, fixture.width, fixture.name);
    assert.equal(result.height, fixture.height, fixture.name);
    assert.equal(result.mime, fixture.mime, fixture.name);
  }
});

test('highly compressed oversized canvases reject before pixel allocation', async () => {
  const hugePng = compressedPng(10_000, 10_000, 2); // oversized IHDR alone must reject
  assert.ok(hugePng.length < 1024 * 1024);
  const jpeg = Buffer.from(fixtures.find(x => x.name === 'jpeg').base64, 'base64');
  let sof = false;
  for (let offset = 0; offset < jpeg.length - 9; offset++) {
    if (jpeg[offset] === 0xff && [0xc0, 0xc1, 0xc2].includes(jpeg[offset + 1])) {
      jpeg.writeUInt16BE(10_000, offset + 5); jpeg.writeUInt16BE(10_000, offset + 7); sof = true; break;
    }
  }
  assert.ok(sof);
  const gif = Buffer.from(fixtures.find(x => x.name === 'animated-gif').base64, 'base64');
  gif.writeUInt16LE(10_000, 6); gif.writeUInt16LE(10_000, 8);
  const webp = Buffer.from(fixtures.find(x => x.name === 'animated-webp').base64, 'base64');
  assert.equal(webp.toString('ascii', 12, 16), 'VP8X');
  webp.writeUIntLE(9_999, 24, 3); webp.writeUIntLE(9_999, 27, 3);
  for (const bytes of [hugePng, jpeg, gif, webp]) {
    await assert.rejects(validateImage(bytes), /尺寸过大/);
  }
  assert.equal((await validateImage(compressedPng(1024, 1024))).width, 1024);
});

test('WebP bitstream dimensions cannot bypass the VP8X canvas limit', async () => {
  const webp = Buffer.from(fixtures.find(x => x.name === 'animated-webp').base64, 'base64');
  // The outer canvas stays small; the nested lossless frame advertises 100 MP.
  const frame = webp.indexOf('VP8L');
  assert.ok(frame > 0);
  webp.writeUInt32LE(((9_999 & 0x3fff) | ((9_999 & 0x3fff) << 14)) >>> 0, frame + 9);
  await assert.rejects(validateImage(webp), /尺寸过大/);
});
