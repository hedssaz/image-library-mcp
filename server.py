"""A small, persistent image library exposed through Streamable HTTP MCP."""

import asyncio
import base64
import binascii
import hmac
import io
import json
import os
import sqlite3
import unicodedata
import uuid
import warnings
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Any

import aiohttp
import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, ImageContent, TextContent, ToolAnnotations
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from starlette.applications import Starlette
from starlette.datastructures import Headers, QueryParams
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from yarl import URL

MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_VIEWER_URI = "ui://image/viewer-v5"
MAX_REQUEST_BYTES = 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 64 * 1024
FORMATS = {"PNG": ("png", "image/png"), "JPEG": ("jpg", "image/jpeg"),
           "GIF": ("gif", "image/gif"), "WEBP": ("webp", "image/webp")}
Name = Annotated[str, Field(min_length=1, max_length=80)]
Aliases = Annotated[list[Annotated[str, Field(min_length=1, max_length=40)]],
                    Field(max_length=32)]


class TextOutput(BaseModel):
    text: str


class ImageOutput(BaseModel):
    name: str
    url: str
    width: int = Field(gt=0, description="原始图片宽度，单位像素")
    height: int = Field(gt=0, description="原始图片高度，单位像素")


def text_result(text: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)], structuredContent={"text": text})


def fold(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold()


def clean(value: str) -> str:
    return " ".join(value.split())


def aliases_unique(values: list[str]) -> list[str]:
    result: dict[str, str] = {}
    for value in values:
        value = clean(value)
        if not value:
            raise ValueError("别名不能是空白。")
        result.setdefault(fold(value), value)
    if len(result) > 32:
        raise ValueError("每张图片最多 32 个别名。")
    return list(result.values())


def image_format(data: bytes) -> tuple[str, str]:
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError("图片不能为空，且不得超过 10 MiB。")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as img:
                if img.format not in FORMATS:
                    raise ValueError("仅支持 PNG、JPEG、GIF、WebP 图片。")
                result = FORMATS[img.format]
                img.verify()
            # Decode every frame, but store the original bytes to preserve animation.
            with Image.open(io.BytesIO(data)) as img:
                pixels = 0
                for frame in range(501):
                    try:
                        img.seek(frame)
                    except EOFError:
                        break
                    pixels += img.width * img.height
                    if frame == 500 or pixels > 100_000_000:
                        raise ValueError("图片最多 500 帧，累计像素不得超过 1 亿。")
                    img.load()
            return result
    except (UnidentifiedImageError, OSError, SyntaxError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("无法读取图片，文件可能损坏或尺寸过大。") from exc


def decode_image(value: str) -> bytes:
    if len(value) > MAX_REQUEST_BYTES:
        raise ValueError("Base64 数据过大，图片不得超过 10 MiB。")
    if value.startswith("data:"):
        header, separator, value = value.partition(",")
        if (
            not separator
            or not header.startswith("data:image/")
            or not header.endswith(";base64")
        ):
            raise ValueError("请提供图片的 Base64 data URL。")
    try:
        encoded = "".join(value.split())
        return base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("Base64 格式无效。") from exc


def download_url(value: str) -> URL:
    url = URL(value)
    if url.scheme not in {"http", "https"} or not url.host:
        raise ValueError("图片链接必须是 HTTP(S) URL。")
    return url


async def download_image(value: str) -> bytes:
    try:
        return await asyncio.wait_for(_download_image(value), timeout=30)
    except asyncio.TimeoutError as exc:
        raise ValueError("图片下载超时（30 秒）。") from exc
    except aiohttp.ClientError as exc:
        raise ValueError("图片下载失败，请检查链接、DNS 和 HTTPS 证书。") from exc


async def _download_image(value: str) -> bytes:
    async with aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=30),
        headers={"User-Agent": "image-mcp/1.0", "Accept": "image/*"},
    ) as session:
        url = download_url(value)
        for redirect in range(6):
            async with session.get(url, allow_redirects=False) as response:
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.headers.get("Location")
                    if not location or redirect == 5:
                        raise ValueError("图片链接重定向无效或超过 5 次。")
                    redirect_url = url.join(URL(location))
                    url = download_url(str(redirect_url))
                    continue
                if response.status != 200:
                    raise ValueError(f"图片下载失败，来源返回 HTTP {response.status}。")
                if response.content_length and response.content_length > MAX_IMAGE_BYTES:
                    raise ValueError("图片不得超过 10 MiB。")
                data = bytearray()
                async for chunk in response.content.iter_chunked(64 * 1024):
                    data.extend(chunk)
                    if len(data) > MAX_IMAGE_BYTES:
                        raise ValueError("图片不得超过 10 MiB。")
                return bytes(data)


