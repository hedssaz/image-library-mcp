import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import viewer from '../viewer.html';
import { ImageLibrary, MAX_REQUEST_BYTES, readLimited, downloadImage, decodeImage, type Env } from './library';

const VIEWER_URI = 'ui://image/viewer-v5';
const name = z.string().min(1).max(80);
const aliases = z.array(z.string().min(1).max(40)).max(32);
const textOutput = z.object({ text: z.string() });
const imageOutput = z.object({ name: z.string(), url: z.string(), width: z.number().int().positive(), height: z.number().int().positive() });
const readOnly = { readOnlyHint: true, openWorldHint: false };

function createServer(env: Env, origin: string) {
  const includeImage = (env.SHOW_IMAGE_CONTENT ?? 'true').trim().toLowerCase() === 'true';
  const note = includeImage ? '当前已开启原图返回：同时提供 ImageContent（Base64、真实 MIME），无需另调 get。'
    : '当前已关闭原图返回：仅返回文字和卡片数据，需要读取原图时调用 get。';
  const server = new McpServer({ name: 'Image Library', version: '1.0.0' }, {
    instructions: '先 search 搜索图片列表；要在聊天里显示或发送图片，调用 show_image(准确图片名字)，由 MCP App 内联显示图片，无需另写 Markdown 图片。' + note +
      'get 始终提供原图 ImageContent 和外链，不挂载卡片。添加时 URL 与 Base64 二选一。别名和删除使用准确图片名字。',
  });
  const library = new ImageLibrary(env, origin);
  const ui = { csp: { resourceDomains: [origin] }, prefersBorder: false };
  server.registerResource('image_viewer', VIEWER_URI, {
    title: '图片', description: '在聊天中显示 show_image 返回的图片。', mimeType: 'text/html;profile=mcp-app', _meta: { ui },
  }, async () => ({ contents: [{ uri: VIEWER_URI, mimeType: 'text/html;profile=mcp-app', text: viewer, _meta: { ui } }] }));
  server.registerTool('search', {
    description: '搜索库内图片的名字、别名和描述；忽略大小写，空格分隔的多个词命中任意一个即可，合并去重，准确名字优先。空 query 列出最新图片；用 limit/offset 翻页。展示或发送图片时，用结果的准确名字调用 show_image(name)。',
    inputSchema: z.object({ query: z.string().max(200).default(''), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0) }),
    outputSchema: textOutput, annotations: readOnly,
  }, ({ query, limit, offset }) => library.search(query, limit, offset));
  server.registerTool('get', {
    description: '按准确图片名字获取原图 ImageContent（Base64、真实 MIME）、外链和原始宽高，不挂载卡片，不按别名或模糊关键词选择。',
    inputSchema: z.object({ name }), outputSchema: imageOutput, annotations: readOnly,
  }, ({ name }) => library.get(name));
  server.registerTool('show_image', {
    title: '显示图片', description: '在聊天中展示或发送表情包。name 使用 search 返回的准确名字；由 MCP App 直接显示图片。返回名字、外链和原始 width/height，UI 等比例缩小、不放大小图。' + note,
    inputSchema: z.object({ name }), outputSchema: imageOutput, annotations: readOnly, _meta: { ui: { resourceUri: VIEWER_URI } },
  }, ({ name }) => library.get(name, includeImage));
  server.registerTool('add', {
    description: '添加图片：url（由服务端下载）和 base64_data（纯 Base64 或 data URL）必须且只能提供一个。名字须唯一；支持 PNG/JPEG/GIF/WebP，保留动图，最大 10 MiB；返回名字、别名/描述和公网链接。',
    inputSchema: z.object({ name, url: z.string().max(8192).nullable().optional(), base64_data: z.string().nullable().optional(), aliases: aliases.nullable().optional(), description: z.string().max(500).default('') }),
    outputSchema: textOutput, annotations: { destructiveHint: false, openWorldHint: true },
  }, async ({ name, url, base64_data, aliases, description }) => {
    if ((url == null) === (base64_data == null)) throw new Error('url 和 base64_data 必须且只能提供一个。');
    return library.add(name, aliases ?? [], description, url != null ? await downloadImage(url) : decodeImage(base64_data!));
  });
  server.registerTool('addalias', {
    description: '为准确图片名字添加一个或多个别名，重复别名自动去重；返回更新后的名字、别名/描述和公网链接。',
    inputSchema: z.object({ name, aliases: aliases.min(1) }), outputSchema: textOutput,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ name, aliases }) => library.addalias(name, aliases));
  server.registerTool('delete', {
    description: '永久删除准确图片名字对应的图片和全部别名，源站返回 404，缓存副本到期后失效。仅在用户明确要求删除这张图片时调用；不能用模糊关键词或别名删除。',
    inputSchema: z.object({ name }), outputSchema: textOutput, annotations: { destructiveHint: true, openWorldHint: false },
  }, ({ name }) => library.delete(name));
  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ status: 'ok' });
    if (url.pathname.startsWith('/images/') && ['GET', 'HEAD'].includes(request.method)) {
      const filename = url.pathname.slice('/images/'.length);
      const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      const row = await env.DB.prepare('SELECT mime FROM images WHERE filename = ?').bind(filename).first<{ mime: string }>();
      if (!row) return new Response(null, { status: 404, headers });
      const object = request.method === 'HEAD' ? await env.IMAGES.head(filename) : await env.IMAGES.get(filename);
      if (!object) return new Response(null, { status: 404, headers });
      headers.set('Cache-Control', 'public, max-age=86400'); headers.set('ETag', `"${filename}"`);
      if (request.headers.get('If-None-Match') === headers.get('ETag')) return new Response(null, { status: 304, headers });
      headers.set('Content-Type', row.mime); headers.set('Content-Length', String(object.size));
      return new Response('body' in object ? (object as R2ObjectBody).body : null, { headers });
    }
    if (url.pathname.replace(/\/+$/, '') !== '/mcp') return new Response(null, { status: 404 });
    if (!env.MCP_TOKEN || env.MCP_TOKEN.length < 32 || /[^\x21-\x7e]/.test(env.MCP_TOKEN)) {
      return Response.json({ error: '请设置至少 32 位、不含空白的 ASCII MCP_TOKEN secret。' }, { status: 503 });
    }
    const authorization = request.headers.get('Authorization');
    const token = authorization !== null ? (/^Bearer (.*)$/i.exec(authorization)?.[1] ?? '') : (url.searchParams.get('token') ?? '');
    const supplied = Buffer.from(token), expected = Buffer.from(env.MCP_TOKEN);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return Response.json({ error: '需要有效的 Bearer token。' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    }
    // Keep a single size boundary ahead of the SDK JSON parser, including chunked bodies.
    if (request.body) {
      let bytes: Uint8Array;
      try { bytes = await readLimited(request.body, MAX_REQUEST_BYTES); }
      catch { return Response.json({ error: '请求过大。' }, { status: 413 }); }
      request = new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
    }
    const response = await createMcpHandler(() => createServer(env, url.origin), { route: url.pathname })(request, env, ctx);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  },
} satisfies ExportedHandler<Env>;
