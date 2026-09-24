# Image Library MCP · 表情包 MCP

让 AI 在聊天中搜索、发送你自己的表情包。通过链接或 Base64 添加表情包，再用“开心”“无语”“吵架”等名字、别名或描述搜索；支持 MCP Apps 的客户端可以直接在聊天里展示选中的表情包。

表情包原图和元数据保存在 SQLite 中，每张图都有可公开访问的外链。项目不附带图库，部署后按需添加自己的表情包。

## 选择运行方式

两种方式任选其一：

- **Docker 部署**：使用项目自带的 Caddy 配置 HTTPS，适合服务器的 80、443 端口尚未被占用的情况。
- **直接运行 Python**：可仅在本机测试，也可配合已有的 Nginx 对外提供 HTTPS，适合服务器上已经部署其他项目的情况。

对外部署默认只用一个域名，例如 `example.com`：MCP 地址是 `https://example.com/mcp`，图片地址是 `https://example.com/images/<文件名>`。只需将这个域名解析到服务器，无需配置 `api`、`images` 子域名或泛域名解析。

## 方式一：Docker 部署

需要 Docker Compose，以及一个指向服务器的域名。服务器的 TCP 80、443 端口须开放且未被其他服务占用。如果端口已由 Nginx 等服务使用，请按下文“配合 Nginx 部署”接入现有服务。

1. 在项目目录创建配置并生成令牌：

   ```bash
   cp .env.example .env
   openssl rand -hex 32
   ```

2. 编辑 `.env`，替换域名并粘贴上一步生成的令牌：

   ```dotenv
   DOMAIN=example.com
   MCP_TOKEN=替换为生成的随机令牌
   ```

   `DOMAIN` 同时用于 MCP 和图片，只填写域名，不要填写 `https://` 或路径。

3. 启动服务：

   ```bash
   docker compose up -d --build
   docker compose logs --tail=50
   ```

Caddy 自动配置 HTTPS。MCP 地址为 `https://example.com/mcp`，图片地址为 `https://example.com/images/<文件名>`。

数据保存在 `image_data` 命名卷中。重建容器不会清空图片；不要在普通更新时使用 `docker compose down -v`，它会删除数据卷。

## 方式二：直接运行 Python

需要 Python 3.10+。先在项目目录创建独立环境并安装依赖：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

以下两种场景任选其一。命令均在项目目录执行，直接运行不会自动读取 `.env`。

### 1. 纯本地运行，用于测试

```bash
export MCP_URL=http://127.0.0.1:8000/mcp
export PUBLIC_BASE_URL=http://127.0.0.1:8000
export MCP_TOKEN=$(openssl rand -hex 32)
echo "$MCP_TOKEN"
.venv/bin/uvicorn server:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
```

保存输出的令牌，用于客户端鉴权。服务仅监听本机；MCP 地址为 `http://127.0.0.1:8000/mcp`，图片也通过本机地址访问。此方式用于能访问本机服务的客户端测试，远程客户端无法通过这个地址连接。

在另一个终端检查服务：

```bash
curl --fail http://127.0.0.1:8000/health
```

正常返回 `{"status":"ok"}`。停止服务时按 `Ctrl+C`。

### 2. 配合 Nginx 部署

适合服务器已有 Nginx、还运行着其他项目的情况。Python 服务仍只监听本机，由现有 Nginx 接收公网请求。需要将 `example.com` 解析到服务器，并准备好该域名的 HTTPS 证书。

先将地址替换成你的公网域名，再启动 Python 服务：

```bash
export MCP_URL=https://example.com/mcp
export PUBLIC_BASE_URL=https://example.com
export MCP_TOKEN=替换为已生成并保存的随机令牌
.venv/bin/uvicorn server:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
```

首次部署可用 `openssl rand -hex 32` 生成令牌。重启时复用同一个令牌，客户端就无需重新配置。若本机 `8000` 端口已被占用，修改启动命令的 `--port`，并同步修改下方两处 `proxy_pass` 的端口；公网 URL 不变。

