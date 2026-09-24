import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { GifReader } from 'omggif';
import { build } from 'esbuild';
const fixtures = JSON.parse(await readFile(new URL('./fixtures.json', import.meta.url)));
const token = 'local-integration-token-not-a-secret-123456789';
const root = new URL('../', import.meta.url).pathname;
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-03-26' };
let id = 0;
async function command(args, env) {
  const child = spawn(process.execPath, [wrangler, ...args], { cwd: root, env });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  const [code] = await once(child, 'exit'); assert.equal(code, 0, output); return output;
}
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const p = server.address().port; await new Promise(r => server.close(r)); return p; }

test('Cloudflare MCP integration (real workerd + persisted D1/R2)', { timeout: 150_000 }, async t => {
  const state = await mkdtemp(join(tmpdir(), 'image-library-test-'));
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(state, 'logs'), CI: 'true' };
  let child, logs = '', origin;
  const sockets = new Set();
  const source = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/slow') { res.writeHead(200); res.write(Buffer.from([137])); return; }
    if (url.pathname === '/large') { res.writeHead(200, { 'Content-Length': 10 * 1024 * 1024 + 1 }); res.end(); return; }
    if (url.pathname === '/chunked-large') { res.writeHead(200); res.end(Buffer.alloc(10 * 1024 * 1024 + 1)); return; }
    if (url.pathname.startsWith('/redirect/')) {
      const count = Number(url.pathname.split('/').at(-1));
      res.writeHead(302, { Location: count > 1 ? `/redirect/${count - 1}` : '/image' }); res.end(); return;
    }
    if (url.pathname === '/bad-redirect') { res.writeHead(302, { Location: 'file:///tmp/image.png' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(Buffer.from(fixtures[0].base64, 'base64'));
  });
  source.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  const sourceURL = `http://127.0.0.1:${source.address().port}`;
  async function stop() { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } }
  async function start(show) {
    await stop(); logs = ''; const p = await port(); origin = `http://127.0.0.1:${p}`;
    const args = ['dev', '--local', '--ip', '127.0.0.1', '--port', String(p), '--persist-to', state, '--var', `MCP_TOKEN:${token}`];
    if (show !== undefined) args.push('--var', `SHOW_IMAGE_CONTENT:${show}`);
    child = spawn(process.execPath, [wrangler, ...args], { cwd: root, env });
    child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(logs);
      try { if ((await fetch(`${origin}/health`)).ok) return; } catch {}
      await delay(100);
    }
    throw new Error(`Worker startup timed out: ${logs}`);
  }
  async function rpc(method, params = {}, extra = {}) {
    const response = await fetch(`${origin}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), ...extra });
    const body = await response.text(); assert.equal(response.status, 200, body + logs);
    let message;
    if (response.headers.get('Content-Type')?.includes('text/event-stream')) message = JSON.parse(body.split('\n').find(line => line.startsWith('data:')).slice(5));
    else message = JSON.parse(body);
    assert.ok(!message.error, JSON.stringify(message)); return message.result;
  }
  async function call(name, args = {}, error = false) {
    const result = await rpc('tools/call', { name, arguments: args });
    assert.equal(Boolean(result.isError), error, JSON.stringify(result)); return result;
  }
  try {
    await command(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], env);
    await start();
    await t.test('authentication precedence, protocol, schemas and card resource', async () => {
      assert.equal((await fetch(`${origin}/mcp`)).status, 401);
      assert.equal((await fetch(`${origin}/mcp?token=${token}`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
      assert.equal((await fetch(`${origin}/mcp?token=${token}`, { headers: { Authorization: 'Basic wrong' } })).status, 401);
      const initialize = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } });
      assert.equal(initialize.serverInfo.name, 'Image Library');
      assert.match(initialize.instructions, /已开启/);
      const tools = (await rpc('tools/list')).tools;
      assert.equal(tools.length, 6); for (const tool of tools) assert.ok(tool.outputSchema);
      assert.equal(tools.find(tool => tool.name === 'get')._meta?.ui, undefined);
      assert.equal(tools.find(tool => tool.name === 'show_image')._meta.ui.resourceUri, 'ui://image/viewer');
      const queryResponse = await fetch(`${origin}/mcp?token=${token}`, { method: 'POST', headers: { Accept: headers.Accept, 'Content-Type': headers['Content-Type'] }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/list' }) });
      assert.equal(queryResponse.status, 200); await queryResponse.arrayBuffer();
      const resources = (await rpc('resources/list')).resources; assert.deepEqual(resources.map(resource => resource.uri).sort(), ['ui://image/viewer']);
      const card = (await rpc('resources/read', { uri: 'ui://image/viewer' })).contents[0];
      assert.equal(card.text, await readFile(join(root, 'viewer.html'), 'utf8'));
      assert.deepEqual(card._meta.ui.csp.resourceDomains, [origin]);
    });
    await t.test('official SDK client negotiates legacy and modern MCP', async () => {
      for (const mode of ['legacy', { pin: '2026-07-28' }]) {
        const client = new Client({ name: 'sdk-test', version: '1' }, { versionNegotiation: { mode } });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
          assert.equal((await client.listTools()).tools.length, 6);
          const result = await client.callTool({ name: 'search', arguments: {} });
          assert.equal(result.structuredContent.text, '没有找到匹配的图片。');
        } finally { await client.close(); }
      }
    });
    await t.test('all formats and animation preserve original bytes, MIME and dimensions', async () => {
      for (const fixture of fixtures) {
        await call('add', { name: fixture.name, base64_data: `data:image/png;base64,${fixture.base64}` });
        const get = await call('get', { name: fixture.name });
        assert.equal(get.content[1].type, 'image'); assert.equal(get.content[1].data, fixture.base64); assert.equal(get.content[1].mimeType, fixture.mime);
        assert.equal(get.structuredContent.width, fixture.width); assert.equal(get.structuredContent.height, fixture.height);
        const response = await fetch(get.structuredContent.url);
        assert.equal(response.headers.get('Content-Type'), fixture.mime);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(fixture.base64, 'base64'));
        const head = await fetch(get.structuredContent.url, { method: 'HEAD' }); assert.equal(await head.text(), '');
        assert.equal(Number(head.headers.get('Content-Length')), Buffer.from(fixture.base64, 'base64').length);
        assert.equal((await fetch(get.structuredContent.url, { headers: { 'If-None-Match': head.headers.get('ETag') } })).status, 304);
        const show = await call('show_image', { name: fixture.name }); assert.equal(show.content[1].data, fixture.base64);
      }
    });
    await t.test('OR contains search, full Unicode folding, exact-name priority, paging and aliases', async () => {
      for (const [name, aliases, description] of [['Straße', ['开心', 'ＫＥＬＶＩＮ'], 'first'], ['Other', ['无语', '开心'], 'second'], ['开心', [], 'third']])
        await call('add', { name, aliases, description, base64_data: fixtures[0].base64 });
      const list = (await call('search', { query: '开心 无语' })).structuredContent.text.split('\n'); assert.equal(list.length, 3);
      assert.equal(new Set(list).size, 3);
      assert.match((await call('search', { query: 'STRASSE' })).structuredContent.text, /Straße/);
      assert.match((await call('search', { query: 'kelvin' })).structuredContent.text, /Straße/);
      await call('add', { name: 'STRASSE', base64_data: fixtures[0].base64 }, true);
      const aliases = await call('addalias', { name: 'STRASSE', aliases: ['ＫＥＬＶＩＮ', 'kelvin', 'Σ', 'ς', 'NEW'] });
      assert.equal((aliases.structuredContent.text.match(/ＫＥＬＶＩＮ/g) || []).length, 1);
      assert.match((await call('search', { query: 'new' })).structuredContent.text, /Straße/);
      await call('add', { name: 'newer 开心', base64_data: fixtures[0].base64 });
      assert.match((await call('search', { query: '开心', limit: 1 })).structuredContent.text, /^- 开心 \|/);
      assert.equal((await call('search', { query: '开心 无语', limit: 1, offset: 1 })).structuredContent.text, list[0]);
      await call('get', { name: 'NEW' }, true);
      await call('search', { limit: 0 }, true);
    });
    await t.test('199-character query with 100 keywords keeps OR results unique and globally paginated', async () => {
      const terms = Array.from({ length: 100 }, (_, index) => String.fromCharCode(0x4e00 + index));
      const query = terms.join(' ');
      assert.equal(query.length, 199);
      await call('add', { name: 'many-terms-first', aliases: [terms[0], terms[99]], base64_data: fixtures[0].base64 });
      await call('add', { name: 'many-terms-second', description: terms[50], base64_data: fixtures[0].base64 });
      const lines = (await call('search', { query })).structuredContent.text.split('\n');
      assert.equal(lines.length, 2); assert.equal(new Set(lines).size, 2);
      assert.match(lines[0], /^- many-terms-second \|/);
      assert.match(lines[1], /^- many-terms-first \|/);
      for (let offset = 0; offset < lines.length; offset++) {
        assert.equal((await call('search', { query, limit: 1, offset })).structuredContent.text, lines[offset]);
      }
      assert.equal((await call('search', { query, limit: 1, offset: 2 })).structuredContent.text, '没有找到匹配的图片。');
    });
    await t.test('URL fetch, redirects, streaming limit and total timeout', async () => {
      await call('add', { name: 'download', url: `${sourceURL}/redirect/5` });
      assert.equal((await call('get', { name: 'download' })).content[1].data, fixtures[0].base64);
      for (const path of ['/redirect/6', '/bad-redirect', '/large', '/chunked-large']) await call('add', { name: path, url: sourceURL + path }, true);
      for (const url of ['file:///tmp/x', 'ftp://example.com/x']) await call('add', { name: 'bad-url', url }, true);
      const startTime = Date.now();
      const timeout = await call('add', { name: 'slow', url: `${sourceURL}/slow` }, true);
      assert.match(timeout.content[0].text, /超时（30 秒）/);
      assert.ok(Date.now() - startTime >= 29_000 && Date.now() - startTime < 34_000);
    });
    await t.test('invalid sources, corrupt later frames, byte and request limits', async () => {
      await call('add', { name: 'empty' }, true);
      await call('add', { name: 'both', url: sourceURL, base64_data: fixtures[0].base64 }, true);
      await call('add', { name: 'bad64', base64_data: '%%%not base64' }, true);
      await call('add', { name: 'not-image', base64_data: Buffer.from('not an image').toString('base64') }, true);
      for (const fixture of fixtures) {
        const bytes = Buffer.from(fixture.base64, 'base64');
        await call('add', { name: `corrupt-${fixture.name}`, base64_data: bytes.subarray(0, Math.floor(bytes.length * 0.8)).toString('base64') }, true);
      }
      const gif = Buffer.from(fixtures.find(x => x.name === 'animated-gif').base64, 'base64');
      const secondFrame = new GifReader(gif).frameInfo(1);
      gif[secondFrame.data_offset + 2] = 0xff;
      await call('add', { name: 'corrupt-second-gif-frame', base64_data: gif.toString('base64') }, true);
      const webp = Buffer.from(fixtures.find(x => x.name === 'animated-webp').base64, 'base64');
      let frame = 0;
      for (let offset = 12; offset < webp.length;) {
        const length = webp.readUInt32LE(offset + 4);
        if (webp.toString('ascii', offset, offset + 4) === 'ANMF' && ++frame === 2) webp.fill(0, offset + 24, offset + 8 + length);
        offset += 8 + length + length % 2;
      }
      await call('add', { name: 'corrupt-second-webp-frame', base64_data: webp.toString('base64') }, true);
      await call('add', { name: 'too-large', base64_data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }, true);
      const response = await fetch(`${origin}/mcp`, { method: 'POST', headers, body: ' '.repeat(14 * 1024 * 1024) }); assert.equal(response.status, 413);
    });
    await t.test('restart retains storage; switch false suppresses images while get stays unchanged', async () => {
      await start('false');
      const show = await call('show_image', { name: 'animated-webp' }); assert.equal(show.content.length, 1);
      assert.equal(show.structuredContent.width, 13); assert.equal((await fetch(show.structuredContent.url)).status, 200);
      assert.equal((await call('get', { name: 'animated-webp' })).content[1].data, fixtures.find(x => x.name === 'animated-webp').base64);
      const tools = (await rpc('tools/list')).tools; assert.match(tools.find(x => x.name === 'show_image').description, /已关闭/);
      const get = await call('get', { name: 'Straße' });
      await call('delete', { name: 'STRASSE' }); assert.equal((await fetch(get.structuredContent.url)).status, 404);
      await call('get', { name: 'Straße' }, true);
      await start('true'); await call('get', { name: 'Straße' }, true);
      assert.equal((await call('show_image', { name: 'png' })).content.length, 2);
    });
  } finally {
    await stop(); for (const socket of sockets) socket.destroy(); await new Promise(r => source.close(r)); await rm(state, { recursive: true, force: true });
  }
});

test('viewer keeps aspect ratio, small-image size, rounded corners and reports only changed heights', async () => {
  const source = (await readFile(join(root, 'ui/viewer.js'), 'utf8')).replace(/^import .*;\n/, '');
  const image = { style: {}, removeAttribute() {} }, status = {};
  const reports = []; let app;
  let context = { containerDimensions: { maxWidth: 300, maxHeight: 300 } };
  class App { constructor(_info, _caps, options) { assert.equal(options.autoResize, false); app = this; } getHostContext() { return context; } sendSizeChanged(size) { reports.push(size); return Promise.resolve(); } connect() { return Promise.resolve(); } }
  vm.runInNewContext(source, {
    App, document: { documentElement: { clientWidth: 300 }, getElementById: id => id === 'image' ? image : id === 'status' ? status : {} },
    console, setTimeout, clearTimeout,
    getComputedStyle: () => ({ paddingLeft: '18.2px', paddingRight: '0px' }),
    window: { addEventListener() {} },
  });
  await Promise.resolve();
  app.ontoolresult({ structuredContent: { name: 'wide', url: 'https://example.com/a', width: 300, height: 100 } });
  assert.equal(image.style.maxWidth, 'min(100%, 150px)'); assert.equal(image.style.maxHeight, 'min(100%, 50px)'); assert.equal(reports.length, 1); assert.equal(reports[0].height, 50); assert.equal(reports[0].width, undefined);
  app.ontoolresult({ structuredContent: { name: 'small', url: 'https://example.com/b', width: 10, height: 7 } });
  assert.equal(image.style.maxWidth, 'min(100%, 10px)'); assert.equal(reports.length, 2);
  assert.equal(reports[1].height, 7);
  context = { containerDimensions: { height: 0 } };
  app.onhostcontextchanged(context);
  context = { containerDimensions: { maxWidth: 300, height: 7 } };
  app.onhostcontextchanged(context);
  assert.equal(reports.length, 2);
  const html = await readFile(join(root, 'viewer.html'), 'utf8'); assert.match(html, /border-radius: 8px/); assert.match(html, /padding-inline-start: 1.3em/);
});

test('disabled show_image reads metadata without R2 access or Base64 encoding', async () => {
  const bundle = await build({ entryPoints: [join(root, 'cloudflare/library.ts')], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{
    name: 'unused-image-validation', setup(build) { build.onLoad({ filter: /cloudflare\/images\.ts$/ }, () => ({ contents: 'export function validateImage() { throw new Error("unexpected image validation"); }', loader: 'js' })); },
  }] });
  const { ImageLibrary } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const row = { filename: 'test.gif', name: 'test', aliases: '[]', description: '', mime: 'image/gif', width: 13, height: 7 };
  const library = new ImageLibrary({ DB: { prepare() { return { bind() { return { async first() { return row; } }; } }; } }, IMAGES: { get() { throw new Error('R2 read'); } } }, 'https://example.com');
  const result = await library.get('test', false);
  assert.equal(result.content.length, 1); assert.equal(result.structuredContent.url, 'https://example.com/images/test.gif');
  await assert.rejects(() => library.get('test'), /R2 read/);
});
