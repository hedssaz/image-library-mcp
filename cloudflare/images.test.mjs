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
function compressedPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}

test('all existing PNG, JPEG, GIF, WebP and animation fixtures remain valid', async () => {
  for (const fixture of fixtures) {
    const result = await validateImage(Buffer.from(fixture.base64, 'base64'));
    assert.equal(result.width, fixture.width, fixture.name);
    assert.equal(result.height, fixture.height, fixture.name);
    assert.equal(result.mime, fixture.mime, fixture.name);
  }
});

test('highly compressed oversized canvases reject before pixel allocation', async () => {
  const hugePng = compressedPng(10_000, 10_000);
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