下面是独立 Nginx 站点的配置示例。替换域名和证书路径后，放入现有 Nginx 的站点配置目录（例如 `/etc/nginx/conf.d/image-library.conf`，须由主配置在 `http` 块内加载）：

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    ssl_certificate /path/to/example.com/fullchain.pem;
    ssl_certificate_key /path/to/example.com/privkey.pem;

    location = /mcp {
        client_max_body_size 15m;
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        add_header Cache-Control "no-store" always;
    }

    location ^~ /images/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
    }

    location / {
        return 404;
    }
}
```

如果该域名已经有 HTTPS 站点，**只把 `/mcp` 和 `/images/` 两个 `location` 块合并进现有的 `server` 块**，保留原有证书及其他路由，不要重复创建相同域名的站点。这两个路径需留给本项目使用。

`/mcp` 关闭代理缓冲和缓存，并将请求体上限设为 15 MiB，以容纳 Base64 上传后的请求。相关指令见 [Nginx 代理模块文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)和[请求体大小配置](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)。

在另一个终端检查配置，通过后重载现有 Nginx：

```bash
sudo nginx -t && sudo nginx -s reload
```

本机健康检查仍为 `http://127.0.0.1:8000/health`，公网客户端使用 `https://example.com/mcp`。无需向公网开放 Python 服务端口，也无需启动 Docker Compose 中的 Caddy。上面的 Python 命令以前台运行；长期部署时，可交给现有的 systemd 等进程管理器，并设置相同的项目工作目录和环境变量。

两种直接运行场景中，`MCP_URL` 都是客户端使用的完整 MCP 入口，`PUBLIC_BASE_URL` 是客户端可访问的图片站点地址，不含路径；`MCP_TOKEN` 至少 32 位。数据默认保存在项目目录的 `./data`，可通过 `DATA_DIR` 指定其他目录。

## 连接客户端

选择 **Streamable HTTP**，设置服务地址和请求头：

```text
URL: https://example.com/mcp
Authorization: Bearer <MCP_TOKEN>
```

本地测试时将 URL 换成 `http://127.0.0.1:8000/mcp`。

也可以把令牌放进 URL：`https://example.com/mcp?token=<MCP_TOKEN>`。参数值不加 `Bearer `；同时提供请求头和参数时，以请求头为准。

**优先使用请求头传递令牌；如果使用 URL 参数方式，请关闭 `/mcp` 路由的 `access_log`，避免令牌写入访问日志。**

这是共享令牌鉴权，不包含 OAuth 登录。图片链接无需鉴权，可公开访问。

## 工具

| 工具 | 用途 |
| --- | --- |
| `add(name, url 或 base64_data, aliases=[], description="")` | 添加表情包；链接与 Base64 二选一 |
| `search(query="", limit=20, offset=0)` | 按名称、别名和描述搜索表情包；空查询列出表情包 |
| `get(name)` | 返回原图 ImageContent、外链及原始宽高，不挂载卡片 |
| `show_image(name)` | 用 MCP App 展示表情包，同时返回原图 ImageContent 供模型读取 |
| `addalias(name, aliases)` | 为指定表情包添加别名，如“开心”“无语” |
| `delete(name)` | 删除指定表情包及其别名 |

例如调用 `add` 添加一张表情包（将示例链接替换为实际图片链接）：

```json
{
  "name": "开心大笑",
  "url": "https://example.com/happy.webp",
  "aliases": ["开心", "哈哈", "笑死"],
  "description": "表达开心、觉得好笑时使用"
}
```

添加后，可以在连接了这个 MCP 的客户端中说：“给我发一张开心的表情包。”工具流程是 `search(query="开心")` → `show_image(name="开心大笑")`。同一次展示调用同时返回图片内容，模型无需再调用 `get`。仅需读取原图和外链、不展示卡片时，使用 `get(name="开心大笑")`。

