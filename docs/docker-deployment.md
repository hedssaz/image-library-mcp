# Docker 部署

[返回 README](../README.md) · [连接与使用](usage.md)

适合有服务器的人。Docker 负责运行程序，项目自带的 Caddy 会配置 HTTPS。

## 1. 准备

- 服务器装好 Git、Docker 和 Docker Compose。
- 有一个域名，例如 `example.com`，已经解析到服务器的公网 IP。
- 服务器允许访问 TCP 80、443 端口，而且这两个端口没有被其他程序占用。

如果已经有 Nginx 占用了端口，直接看 [Python 指南里的 Nginx 方式](python-deployment.md)，或把你的现有配置交给 AI 处理。

不确定有没有装好？在服务器终端执行：

```bash
git --version
docker --version
docker compose version
```

能显示版本号就可以。缺少哪个，把提示发给 AI，让它按服务器系统安装。

## 2. 下载项目

```bash
git clone https://github.com/hedssaz/image-library-mcp.git
cd image-library-mcp
cp .env.example .env
```

后面的命令都在这个项目目录执行。已有项目就进入原目录，不要重新覆盖自己的 `.env`。

## 3. 填两个值

用文本编辑器打开 `.env`，例如运行 `nano .env`，把内容改成：

```dotenv
DOMAIN=example.com
MCP_TOKEN=my-cat-2026
SHOW_IMAGE_CONTENT=true
```

- `DOMAIN`：换成你的域名，只填域名，不加 `https://` 或 `/mcp`。
- `MCP_TOKEN`：自己填一个熟悉的 key。英文、数字、英文符号都可以，不要留空或含空格、中文。不需要 OpenSSL，也不要求 32 位。
- `SHOW_IMAGE_CONTENT`：先保持 `true` 就行。

用 nano 时，按 `Ctrl+O`、回车保存，再按 `Ctrl+X` 退出。

## 4. 启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=50
```

等服务启动、Caddy 配好 HTTPS。看到报错就把日志发给 AI。

连接地址是 `https://你的域名/mcp`，key 就是刚才填的值。接着看[连接与使用](usage.md)，添加并展示一张测试图片。

## 停止、更新和数据

临时停止：

```bash
docker compose stop
```

再次启动：

```bash
docker compose up -d
```

更新项目：

```bash
git pull
docker compose up -d --build
```

自己改过代码时，先让 AI 检查再更新。图片存在 Docker 的 `image_data` 数据卷里，正常重建容器不会清空。

**普通更新不要加 `-v` 运行 `docker compose down`，那会删除数据卷和图片。**
