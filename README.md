# Image Library MCP

一个轻量的图片管理 MCP 服务。支持链接下载、Base64 上传、名称/别名搜索，以及在支持 MCP Apps 的客户端中直接显示图片。图片和元数据存入 SQLite。

## Docker 部署

需要 Docker Compose，以及两个不同且指向服务器的域名（可以是两个子域名）。服务器的 TCP 80、443 端口须开放且未被其他服务占用。

1. 在项目目录创建配置并生成令牌：

   ```bash
   cp .env.example .env
   openssl rand -hex 32
   ```

2. 编辑 `.env`，替换域名并粘贴上一步生成的令牌：

   ```dotenv
   API_DOMAIN=api.example.com
   DOMAIN=images.example.com
   MCP_TOKEN=替换为生成的随机令牌
   ```

   `API_DOMAIN` 是 MCP 入口域名，`DOMAIN` 是图片域名；都不要填写 `https://` 或路径。

3. 启动服务：

   ```bash
   docker compose up -d --build
   docker compose logs --tail=50
   ```

Caddy 自动配置 HTTPS。MCP 地址为 `https://api.example.com/mcp`，图片地址为 `https://images.example.com/images/<文件名>`。

数据保存在 `image_data` 命名卷中。重建容器不会清空图片；不要在普通更新时使用 `docker compose down -v`，它会删除数据卷。

## 连接客户端

选择 **Streamable HTTP**，设置服务地址和请求头：

```text
URL: https://api.example.com/mcp
Authorization: Bearer <MCP_TOKEN>
```

也可以把令牌放进 URL：`https://api.example.com/mcp?token=<MCP_TOKEN>`。参数值不加 `Bearer `；同时提供请求头和参数时，以请求头为准。

这是共享令牌鉴权，不包含 OAuth 登录。图片链接无需鉴权，可公开访问。

## 工具

| 工具 | 用途 |
| --- | --- |
| `add(name, url 或 base64_data, aliases=[], description="")` | 添加图片；链接与 Base64 二选一 |
| `search(query="", limit=20, offset=0)` | 按名称、别名和描述搜索；空查询列出图片 |
| `get(name)` | 返回原图 ImageContent、外链及原始宽高 |
| `show_image(name)` | 在支持 MCP Apps 的客户端中显示图片 |
| `addalias(name, aliases)` | 为指定图片添加别名 |
| `delete(name)` | 删除指定图片及其别名 |

例如调用 `add`：

```json
{
  "name": "山间日出",
  "url": "https://example.com/landscape.jpg",
  "aliases": ["山景", "日出"],
  "description": "户外摄影"
}
```

搜索采用文字包含匹配，忽略大小写；空格分隔的多个词须全部命中。`limit` 为 1–100。其他工具使用准确图片名称。

支持 PNG、JPEG、GIF、WebP，保留原始文件，单图最大 10 MiB。下载仅允许公网 HTTP(S)。所有工具均声明 `outputSchema`，Base64 图片只放入 `ImageContent`。

删除后源站立即返回 404；浏览器或 CDN 已缓存的图片可能持续到缓存过期。图片响应默认缓存 24 小时，不主动清除 CDN 缓存。

## 图片显示设置

在 `ui/viewer.js` 中调整：

```javascript
const CUSTOM_SIZE = true;
const PREFERRED_IMAGE_SIZE = 200;
```

- 开启时，按期望尺寸与宿主上限等比例缩小，小图不放大，只上报一次高度，不收窄 iframe 宽度。
- 关闭时，不上报尺寸，图片默认上限为 300×300。
- 左对齐和留白在 `ui/build.mjs` 中配置，默认留白 `2.5em`。建议左对齐与 `CUSTOM_SIZE` 一起开启。

修改 UI 后，用 Node.js 20+ 重新构建，再重新部署：

```bash
npm ci
npm run build
```

已附带构建好的 `viewer.html`，直接部署不需要 Node.js。更新 UI 时同时修改 `server.py` 中的 `IMAGE_VIEWER_URI` 版本，并在客户端刷新工具，避免旧模板缓存。构建产物的第三方许可见 `THIRD_PARTY_NOTICES.txt`。

## 本地运行

需要 Python 3.10+。以下命令创建独立环境并启动服务：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
export MCP_URL=http://127.0.0.1:8000/mcp
export PUBLIC_BASE_URL=http://127.0.0.1:8000
export MCP_TOKEN=$(openssl rand -hex 32)
.venv/bin/python server.py
```

`MCP_URL` 是完整 MCP 入口，`PUBLIC_BASE_URL` 是图片域名且不含路径。令牌至少 32 位；`DATA_DIR` 默认 `./data`，`PORT` 默认 `8000`。直接运行 Python 不会自动读取 `.env`，需像上面这样传入环境变量。Compose 会自动设置这些地址。

健康检查：`http://127.0.0.1:8000/health`。生产环境应通过 HTTPS 反向代理访问，不直接暴露应用端口。

运行测试：

```bash
.venv/bin/pip install pytest==9.0.3 pytest-asyncio==1.4.0
.venv/bin/python -m pytest -q tests
```