搜索采用文字包含匹配，忽略大小写；空格分隔的多个词须全部命中。`limit` 为 1–100。其他工具使用准确图片名称。

支持 PNG、JPEG、GIF、WebP，保留原始文件，单图最大 10 MiB。所有工具均声明 `outputSchema`，Base64 图片只放入 `ImageContent`。

删除后源站立即返回 404；浏览器或 CDN 已缓存的图片可能持续到缓存过期。图片响应默认缓存 24 小时，不主动清除 CDN 缓存。

## 表情包显示设置

在 `ui/viewer.js` 中调整：

```javascript
const CUSTOM_SIZE = true;
const PREFERRED_IMAGE_SIZE = 150;
```

- 开启时，按期望尺寸与宿主上限等比例缩小，小图不放大，只上报一次高度，不收窄 iframe 宽度。
- 关闭时，不上报尺寸，图片默认上限为 300×300。

表情包默认使用 `8px` 圆角。在 `ui/build.mjs` 中修改 `img` 的 `border-radius` 即可调整，设为 `0` 恢复直角。圆角仅影响卡片中的显示，不修改原图文件或外链。

图片通过最大宽高限制尺寸，元素本身保持原图比例；宿主空间变窄或变矮时，四个圆角仍贴合实际图片边缘。

### 对齐方式与水平偏移

在 `ui/build.mjs` 的 CSS 中修改 `#app` 和 `img` 的对应属性，保留其他样式。例如，左对齐并向右留出 16 像素：

```css
#app {
  justify-content: flex-start;
  padding-inline-start: 16px;
}
img {
  object-position: left center;
}
```

`padding-inline-start` 控制图片与卡片内部左边缘的距离：`0px` 不额外缩进，`8px` 向右留 8 像素，`16px` 留 16 像素。数值越大，图片越靠右。这里的 `px` 是 CSS 像素，手机截图中的物理像素数可能不同。

当前默认值是 `1.3em`，按默认字号 14px 计算约为 18.2px；想精确调整距离，直接改成 `px`。请以客户端正文的实际左缘为准微调；`0px` 仅表示不额外缩进，不保证与宿主正文对齐。

| 对齐方式 | `#app` 的 `justify-content` | `img` 的 `object-position` |
| --- | --- | --- |
| 左对齐 | `flex-start` | `left center` |
| 居中 | `center` | `center center` |
| 右对齐 | `flex-end` | `right center` |

切换居中或右对齐时，先把 `padding-inline-start` 设为 `0px`。右对齐后若要与右边缘留出距离，可加 `padding-inline-end: 16px`。

对齐和偏移不依赖 `CUSTOM_SIZE`，但建议左对齐时一起开启，让卡片高度随图片收紧。偏移只调整留白，不修改期望图片尺寸，也不会增加尺寸回传次数。

### 让修改生效

修改 UI 后，用 Node.js 20+ 重新构建，再重新部署：

```bash
npm ci
npm run build
```

`viewer.html` 是自动生成的压缩产物，请修改 `ui/viewer.js` 或 `ui/build.mjs`，不要直接编辑它。已附带构建好的版本，直接部署不需要 Node.js。更新 UI 时同时修改 `server.py` 中的 `IMAGE_VIEWER_URI` 版本，并在客户端刷新工具，避免旧模板缓存。构建产物的第三方许可见 `THIRD_PARTY_NOTICES.txt`。

## 运行测试

完成“直接运行 Python”中的环境准备后，执行：

```bash
.venv/bin/pip install pytest==9.0.3 pytest-asyncio==1.4.0
.venv/bin/python -m pytest -q tests
```

## 许可证

本项目代码采用 [MIT 许可证](LICENSE)。第三方依赖及构建产物中的第三方代码遵循各自的许可证，详见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。

## 安全提醒

当前没有 SSRF 防护，URL 下载可能访问服务器本机或内网资源。建议仅自用或供受信任的用户使用，不要作为面向公众的服务开放；令牌鉴权不能代替 SSRF 防护。
