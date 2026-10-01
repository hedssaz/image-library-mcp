# Cloudflare 部署

[返回 README](../README.md) · [连接与使用](usage.md)

没有服务器也能用。部署完成后，Cloudflare 会给你一个 HTTPS 地址，不需要自己买域名。

## 1. 准备账号

需要 GitHub 和 Cloudflare 账号。先在 Cloudflare 控制台开通 **R2**，它负责保存图片；名字、别名和描述由 **D1** 保存。

R2 有免费额度，但开通可能要求绑定银行卡等付款资料。按 [Cloudflare 开通页面](https://developers.cloudflare.com/r2/get-started/)的提示填写即可。没有可用付款方式时，可以选 [Docker](docker-deployment.md) 或 [Python](python-deployment.md)；当前项目的 Cloudflare 版本仍需要 R2。

## 2. 点击部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hedssaz/image-library-mcp/tree/main)

登录并按页面提示连接 GitHub，把项目复制到自己的仓库。遇到下面这些选项，可以这样填：

| 页面里的选项 | 怎么填 |
| --- | --- |
| Worker 名字 | 默认值就可以，也可以自己起名 |
| D1 数据库、R2 bucket | 让向导创建；资源名可以自定义 |
| `MCP_TOKEN` | 自己好记的 key，例如 `my-cat-2026`；英文、数字或英文符号均可，不要留空或含空格、中文 |
| `SHOW_IMAGE_CONTENT` | 保持 `true` |
| 构建命令 | 保持 `npm run build` |
| 部署命令 | 保持 `npm run deploy` |

如果看到“绑定名”，保留 `DB` 和 `IMAGES`。它们是代码识别数据库和图片仓库的名字，不是让你再申请两个账号。项目根目录、构建输出目录等保持向导默认值，不要改成 `cloudflare` 子目录。

`MCP_TOKEN` 不是 Cloudflare API token，不用去申请，也不要求 32 位。填写后记住它，连接客户端时用同一个值。

点击部署，等页面显示成功。默认部署命令会先建立数据库表，再发布程序。R2 bucket 不需要开启公共访问，图片由 Worker 提供链接。

## 3. 复制服务地址

在 Worker 页面找到类似这样的地址：

```text
https://你的worker名字.你的账号子域名.workers.dev
```

末尾加上 `/mcp`，就是连接地址。按[连接与使用](usage.md)填进去，再填自己的 key。

Cloudflare 方式不用填写 `DOMAIN`、`MCP_URL` 或 `PUBLIC_BASE_URL`。

## 4. 试一下

打开服务地址末尾的 `/health`，看到 `{"status":"ok"}` 表示程序已启动。

再连接 MCP，让 AI 添加一张测试图片、搜索并展示它。这样才确认图片仓库和客户端也能正常使用；只看 `/health` 还不够。

## 以后怎么更新？

更新向导创建的**你自己的仓库**，推送到部署分支后，Workers Builds 会重新部署。保留 `wrangler.jsonc` 里现有 Worker 名字、`database_id`、`bucket_name`，不要覆盖成模板中的占位值。

要换 key，在 Worker 设置里的 Secret 修改 `MCP_TOKEN`，然后同步修改客户端。命令行更新、备份、显示设置见[可选设置与维护](advanced.md)。

## 常见卡点

- **创建 R2 失败**：先检查账号是否已完成 R2 开通。
- **提示 key 无效 / 401**：服务端和客户端填的 key 要完全一样。
- **提示缺少数据库表**：检查部署命令是否还是 `npm run deploy`，它包含建表步骤。
- **没有图片**：项目不自带图库，先让 AI 添加一张。
- **能搜索但没有卡片**：客户端可能不支持 MCP Apps；让 AI 返回图片外链试试。

向导配置参考 [Cloudflare 官方说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。本项目有本地集成测试，真实账户的部署向导和客户端卡片仍需在你使用的环境里验证。
