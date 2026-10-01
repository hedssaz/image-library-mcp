# 在电脑上运行 Python

[返回 README](../README.md) · [连接与使用](usage.md)

适合先在本机试用，或交给 AI 接入已有服务器。下面的命令用于 macOS / Linux；Windows 用户可以把本文交给 AI，让它换成 PowerShell 命令。

## 1. 准备项目

需要 Git 和 Python 3.10+。在终端执行：

```bash
git clone https://github.com/hedssaz/image-library-mcp.git
cd image-library-mcp
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

后面的命令都在这个项目目录执行。已有项目就直接进入目录，不需要重复下载。

## 2. 启动

把 `my-cat-2026` 换成自己好记的 key。英文、数字、英文符号都可以，不要留空或含空格、中文；不要求 32 位，也不需要运行生成命令。

```bash
export MCP_URL=http://127.0.0.1:8000/mcp
export PUBLIC_BASE_URL=http://127.0.0.1:8000
export MCP_TOKEN='my-cat-2026'
.venv/bin/uvicorn server:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
```

看到服务启动后，让这个终端保持打开。停止时按 `Ctrl+C`。直接运行 Python 不会自动读取 `.env`；重新打开终端后，需要重新设置上面的变量。

## 3. 检查并连接

在另一个终端执行：

```bash
curl --fail http://127.0.0.1:8000/health
```

返回 `{"status":"ok"}` 表示服务已经启动。再按[连接与使用](usage.md)添加 MCP，地址填 `http://127.0.0.1:8000/mcp`，key 填刚才设置的值。

**这个地址只适用于能访问你这台电脑本地服务的客户端。** 云端 AI 不能靠 `127.0.0.1` 连到你的电脑。要让云端客户端连接，直接选 [Cloudflare](cloudflare-deployment.md)，或让 AI 帮你按下方说明配置服务器。

## 数据和更新

图片与名字默认一起保存在项目目录的 `data/images.sqlite3`。重启时使用相同的项目目录；也可以用 `DATA_DIR` 指定固定目录。备份时先停止服务，再复制整个 `data` 文件夹。

更新时先按 `Ctrl+C` 停止服务，再执行：

```bash
git pull
.venv/bin/pip install -r requirements.txt
```

然后重新执行启动命令，沿用原来的 key 和数据目录。自己改过代码时，先让 AI 检查再更新。

<details>
<summary>已有服务器和 Nginx？展开这部分，或交给 AI 操作</summary>


适合服务器已有 Nginx、还运行着其他项目的情况。Python 服务仍只监听本机，由现有 Nginx 接收公网请求。需要将 `example.com` 解析到服务器，并准备好该域名的 HTTPS 证书。

先将地址替换成你的公网域名，再启动 Python 服务：

```bash
export MCP_URL=https://example.com/mcp
export PUBLIC_BASE_URL=https://example.com
export MCP_TOKEN='my-cat-2026'
.venv/bin/uvicorn server:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
```

key 可以自己填写，例如 `my-cat-2026`。重启时复用同一个令牌，客户端就无需重新配置。若本机 `8000` 端口已被占用，修改启动命令的 `--port`，并同步修改下方两处 `proxy_pass` 的端口；公网 URL 不变。

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


</details>

服务器上的进程管理器也要填写相同的环境变量和工作目录。`MCP_URL` 是客户端使用的完整 MCP 地址；`PUBLIC_BASE_URL` 是图片站点地址，不含 `/mcp` 等路径。
