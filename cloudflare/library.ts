import { caseFold } from 'unicode-case-folding';
import { validateImage } from './images';

export interface Env { DB: D1Database; IMAGES: R2Bucket; MCP_TOKEN: string; SHOW_IMAGE_CONTENT?: string }
interface Row { filename: string; name: string; name_fold: string; aliases: string; description: string; mime: string; width: number; height: number }
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 64 * 1024;
const whitespace = /[\p{White_Space}\u001c-\u001f]+/u;
export const clean = (value: string) => value.split(whitespace).filter(Boolean).join(' ');
export const fold = (value: string) => caseFold(value.normalize('NFKC'));
export const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }], structuredContent: { text } });
function aliasesUnique(values: string[]) {
  const labels = new Map<string, string>();
  for (const value of values) {
    const label = clean(value);
    if (!label) throw new Error('别名不能是空白。');
    if (!labels.has(fold(label))) labels.set(fold(label), label);
  }
  if (labels.size > 32) throw new Error('每张图片最多 32 个别名。');
  return [...labels.values()];
}
const searchText = (name: string, aliases: string, description: string) => fold(`${name} ${aliases} ${description}`);

export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('请求或图片数据过大。');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export function decodeImage(value: string) {
  if (value.length > MAX_REQUEST_BYTES) throw new Error('Base64 数据过大。');
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    if (comma < 0 || !/^data:image\/.*;base64$/.test(value.slice(0, comma))) throw new Error('请提供图片的 Base64 data URL。');
    value = value.slice(comma + 1);
  }
  value = value.split(whitespace).join('');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Base64 格式无效。');
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
function downloadURL(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('图片链接必须是 HTTP(S) URL。');
  return url;
}
export async function downloadImage(value: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    let url = downloadURL(value);
    for (let redirect = 0; redirect <= 5; redirect++) {
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': 'image-mcp/1.0', Accept: 'image/*' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('Location');
        if (!location || redirect === 5) throw new Error('图片链接重定向无效或超过 5 次。');
        url = downloadURL(new URL(location, url).href);
        continue;
      }
      if (response.status !== 200 || Number(response.headers.get('Content-Length')) > MAX_IMAGE_BYTES) {
        await response.body?.cancel();
        throw new Error(`图片下载失败（HTTP ${response.status}）或超过 10 MiB。`);
      }
      return await readLimited(response.body, MAX_IMAGE_BYTES);
    }
    throw new Error('图片链接重定向无效。');
  } catch (error) {
    if (controller.signal.aborted) throw new Error('图片下载超时（30 秒）。');
    throw error;
  } finally { clearTimeout(timer); }
}

export class ImageLibrary {
  constructor(private env: Env, private origin: string) {}
  line(row: Row) {
    const labels: string[] = JSON.parse(row.aliases);
    if (row.description) labels.push(row.description);
    return `- ${row.name.replaceAll('|', '\\|')} | ${(labels.join(' / ') || '无别名/描述').replaceAll('|', '\\|')} | ${this.origin}/images/${row.filename}`;
  }
  async byName(name: string) {
    const row = await this.env.DB.prepare('SELECT * FROM images WHERE name_fold = ?').bind(fold(clean(name))).first<Row>();
    if (!row) throw new Error('图片不存在，请先 search 查询准确的图片名字。');
    return row;
  }
  async search(query: string, limit: number, offset: number) {
    const terms = clean(fold(query)).split(' ').filter(Boolean);
    const where = terms.length ? terms.map(() => 'instr(search_fold, ?) > 0').join(' OR ') : '1';
    const { results } = await this.env.DB.prepare(`SELECT * FROM images WHERE ${where} ORDER BY (name_fold = ?) DESC, rowid DESC LIMIT ? OFFSET ?`)
      .bind(...terms, fold(clean(query)), limit, offset).all<Row>();
    return textResult(results.length ? results.map(row => this.line(row)).join('\n') : '没有找到匹配的图片。');
  }
  async add(name: string, aliases: string[], description: string, data: Uint8Array) {
    name = clean(name); description = clean(description);
    if (!name) throw new Error('图片名字不能为空白。');
    const labels = JSON.stringify(aliasesUnique(aliases));
    const info = await validateImage(data);
    const filename = `${crypto.randomUUID().replaceAll('-', '')}.${info.extension}`;
    const row = { filename, name, name_fold: fold(name), aliases: labels, description, ...info };
    await this.env.IMAGES.put(filename, data, { httpMetadata: { contentType: info.mime } });
    try {
      await this.env.DB.prepare('INSERT INTO images (filename,name,name_fold,aliases,description,search_fold,mime,width,height) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(filename, name, fold(name), labels, description, searchText(name, labels, description), info.mime, info.width, info.height).run();
    } catch (error) {
      await this.env.IMAGES.delete(filename);
      if (String(error).includes('UNIQUE constraint')) throw new Error('图片名字已存在，请换一个名字，或使用 addalias 添加别名。');
      throw error;
    }
    return textResult(this.line(row));
  }
  async addalias(name: string, aliases: string[]) {
    const row = await this.byName(name);
    const labels = JSON.stringify(aliasesUnique([...JSON.parse(row.aliases), ...aliases]));
    // Compare-and-set prevents concurrent alias additions from silently overwriting one another.
    const result = await this.env.DB.prepare('UPDATE images SET aliases = ?, search_fold = ? WHERE filename = ? AND aliases = ?')
      .bind(labels, searchText(row.name, labels, row.description), row.filename, row.aliases).run();
    if (!result.meta.changes) throw new Error('图片已被修改或删除，请重新查询后重试。');
    return textResult(this.line({ ...row, aliases: labels }));
  }
  async delete(name: string) {
    const row = await this.byName(name);
    await this.env.DB.prepare('DELETE FROM images WHERE filename = ?').bind(row.filename).run();
    // Public reads also check D1, so the source becomes unavailable immediately.
    await this.env.IMAGES.delete(row.filename);
    return textResult(`已删除：${row.name}。源站图片及其别名已移除；已缓存的图片将在缓存到期后失效。`);
  }
  async get(name: string, includeImage = true) {
    const row = await this.byName(name);
    const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [{ type: 'text', text: this.line(row) }];
    if (includeImage) {
      const object = await this.env.IMAGES.get(row.filename);
      if (!object) throw new Error('原图不存在。');
      const { Buffer } = await import('node:buffer');
      content.push({ type: 'image', mimeType: row.mime, data: Buffer.from(await object.arrayBuffer()).toString('base64') });
    }
    return { content, structuredContent: { name: row.name, url: `${this.origin}/images/${row.filename}`, width: row.width, height: row.height } };
  }
}