class ImageLibrary:
    def __init__(self, data_dir: Path, public_base_url: str) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "images.sqlite3"
        self.public_base_url = public_base_url
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS images (
                filename TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE UNICODE UNIQUE,
                aliases TEXT NOT NULL,
                description TEXT NOT NULL,
                mime TEXT NOT NULL,
                data BLOB NOT NULL
            )""")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.create_function("fold", 1, fold, deterministic=True)
        db.create_collation("UNICODE", lambda a, b: (fold(a) > fold(b)) - (fold(a) < fold(b)))
        try:
            with db:
                yield db
        finally:
            db.close()

    def line(self, row: sqlite3.Row | dict[str, Any]) -> str:
        labels = json.loads(row["aliases"])
        if row["description"]:
            labels.append(row["description"])
        name = row["name"].replace("|", "\\|")
        detail = " / ".join(labels).replace("|", "\\|")
        if not detail:
            detail = "无别名/描述"
        return f"- {name} | {detail} | {self.public_base_url}/images/{row['filename']}"

    def add(self, name: str, aliases: list[str], description: str, data: bytes) -> str:
        extension, mime = image_format(data)
        row = {"filename": f"{uuid.uuid4().hex}.{extension}", "name": name,
               "aliases": json.dumps(aliases, ensure_ascii=False),
               "description": description, "mime": mime, "data": data}
        try:
            with self.connect() as db:
                db.execute("""INSERT INTO images VALUES
                    (:filename, :name, :aliases, :description, :mime, :data)""", row)
        except sqlite3.IntegrityError as exc:
            raise ValueError("图片名字已存在，请换一个名字，或使用 addalias 添加别名。") from exc
        return self.line(row)

    def search(self, query: str, limit: int, offset: int) -> str:
        terms = fold(query).split()
        if terms:
            conditions = [
                "instr(fold(name || ' ' || aliases || ' ' || description), ?) > 0"
                for _ in terms
            ]
            where = " AND ".join(conditions)
        else:
            where = "1"

        exact_name = fold(clean(query))
        with self.connect() as db:
            rows = db.execute(
                f"""SELECT filename, name, aliases, description FROM images WHERE {where}
                ORDER BY (fold(name) = ?) DESC, rowid DESC LIMIT ? OFFSET ?""",
                [*terms, exact_name, limit, offset],
            ).fetchall()
        if not rows:
            return "没有找到匹配的图片。"
        return "\n".join(self.line(row) for row in rows)

    def addalias(self, name: str, aliases: list[str]) -> str:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT filename, name, aliases, description FROM images WHERE name = ?", (name,)
            ).fetchone()
            if existing is None:
                raise ValueError("图片不存在，请先 search 查询准确的图片名字。")
            row = dict(existing)
            current_aliases = json.loads(row["aliases"])
            merged_aliases = aliases_unique(current_aliases + aliases)
            row["aliases"] = json.dumps(merged_aliases, ensure_ascii=False)
            db.execute("UPDATE images SET aliases = ? WHERE filename = ?",
                       (row["aliases"], row["filename"]))
        return self.line(row)

    def delete(self, name: str) -> str:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT name FROM images WHERE name = ?", (name,)).fetchone()
            if row is None:
                raise ValueError("图片不存在，请先 search 查询准确的图片名字。")
            db.execute("DELETE FROM images WHERE name = ?", (name,))
        return f"已删除：{row['name']}。源站图片及其别名已移除；已缓存的图片将在缓存到期后失效。"

    def get_image(self, filename: str) -> sqlite3.Row | None:
        with self.connect() as db:
            return db.execute("SELECT data, mime FROM images WHERE filename = ?", (filename,)).fetchone()

    def image_info(self, row: sqlite3.Row) -> dict[str, str | int]:
        with Image.open(io.BytesIO(row["data"])) as image:
            width, height = image.size
        return {"name": row["name"], "url": f"{self.public_base_url}/images/{row['filename']}",
                "width": width, "height": height}

    def _get_by_name(self, name: str) -> sqlite3.Row:
        with self.connect() as db:
            row = db.execute("SELECT * FROM images WHERE name = ?", (name,)).fetchone()
        if row is None:
            raise ValueError("图片不存在，请先 search 查询准确的图片名字。")
        return row

    def get(self, name: str) -> CallToolResult:
        row = self._get_by_name(name)
        encoded_image = base64.b64encode(row["data"]).decode("ascii")
        return CallToolResult(
            content=[TextContent(type="text", text=self.line(row)),
                     ImageContent(type="image", mimeType=row["mime"], data=encoded_image)],
            structuredContent=self.image_info(row),
        )

    def show_image(self, name: str) -> CallToolResult:
        row = self._get_by_name(name)
        return CallToolResult(
            content=[TextContent(type="text", text=self.line(row))],
            structuredContent=self.image_info(row),
        )


class MCPGuard:
    """Authenticate MCP requests and bound the body before the SDK parses JSON."""

    def __init__(self, app: ASGIApp, token: str, path: str) -> None:
        self.app = app
        self.token = token.encode()
        self.path = path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"].rstrip("/") != self.path:
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        authorization = headers.get("authorization")
        if authorization is not None:
            scheme, _, token = authorization.partition(" ")
            if scheme.lower() != "bearer":
                token = ""
        else:
            query = QueryParams(scope.get("query_string", b""))
            token = query.get("token", "")
        if not hmac.compare_digest(token.encode(), self.token):
            response = JSONResponse(
                {"error": "需要有效的 Bearer token。"}, status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
            await response(scope, receive, send)
            return
        data = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            data.extend(message.get("body", b""))
            if len(data) > MAX_REQUEST_BYTES:
                response = JSONResponse({"error": "请求过大。"}, status_code=413)
                await response(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(data), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def build_app(mcp_url: str, public_base_url: str, token: str, data_dir: Path) -> Starlette:
    endpoint = URL(mcp_url)
    if (
        endpoint.scheme not in {"http", "https"}
        or not endpoint.host
        or endpoint.path in {"", "/"}
        or endpoint.path.endswith("/")
        or endpoint.query_string
        or endpoint.fragment
        or endpoint.user is not None
    ):
        raise ValueError("MCP_URL 必须是完整接口地址，例如 https://example.com/mcp。")
    image_origin = URL(public_base_url)
    if (
        image_origin.scheme not in {"http", "https"}
        or not image_origin.host
        or image_origin.path not in {"", "/"}
        or image_origin.query_string
        or image_origin.fragment
        or image_origin.user is not None
    ):
        raise ValueError("PUBLIC_BASE_URL 必须是完整域名地址，不含路径，例如 https://example.com。")
    if len(token) < 32 or not token.isascii() or any(c.isspace() for c in token):
        raise ValueError("MCP_TOKEN 必须是至少 32 位、不含空白的 ASCII 随机令牌。")
    library = ImageLibrary(data_dir, str(image_origin).rstrip("/"))
    viewer_html = Path(__file__).with_name("viewer.html").read_text(encoding="utf-8")
    mcp = FastMCP(
        "Image Library", stateless_http=True, json_response=True,
        streamable_http_path=endpoint.path,
        instructions="先 search 搜索图片列表；要在聊天里显示或发送图片，调用 show_image(准确图片名字)，"
                     "由 MCP App 内联显示图片，不需要另写 Markdown 图片。"
                     "需要读取原图内容和外链时使用 get，它直接提供 ImageContent。"
                     "添加时 URL 与 Base64 二选一。别名和删除使用准确图片名字。",
        transport_security=TransportSecuritySettings(
            allowed_hosts=[endpoint.raw_authority, "127.0.0.1:*", "localhost:*", "[::1]:*"],
            allowed_origins=[str(endpoint.origin())],
        ),
    )

    @mcp.resource(
        IMAGE_VIEWER_URI, name="image_viewer", title="图片",
        description="在聊天中显示 show_image 返回的图片。",
        mime_type="text/html;profile=mcp-app",
        meta={"ui": {"csp": {"resourceDomains": [str(image_origin.origin())]},
                     "prefersBorder": False}},
    )
    def image_viewer() -> str:
        return viewer_html

    @mcp.tool(
        title="显示图片",
        annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False),
        meta={"ui": {"resourceUri": IMAGE_VIEWER_URI}}, structured_output=True,
    )
    async def show_image(name: Name) -> Annotated[CallToolResult, ImageOutput]:
        """在聊天中展示或发送表情包时调用本工具，由 MCP App 直接显示图片。
        name 使用 search 返回的准确名字；无需先调用 get 或另写 Markdown 图片。
        返回图片外链、名字和原始 width/height；UI 按配置的期望尺寸及宿主空间等比例缩小，不放大小图。
        """
        return await asyncio.to_thread(library.show_image, clean(name))

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False), structured_output=True)
    async def search(query: Annotated[str, Field(max_length=200)] = "",
                     limit: Annotated[int, Field(ge=1, le=100)] = 20,
                     offset: Annotated[int, Field(ge=0)] = 0) -> Annotated[CallToolResult, TextOutput]:
        """搜索库内图片的名字、别名和描述；忽略大小写，空格分隔的词须全部匹配。
        空 query 列出最新图片；用 limit/offset 翻页。返回：- 图片名字 | 别名/描述 | 公网图片链接。
        此工具仅返回文字列表；展示或发送表情包时，用选定结果的准确名字调用 show_image(name)。
        需要读取原图 ImageContent 和外链时，才调用 get(name)。
        """
        result = await asyncio.to_thread(library.search, query, limit, offset)
        return text_result(result)

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False), structured_output=True)
    async def get(name: Name) -> Annotated[CallToolResult, ImageOutput]:
        """按 search 返回的准确图片名字获取一张图片，不按别名或模糊关键词选择。
        用于读取原图内容；在聊天中展示或发送表情包请调用 show_image(name)。
        同时返回文字说明（名字、别名/描述、可公开访问的外链）和原图 ImageContent（Base64、真实 MIME）。
        直接读取库内原图，无需客户端再下载外链；图片 Base64 只在 image 内容块中，不作为文字返回。
        """
        return await asyncio.to_thread(library.get, clean(name))

    @mcp.tool(annotations=ToolAnnotations(destructiveHint=False, openWorldHint=True), structured_output=True)
    async def add(name: Name, url: Annotated[str, Field(max_length=8192)] | None = None,
                  base64_data: str | None = None, aliases: Aliases | None = None,
                  description: Annotated[str, Field(max_length=500)] = "") -> Annotated[CallToolResult, TextOutput]:
        """添加图片：url（由服务端下载）和 base64_data（纯 Base64 或 data URL）必须且只能提供一个。
        名字须唯一；aliases 可为 ["风景", "户外"]，description 为描述。
        支持 PNG/JPEG/GIF/WebP，保留动图，最大 10 MiB；返回名字、别名/描述和本站公网链接。
        """
        name = clean(name)
        if not name:
            raise ValueError("图片名字不能为空白。")
        if (url is None) == (base64_data is None):
            raise ValueError("url 和 base64_data 必须且只能提供一个。")
        labels = aliases_unique(aliases or [])
        if url is not None:
            data = await download_image(url)
        else:
            data = await asyncio.to_thread(decode_image, base64_data)

        description = clean(description)
        result = await asyncio.to_thread(library.add, name, labels, description, data)
        return text_result(result)

    @mcp.tool(annotations=ToolAnnotations(destructiveHint=False, idempotentHint=True,
                                         openWorldHint=False), structured_output=True)
    async def addalias(name: Name, aliases: Annotated[Aliases, Field(min_length=1)]) -> Annotated[CallToolResult, TextOutput]:
        """为准确图片名字添加一个或多个别名，例如 aliases=["风景", "晨光"]。
        重复别名自动去重；返回更新后的名字、别名/描述和公网图片链接。
        """
        name = clean(name)
        aliases = aliases_unique(aliases)
        result = await asyncio.to_thread(library.addalias, name, aliases)
        return text_result(result)

    @mcp.tool(annotations=ToolAnnotations(destructiveHint=True, openWorldHint=False), structured_output=True)
    async def delete(name: Name) -> Annotated[CallToolResult, TextOutput]:
        """永久删除准确图片名字对应的图片和全部别名，源站返回 404，缓存副本到期后失效。
        请仅在用户明确要求删除这张图片时调用；不能用模糊关键词或别名删除。
        """
        result = await asyncio.to_thread(library.delete, clean(name))
        return text_result(result)

    @mcp.custom_route("/images/{filename}", methods=["GET", "HEAD"])
    async def image_route(request: Request) -> Response:
        filename = request.path_params["filename"]
        row = await asyncio.to_thread(library.get_image, filename)
        headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
        if row is None:
            return Response(status_code=404, headers=headers)
        headers["Cache-Control"] = "public, max-age=86400"
        headers["ETag"] = f'"{filename}"'
        if request.headers.get("if-none-match") == headers["ETag"]:
            return Response(status_code=304, headers=headers)
        headers["Content-Length"] = str(len(row["data"]))
        if request.method == "HEAD":
            body = b""
        else:
            body = row["data"]
        return Response(body, media_type=row["mime"], headers=headers)

    @mcp.custom_route("/health", methods=["GET"])
    async def health_route(request: Request) -> JSONResponse:
        return JSONResponse({"status": "ok"})

    app = mcp.streamable_http_app()
    app.add_middleware(MCPGuard, token=token, path=endpoint.path)
    return app


def create_app() -> Starlette:
    mcp_url = os.environ.get("MCP_URL", "")
    public_base_url = os.environ.get("PUBLIC_BASE_URL", "")
    token = os.environ.get("MCP_TOKEN", "")
    data_dir = Path(os.environ.get("DATA_DIR", "./data"))
    return build_app(mcp_url, public_base_url, token, data_dir)


if __name__ == "__main__":
    app = create_app()
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port, access_log=False)
