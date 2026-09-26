# Cloudflare 部署

使用 Workers 运行 MCP 和图片接口、D1 保存名字/别名/描述等元数据、R2 保存原始图片。无需 VPS 或自备域名，Python/Docker 方式仍见[主 README](../README.md)。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hedssaz/image-library-mcp/tree/main)

需要 Cloudflare 和 GitHub 账户，以及已开通的 R2。R2 开通可能要求付款资料，请先确认 [R2 开通流程](https://developers.cloudflare.com/r2/get-started/)和计费条款；项目不会替你开通计费。

1. 点击按钮，登录 Cloudflare 并连接 GitHub，将项目复制到自己的仓库。
2. 选择 Worker、D1 数据库和 R2 bucket 名字。资源名可自定义；保留绑定名 `DB` 和 `IMAGES`，向导会自动创建、绑定并更新配置中的 ID。
3. 在 Secrets 中填写自己的 `MCP_TOKEN`：至少 32 位、不含空白的 ASCII 随机令牌，可运行 `openssl rand -hex 32` 生成。不要把令牌提交到仓库。
4. 保留构建命令 `npm run build` 和部署命令 `npm run deploy`。构建生成卡片 HTML；部署先执行 `wrangler d1 migrations apply DB --remote`，再发布 Worker。迁移使用 **DB 绑定名**，因此数据库改名不影响初始化。
5. 等待部署成功，复制 Cloudflare 显示的 `https://<worker>.<account>.workers.dev` 地址，按下一节连接。

向导读取根目录的完整项目，包括 `wrangler.jsonc`、`package.json` 和 `.dev.vars.example`；无需设置子目录或额外构建输出目录。自动创建资源及 Secret 提示依据 [Cloudflare Deploy Buttons 文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。R2 bucket 无需开放公共访问。

## 连接与配置

选择客户端的 **Streamable HTTP**：

```text
URL: https://<worker>.<account>.workers.dev/mcp
Authorization: Bearer <MCP_TOKEN>
```

将 URL 替换为自己部署的实际地址。图片外链为同域的 `/images/<文件名>`，无需设置 `DOMAIN`、`MCP_URL` 或 `PUBLIC_BASE_URL`。`/health` 可用于检查服务是否响应；它不验证鉴权或存储，部署后仍应执行一次添加、搜索、获取和删除测试。

| 配置 | 用途 |
| --- | --- |
| `DB` | D1 绑定；迁移文件位于 `cloudflare/migrations` |
| `IMAGES` | R2 绑定；保存原始字节及 MIME |
| `MCP_TOKEN` | Worker Secret；客户端的共享 Bearer 令牌，不是 Cloudflare API token |
| `SHOW_IMAGE_CONTENT` | `wrangler.jsonc` 中的变量，默认 `true`；`false` 时 `show_image` 只返回文字、卡片数据和外链，`get` 始终返回原图 |

也支持 `/mcp?token=<MCP_TOKEN>`，同时提供时以请求头为准。优先用请求头；若用 query token，不要开启记录完整请求 URL 的日志。模板默认关闭 Workers observability。图片外链无需鉴权，可公开访问。

## 更新现有部署

在向导创建的**自己的仓库**中修改代码或 `vars.SHOW_IMAGE_CONTENT`，推送部署分支后由 Workers Builds 重新部署。保留向导生成的 `database_id`、`bucket_name` 和 Worker 名字，不要用模板占位值覆盖现有资源配置。

也可在自己的仓库克隆中使用 Node.js 22.18+ 和 Wrangler 更新：

```bash
npm ci
npx wrangler login
npm run build
npm run deploy
```

轮换 MCP 令牌时，在 Worker 设置中更新 Secret，或执行 `npx wrangler secret put MCP_TOKEN`，然后更新客户端请求头。普通 UI 更新只重新构建和部署；卡片 URI 固定为 `ui://image/viewer`，不添加版本号或旧地址别名。

## 备份

D1 备份不包含原图，R2 备份不包含名字/别名；两者需要一起保存。备份期间暂停 `add`、`addalias`、`delete`，避免两个存储在不同时间点发生变化。以下命令在自己的仓库克隆中运行；先完成 `npm ci` 和 `npx wrangler login`。

备份目录默认位于仓库外，每次新建时间戳目录：

```bash
BACKUP_DIR="../image-library-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR/images"
npx wrangler d1 export DB --remote --output="$BACKUP_DIR/metadata.sql"
cp wrangler.jsonc "$BACKUP_DIR/wrangler.jsonc"
git rev-parse HEAD > "$BACKUP_DIR/source-commit.txt"
```

导出方法见 [D1 数据导出](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。R2 下载需要安装 [AWS CLI](https://developers.cloudflare.com/r2/examples/aws/aws-cli/)，并创建仅限目标 bucket 的 [Object Read only 凭据](https://developers.cloudflare.com/r2/api/tokens/)。这些 Access Key ID / Secret Access Key 与 `MCP_TOKEN` 不同。在下列命令的提示中输入凭据，region 填 `auto`，output 填 `json`：

```bash
aws configure --profile image-library-backup
```

在同一个终端填写 R2 控制台提供的 S3 API endpoint 和 bucket 名字，再下载所有原图：

```bash
R2_ENDPOINT='https://<account-id>.r2.cloudflarestorage.com'
R2_BUCKET='<自己的 bucket_name>'
aws s3 sync "s3://$R2_BUCKET" "$BACKUP_DIR/images" \
  --endpoint-url "$R2_ENDPOINT" --profile image-library-backup
```

替换上述两个值后执行；有区域管辖要求的 bucket 应使用控制台给出的对应 endpoint。确认两次备份命令成功后，再恢复写入。保留原始对象文件名，恢复时 D1 中的 `filename` 必须与 R2 key 对应；不要将备份或凭据提交到 Git。`MCP_TOKEN` 应另存于密码管理器。删除 D1/R2 资源会丢失数据，本项目不自动清理或迁移已有图库。

## 本地开发与验证范围

需要 Node.js 22.18+，所有命令在项目根目录运行：

```bash
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入自己生成的 MCP_TOKEN
npm run build
npm run db:local
npm run dev
```

本地 MCP 地址通常为 `http://127.0.0.1:8787/mcp`，以 Wrangler 输出为准。模拟 D1/R2 数据保存在 `.wrangler/state`，本地开发不访问线上图库。

```bash
npm run test:ui
npm run test:cloudflare
npm run check
npm run build:worker
```

已完成的本地验证包括：官方 SDK 新旧 MCP 协议、鉴权优先级、六个工具与 outputSchema、Unicode OR 搜索及分页、原图与 GIF/WebP/APNG 动图字节/MIME/尺寸、外链/HEAD/ETag、增删/重启持久化、开关两种状态、下载和请求大小限制、30 秒总超时，以及宿主宽高和 300ms 等待逻辑。集成测试使用临时存储和合成测试图片；`build:worker` 是 dry-run 打包，不上传。

**尚未完成真实 Cloudflare 账户部署、向导创建资源、线上配额、远程备份/恢复及真实客户端卡片验证。** 文档中的云端命令依照官方接口编写，尚未对真实账户执行。本地通过不能等同于一键部署已通过验收。

Worker 使用 TypeScript、无状态 `createMcpHandler` 和 MCP SDK v2。现有 Python 服务使用线程和 SQLite 文件，而 [Python Workers 线程不可用、文件系统不持久](https://developers.cloudflare.com/workers/languages/python/stdlib/)，因此保留独立实现，没有套用已弃用的 McpAgent 模板。

所有图片完整解码验证后保存原始字节，不做服务端缩图或替换；卡片的 150px 仅是显示上限。支持 PNG/JPEG/GIF/WebP、单图最多 10 MiB、单帧画布最多 200 万像素、最多 500 帧、累计 1 亿像素。画布限制在解码前检查，避免高压缩大图展开时超过 Workers 每个 isolate 共享的 128 MB 内存；它仍需容纳 JS、WASM、输入及并发请求，不能保证极端并发或异常文件一定不会触发内存限制。大图或长动图也可能超出免费 Workers 的 CPU 配额；详见 [Workers 运行限制](https://developers.cloudflare.com/workers/platform/limits/)。

URL 下载没有 SSRF 防护，只适合自用或受信任的用户，详见[安全提醒](../README.md#安全提醒)。
