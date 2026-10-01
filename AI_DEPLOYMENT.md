# 给部署助手看的说明

这是给 AI 的操作说明。用户可能完全不会编程，目标是让他尽快用上自己的表情包 MCP。

先读 [README](README.md)，再根据实际环境读对应部署文档。不要要求用户学习所有技术名词，也不要把所有部署方式同时甩给他。

## 先判断部署在哪里

- 复用对话里已经提供的环境、账号和偏好，不要反复问。
- 没有服务器：优先考虑 [Cloudflare](docs/cloudflare-deployment.md)，但当前实现需要 R2，开通可能要求付款资料。用户没有可用付款方式时，不要承诺这条路径能完成。
- 已有服务器、域名和 Docker：按 [Docker 指南](docs/docker-deployment.md)操作。
- 本地试用，或已有 Python/Nginx：按 [Python 指南](docs/python-deployment.md)操作。
- 只有会改变部署选择的信息才问。用户不懂时给一个推荐选项，并解释需要他准备什么。

先确认操作的是用户实际要运行服务的电脑、服务器或 Cloudflare 账户。你自己的临时执行环境可以测试代码，但不能当作用户的长期部署；本机 `127.0.0.1` 也不能让云端客户端直接访问。

有操作权限就完成能完成的步骤。需要用户点网页、登录或填写账号资料时，一次说明一个步骤，告诉他在哪里操作、成功后会看到什么。按实际系统给可复制命令，优先使用单行命令；本文 shell 示例用于 macOS/Linux，Windows 要换成对应命令。

## 按个人自用配置

本项目面向个人自部署。默认配置已经够用，不要另加用户系统、OAuth、网关或一堆安全组件。

`MCP_TOKEN` 是用户自己填写的连接 key，**不是 Cloudflare API token**。可以用自己熟悉、好记的内容，例如 `my-cat-2026`，不要求 32 位，不需要 OpenSSL 生成。不能为空，只能用可见的英文字母、数字或英文符号，不能含空格、中文或控制字符。

写入配置时，按 [Docker 的 `.env` 转义规则](docs/docker-deployment.md#3-填两个值)或 [Python 的 shell 引用规则](docs/python-deployment.md#2-启动)保留原始 key，尤其注意 `$`、单引号和反斜杠。客户端填写原始值，不能带配置语法的引号或转义字符。

向用户说明这个 key 要在服务端和客户端填成一样的值即可。示例不是必须照抄的固定 key；已有部署继续沿用原来的 key。图片外链拿到就能访问，这一点简单告知即可。

项目最初没有图片。多个支持的客户端和对话能共用同一套图库，但显示时仍要加载远程图片，速度受网络影响；不要说成完全不下载图片。默认 `show_image` 还附带原图供模型读取。

## 各种方式的关键配置

| 方式 | 必须处理的内容 |
| --- | --- |
| Cloudflare | Workers + D1 `DB` + R2 `IMAGES`；Secret `MCP_TOKEN` |
| Docker | `.env` 的 `DOMAIN`、`MCP_TOKEN`；可用的 TCP 80/443 端口；域名解析 |
| Python | `MCP_URL`、`PUBLIC_BASE_URL`、`MCP_TOKEN`；固定的数据目录和工作目录 |

`SHOW_IMAGE_CONTENT` 默认 `true`，首次部署保持默认。已有配置按用户选择保留。

### Cloudflare

- 用仓库根目录部署，构建命令 `npm run build`，部署命令 `npm run deploy`。
- 默认部署命令先执行 D1 migration，再发布 Worker；不要漏掉建表步骤。
- R2 bucket 不需要公开；Worker 提供 `/images/<文件名>`。
- 不需要填写 Python/Docker 使用的 `DOMAIN`、`MCP_URL`、`PUBLIC_BASE_URL`。
- 更新时保留向导创建的 Worker 名字、`database_id` 和 `bucket_name`，不要覆盖成模板值。
- 命令行需要 Node.js 22.18+。没有账户访问权限时给用户步骤，不要把本地模拟测试说成已完成云端部署。

### Docker / Python

- Docker 自动读取 `.env`，直接启动 Python 不会；Python 用环境变量或进程管理器配置。
- Docker 自带 Caddy。已有 Nginx 时接入现有服务，避免两个程序争用 80/443。
- Python 默认数据位置是当前工作目录下的 `data/images.sqlite3`，原图也存在里面。重启或迁移时保留数据和工作目录，或显式指定 `DATA_DIR`。
- Docker 数据保存在 `image_data` 命名卷；普通更新不要执行会删卷的 `docker compose down -v`。
- 如果在已有站点接入 Nginx，只合并项目需要的路由，保留用户其他站点配置。

## 连接客户端

选择 Streamable HTTP，URL 为实际部署地址加 `/mcp`。

请求头格式：`Authorization: Bearer <用户的key>`。没有请求头输入框时可用 `/mcp?token=<用户的key>`；特殊符号需要 URL 编码。请求头与参数同时存在时，请求头优先。

不是每个 MCP 客户端都支持 MCP Apps。连接成功和卡片能显示是两件事；根据用户真实客户端验证，不要承诺任意平台都有卡片。

## 验证到能实际使用

1. 访问 `/health`，确认服务响应。它不验证 key 和存储。
2. 使用真实 key 连接 MCP，确认能列出六个工具。
3. 用一张测试图完成添加、搜索、展示和外链访问。测试成功后删除的只能是这张测试图，保留用户原有数据。

遇到问题先看报错、部署日志、配置，不要反复重建数据库或 bucket。说明哪些已经验证、哪些还需要用户在客户端确认。

完成后只需把用户真正要用的 MCP 地址、key 的填写位置、使用示例和数据位置交代清楚。不要把整个操作日志当作交付。

## 工具参考

| 工具 | 参数和用途 |
| --- | --- |
| `add` | `name`，`url` 或 `base64_data` 二选一，可选 `aliases`、`description` |
| `search` | `query=""`、`limit=20`、`offset=0`；空查询列出图片 |
| `get` | `name` 为准确图片名字；返回原图、链接和尺寸，不挂卡片 |
| `show_image` | `name` 为准确图片名字；展示卡片，默认同时返回原图 |
| `addalias` | `name`、`aliases`；给图片增加别名 |
| `delete` | `name` 为准确图片名字；删除图片和别名 |

添加示例（链接替换成真实图片链接）：

```json
{
  "name": "开心猫",
  "url": "https://example.com/happy.webp",
  "aliases": ["开心", "哈哈"],
  "description": "开心或觉得好笑时使用"
}
```

展示时先 `search`，再 `show_image`，不需要让用户手写工具参数。显示设置、备份和开发细节见 [docs/advanced.md](docs/advanced.md)。
