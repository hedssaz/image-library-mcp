# 可选设置与维护

[返回 README](../README.md) · [连接与使用](usage.md)

默认设置已经能用。想调整显示、备份或自己开发时，再看对应部分。

## 是否把原图交给 AI

`SHOW_IMAGE_CONTENT` 默认 `true`：展示卡片时，同时返回原图给模型读取。设为 `false` 后仍有卡片、外链和宽高，但 `show_image` 不再附带原图内容；`get` 始终返回原图。它是服务端设置，不是聊天中的工具参数。

- Cloudflare：在自己的部署仓库修改 `wrangler.jsonc` 的 `vars.SHOW_IMAGE_CONTENT`，然后重新部署。
- Docker：在 `.env` 写 `SHOW_IMAGE_CONTENT=false`，再运行 `docker compose up -d`。
- Python：设置 `export SHOW_IMAGE_CONTENT=false`，再重启服务。

改回 `true` 即可恢复。

## 表情包显示设置

在 [ui/viewer.js](../ui/viewer.js) 中调整：

```javascript
const CUSTOM_SIZE = true;
const PREFERRED_IMAGE_SIZE = 150;
```

- 宿主未提供宽度时直接布局；明确返回 0 等不可用值时，最多等 300ms，然后用 iframe 实际宽度（扣除左右内边距）布局。仍测不到宽度则按期望尺寸计算，不上报零尺寸；迟到的有效尺寸仍会更新布局。
- 开启时，按期望尺寸、可用宽度与宿主声明的 `height` / `maxHeight` 等比例缩小，小图不放大。固定高度由宿主控制；弹性高度仅在计算结果改变时上报，不收窄 iframe 宽度。不会把 iframe 当前的弹性高度当作上限，避免高度反馈循环。
- 关闭时，不上报尺寸，图片默认上限为 300×300。

表情包默认使用 `8px` 圆角。在 [ui/build.mjs](../ui/build.mjs) 中修改 `img` 的 `border-radius` 即可调整，设为 `0` 恢复直角。圆角仅影响卡片中的显示，不修改原图文件或外链。

图片通过最大宽高限制尺寸，元素本身保持原图比例；宿主空间变窄或变矮时，四个圆角仍贴合实际图片边缘。

### 对齐方式与水平偏移

在 [ui/build.mjs](../ui/build.mjs) 的 CSS 中修改 `#app` 和 `img` 的对应属性，保留其他样式。例如，左对齐并向右留出 16 像素：

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

对齐和偏移不依赖 `CUSTOM_SIZE`，但建议左对齐时一起开启，让卡片高度随图片收紧。偏移只调整留白，不修改期望图片尺寸。

### 让修改生效

修改 UI 后，用 Node.js 22.18+ 重新构建，再重新部署：

```bash
npm ci
npm run build
```

`viewer.html` 是自动生成的压缩产物，请修改 [ui/viewer.js](../ui/viewer.js) 或 [ui/build.mjs](../ui/build.mjs)，不要直接编辑它。已附带构建好的版本，Python/Docker 直接部署不需要 Node.js；Cloudflare 构建会自动重新生成卡片。更新 UI 后重新构建、部署并重启服务，资源地址固定为 `ui://image/viewer`，不随更新更名。客户端若仍缓存旧内容，可重新加载卡片或刷新连接器。构建产物的第三方许可见 `THIRD_PARTY_NOTICES.txt`。

## Cloudflare 命令行更新

在自己部署仓库的本地副本中执行，需要 Node.js 22.18+：

```bash
npm ci
npx wrangler login
npm run build
npm run deploy
```

保留现有 Worker 名字、`database_id`、`bucket_name`，不要用模板占位值覆盖。更换 key 可执行 `npx wrangler secret put MCP_TOKEN`，再同步修改客户端。

## Cloudflare 备份

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
aws s3 sync "s3://$R2_BUCKET" "$BACKUP_DIR/images" --endpoint-url "$R2_ENDPOINT" --profile image-library-backup
```

替换上述两个值后执行；有区域管辖要求的 bucket 应使用控制台给出的对应 endpoint。确认两次备份命令成功后，再恢复写入。保留原始对象文件名，恢复时 D1 中的 `filename` 必须与 R2 key 对应；不要将备份或凭据提交到 Git。另外保存原来的 `MCP_TOKEN`，方便恢复连接。删除 D1/R2 资源会丢失数据，本项目不自动清理或迁移已有图库。

## 本地开发与测试

Python 测试（先按 [Python 指南](python-deployment.md)安装项目依赖）：

```bash
.venv/bin/pip install pytest==9.0.3 pytest-asyncio==1.4.0
.venv/bin/python -m pytest -q tests
```

Cloudflare 本地开发（Node.js 22.18+，在项目根目录执行）：

```bash
npm ci
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，在单引号内填写原始 key，例如：

```dotenv
MCP_TOKEN='#cat'
```

保留外层单引号，否则 `#` 会开始注释。单引号内的 `$`、双引号和反斜杠原样填写，不要套用 Docker `.env` 的转义规则。客户端填写原始 key，不加外层引号。

然后执行：

```bash
npm run build
npm run db:local
npm run dev
```

如果 key 本身含单引号，保留 `.dev.vars` 中的 `MCP_TOKEN=''`，完成上述 `build` 和 `db:local` 后，用下面两行代替 `npm run dev`。第一行执行后原样粘贴 key 并回车，第二行会将该值传给 Wrangler，覆盖 `.dev.vars` 的空值；Bash 和 Zsh 均可使用：

```bash
read -r MCP_TOKEN
npm run dev -- --var "MCP_TOKEN:$MCP_TOKEN"
```

本地地址以终端输出为准，通常是 `http://127.0.0.1:8787/mcp`。本地 D1/R2 数据位于 `.wrangler/state`，不会访问线上图库。

```bash
npm run test:ui
npm run test:images
npm run test:cloudflare
npm run check
npm run build:worker
```

`build:worker` 只打包检查，不发布。集成测试使用本地 workerd 和临时 D1/R2；本地测试通过不等于已在真实 Cloudflare 账户部署，也不代表每个客户端都能显示卡片。

## 实现说明

Python/Docker 把原图和元数据放在 SQLite；Cloudflare 用 D1 保存名字、别名和描述，R2 保存原图。图片验证后保留原始字节，不在服务端缩图。界面的 150px 只是显示尺寸。

支持 PNG、JPEG、GIF、WebP，单图最多 10 MiB，最多 500 帧、累计 1 亿像素。Cloudflare 还限制单帧画布最多 200 万像素，在解码前检查；PNG 扫描行的解压字节数受对应图像或帧的尺寸与格式限制，附属元数据只校验 CRC，原样保存，不解压内容。

Workers 每个 isolate 共享的 128 MB 内存还需容纳 JS、WASM、输入和并发请求，不能保证极端并发或异常文件一定不会触发限制。CPU、内存和存储额度受套餐限制，大图或长动图可能无法在免费 Worker 中完成处理；详见 [Workers 运行限制](https://developers.cloudflare.com/workers/platform/limits/)。

搜索是文字包含匹配，忽略大小写；空格分隔的关键词命中任意一个就返回，结果去重后分页。其他工具按准确图片名字操作。

删除后源站返回 404；浏览器或 CDN 已缓存的图片可能保留到过期。默认缓存 24 小时，不主动清理 CDN 缓存。

项目按个人自用设计，URL 下载未做 SSRF 限制。图片外链不需要 key；不要把不想公开访问的图片当作私密网盘文件存放。
