import asyncio
import base64
import io
import json
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor

import httpx
import jsonschema
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from PIL import Image

import server

TOKEN = "a-test-secret-with-at-least-32-characters"
ORIGIN = "https://example.test"
IMAGE_ORIGIN = ORIGIN


def picture(fmt="PNG", animated=False):
    output = io.BytesIO()
    first = Image.new("RGB", (8, 8), "red")
    options = {"save_all": True, "append_images": [Image.new("RGB", (8, 8), "blue")],
               "duration": 100, "loop": 0} if animated else {}
    first.save(output, fmt, **options)
    return output.getvalue()


def encoded(data=None):
    return base64.b64encode(picture() if data is None else data).decode()


def text(result):
    return "\n".join(item.text for item in result.content if item.type == "text")


@asynccontextmanager
async def connected(path, query_token=False):
    app = server.build_app(ORIGIN + "/mcp", IMAGE_ORIGIN, TOKEN, path)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url=ORIGIN) as public:
            headers = {} if query_token else {"Authorization": f"Bearer {TOKEN}"}
            endpoint = f"{ORIGIN}/mcp?token={TOKEN}" if query_token else f"{ORIGIN}/mcp"
            async with httpx.AsyncClient(transport=transport, headers=headers) as http:
                async with streamable_http_client(endpoint, http_client=http) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        yield session, public


@pytest.mark.asyncio
@pytest.mark.parametrize("query_token", [False, True])
async def test_mcp_lifecycle_and_restart(tmp_path, query_token):
    async with connected(tmp_path, query_token) as (client, public):
        tools = {tool.name: tool for tool in (await client.list_tools()).tools}
        assert set(tools) == {"search", "get", "show_image", "add", "addalias", "delete"}
        assert tools["search"].annotations.readOnlyHint
        assert tools["get"].annotations.readOnlyHint
        assert set(tools["get"].outputSchema["properties"]) == {"name", "url", "width", "height"}
        assert tools["delete"].annotations.destructiveHint
        result = await client.call_tool("add", {
            "name": "山间日出", "base64_data": encoded(),
            "aliases": ["风景", "晨光", "风景"], "description": "旅行摄影",
        })
        assert not result.isError
        line = text(result)
        assert line.startswith(f"- 山间日出 | 风景 / 晨光 / 旅行摄影 | {IMAGE_ORIGIN}/images/")
        url = line.split(" | ")[-1]
        assert "token=" not in url and TOKEN not in url
        obtained = await client.call_tool("get", {"name": "山间日出"})
        assert not obtained.isError
        assert obtained.structuredContent == {"name": "山间日出", "url": url, "width": 8, "height": 8}
        assert [block.type for block in obtained.content] == ["text", "image"]
        assert text(obtained) == line
        assert obtained.content[1].mimeType == "image/png"
        assert base64.b64decode(obtained.content[1].data, validate=True) == picture()
        assert obtained.content[1].data not in text(obtained)
        assert obtained.content[1].data not in json.dumps(obtained.structuredContent)
        fetched = await public.get(url)
        assert fetched.status_code == 200 and fetched.content == picture()
        assert fetched.headers["content-type"] == "image/png"
        assert fetched.headers["cache-control"] == "public, max-age=86400"
        assert (await public.get(url, headers={"If-None-Match": fetched.headers["etag"]})).status_code == 304
        assert fetched.headers["x-content-type-options"] == "nosniff"
        head = await public.head(url)
        assert not head.content and int(head.headers["content-length"]) == len(picture())
        result = await client.call_tool("addalias", {"name": "山间日出", "aliases": ["户外", "SAMPLE", "sample"]})
        assert not result.isError and text(result).count("SAMPLE") == 1
        assert "山间日出" in text(await client.call_tool("search", {"query": "sample 摄影"}))
        assert "山间日出" in text(await client.call_tool("search", {"query": "户外"}))
        assert "没有找到" in text(await client.call_tool("search", {"query": "不存在"}))
        # Aliases cannot accidentally select an image for deletion.
        assert (await client.call_tool("delete", {"name": "户外"})).isError
        assert (await client.call_tool("get", {"name": "户外"})).isError
        assert (await client.call_tool("get", {"name": "山间"})).isError

    async with connected(tmp_path, query_token) as (client, public):
        assert "山间日出" in text(await client.call_tool("search", {"query": "户外"}))
        assert (await public.get(url)).content == picture()
        assert not (await client.call_tool("delete", {"name": "山间日出"})).isError
        missing = await public.get(url)
        assert missing.status_code == 404 and missing.headers["cache-control"] == "no-store"
        assert "没有找到" in text(await client.call_tool("search", {}))
        assert (await client.call_tool("delete", {"name": "山间日出"})).isError
        assert (await client.call_tool("get", {"name": "山间日出"})).isError


@pytest.mark.asyncio
@pytest.mark.parametrize("fmt,animated,extension,mime", [
    ("PNG", False, "png", "image/png"), ("JPEG", False, "jpg", "image/jpeg"),
    ("GIF", True, "gif", "image/gif"), ("WEBP", True, "webp", "image/webp"),
])
async def test_original_images_and_animation(tmp_path, fmt, animated, extension, mime):
    data = picture(fmt, animated)
    async with connected(tmp_path) as (client, public):
        result = await client.call_tool("add", {
            "name": fmt, "base64_data": f"data:{mime};base64,{encoded(data)}",
        })
        assert not result.isError
        url = text(result).split(" | ")[-1]
        assert url.endswith("." + extension)
        response = await public.get(url)
        assert response.content == data and response.headers["content-type"] == mime
        obtained = await client.call_tool("get", {"name": fmt.lower()})
        assert not obtained.isError
        assert obtained.structuredContent == {"name": fmt, "url": url, "width": 8, "height": 8}
        assert [block.type for block in obtained.content] == ["text", "image"]
        assert obtained.content[1].mimeType == mime
        assert base64.b64decode(obtained.content[1].data, validate=True) == data
        assert text(obtained) == text(result)
        with Image.open(io.BytesIO(response.content)) as img:
            assert getattr(img, "n_frames", 1) == (2 if animated else 1)


@pytest.mark.asyncio
async def test_search_lists_text_and_get_reads_stored_image(tmp_path, monkeypatch):
    async def no_download(*args, **kwargs):
        raise AssertionError("get must not fetch the public image URL")

    async with connected(tmp_path) as (client, _):
        await client.call_tool("add", {"name": "first", "base64_data": encoded(), "aliases": ["示例标签"]})
        await client.call_tool("add", {"name": "second", "base64_data": encoded(picture("JPEG")), "aliases": ["示例标签"]})
        monkeypatch.setattr(server, "download_image", no_download)
        listed = await client.call_tool("search", {"query": "示例标签"})
        assert not listed.isError and all(item.type == "text" for item in listed.content)
        assert len(text(listed).splitlines()) == 2
        obtained = await client.call_tool("get", {"name": "  FIRST  "})
        assert not obtained.isError
        assert base64.b64decode(obtained.content[1].data) == picture()
        assert text(obtained).startswith(f"- first | 示例标签 | {IMAGE_ORIGIN}/images/")


@pytest.mark.asyncio
async def test_mcp_app_resource_and_tool_result(tmp_path):
    async with connected(tmp_path) as (client, public):
        tools = {tool.name: tool for tool in (await client.list_tools()).tools}
        tool = tools["show_image"]
        assert set(tool.inputSchema["properties"]) == {"name"}
        assert tool.meta["ui"]["resourceUri"] == "ui://image/viewer-v5"
        assert tool.annotations.readOnlyHint and not tool.annotations.openWorldHint
        resources = (await client.list_resources()).resources
        resource = next(item for item in resources if str(item.uri) == "ui://image/viewer-v5")
        assert resource.mimeType == "text/html;profile=mcp-app"
        result = await client.read_resource("ui://image/viewer-v5")
        content = result.contents[0]
        assert content.mimeType == "text/html;profile=mcp-app"
        assert content.meta["ui"]["csp"]["resourceDomains"] == [IMAGE_ORIGIN]
        assert content.meta["ui"]["prefersBorder"] is False
        assert '<img id="image"' in content.text and 'src="http' not in content.text
        assert TOKEN not in content.text
        added = await client.call_tool("add", {"name": "Viewer", "base64_data": encoded(), "aliases": ["风景"]})
        shown = await client.call_tool("show_image", {"name": "viewer"})
        assert not shown.isError
        assert [block.type for block in shown.content] == ["text", "image"]
        assert shown.content[1].mimeType == "image/png"
        assert base64.b64decode(shown.content[1].data, validate=True) == picture()
        assert shown.content[1].data not in text(shown)
        assert shown.content[1].data not in json.dumps(shown.structuredContent)
        assert text(shown) == text(added)
        assert shown.structuredContent == {"name": "Viewer", "url": text(added).rsplit(" | ", 1)[1],
                                           "width": 8, "height": 8}
        assert (await public.get(shown.structuredContent["url"])).content == picture()
        assert (await client.call_tool("show_image", {"name": "风景"})).isError
        await client.call_tool("delete", {"name": "Viewer"})
        assert (await client.call_tool("show_image", {"name": "Viewer"})).isError


@pytest.mark.asyncio
@pytest.mark.parametrize("fmt,size,mime", [("PNG", (600, 400), "image/png"), ("JPEG", (80, 500), "image/jpeg"),
                                           ("GIF", (120, 80), "image/gif"), ("WEBP", (5, 5), "image/webp")])
async def test_show_image_original_dimensions(tmp_path, fmt, size, mime):
    output = io.BytesIO()
    Image.new("RGB", size, "red").save(output, fmt)
    async with connected(tmp_path) as (client, _):
        added = await client.call_tool("add", {"name": fmt, "base64_data": encoded(output.getvalue())})
        assert not added.isError
        default = await client.call_tool("show_image", {"name": fmt})
        assert not default.isError
        assert default.content[1].type == "image"
        assert default.content[1].mimeType == mime
        assert base64.b64decode(default.content[1].data, validate=True) == output.getvalue()
        assert (default.structuredContent["width"], default.structuredContent["height"]) == size
        assert set(default.structuredContent) == {"name", "url", "width", "height"}


@pytest.mark.asyncio
async def test_output_schemas_match_all_six_tool_results(tmp_path):
    async with connected(tmp_path) as (client, _):
        tools = {tool.name: tool for tool in (await client.list_tools()).tools}
        for tool in tools.values():
            assert tool.outputSchema and tool.outputSchema["type"] == "object"
            jsonschema.Draft202012Validator.check_schema(tool.outputSchema)
        calls = [
            ("add", {"name": "schema", "base64_data": encoded()}),
            ("addalias", {"name": "schema", "aliases": ["风景"]}),
            ("search", {"query": "风景"}),
            ("get", {"name": "schema"}),
            ("show_image", {"name": "schema"}),
            ("delete", {"name": "schema"}),
            ("search", {"query": "missing"}),
        ]
        for name, arguments in calls:
            result = await client.call_tool(name, arguments)
            assert not result.isError
            jsonschema.validate(result.structuredContent, tools[name].outputSchema)
            if name not in {"get", "show_image"}:
                assert result.structuredContent == {"text": text(result)}
            else:
                assert set(result.structuredContent) == {"name", "url", "width", "height"}


@pytest.mark.asyncio
async def test_search_duplicate_and_validation(tmp_path):
    async with connected(tmp_path) as (client, _):
        for name in ["Sample", "sample landscape", "户外"]:
            assert not (await client.call_tool("add", {"name": name, "base64_data": encoded()})).isError
        assert (await client.call_tool("add", {"name": "ＳＡＭＰＬＥ", "base64_data": encoded()})).isError
        assert text(await client.call_tool("search", {"query": "sample", "limit": 1})).startswith("- Sample |")
        assert text(await client.call_tool("search", {"query": "sample", "limit": 1, "offset": 1})).startswith("- sample landscape |")
        assert not (await client.call_tool("addalias", {"name": "SAMPLE", "aliases": ["风景"]})).isError
        for arguments in [
            {"name": "x"}, {"name": "x", "url": "https://example.com/x", "base64_data": encoded()},
            {"name": "   ", "base64_data": encoded()}, {"name": "x", "base64_data": "%%%"},
            {"name": "x", "base64_data": encoded(b"<svg><script/></svg>")},
            {"name": "x", "base64_data": encoded(picture()[:25])},
            {"name": "x", "base64_data": encoded(), "aliases": [" "]},
            {"name": "x", "base64_data": encoded(), "aliases": ["x"] * 33},
        ]:
            assert (await client.call_tool("add", arguments)).isError, arguments
        assert (await client.call_tool("search", {"limit": 101})).isError
        assert (await client.call_tool("search", {"offset": -1})).isError
        assert (await client.call_tool("addalias", {"name": "Sample", "aliases": []})).isError
        assert (await client.call_tool("addalias", {"name": "missing", "aliases": ["x"]})).isError


@pytest.mark.asyncio
async def test_auth_host_origin_and_body_limits(tmp_path, monkeypatch):
    async with connected(tmp_path) as (_, public):
        for headers in [{}, {"Authorization": "Bearer wrong"}]:
            assert (await public.post("/mcp", json={}, headers=headers)).status_code == 401
            assert (await public.post("/mcp/", json={}, headers=headers)).status_code == 401
        assert (await public.post("/mcp?token=wrong", json={})).status_code == 401
        assert (await public.post(f"/mcp?token={TOKEN}", json={},
                                  headers={"Authorization": "Bearer wrong"})).status_code == 401
        assert (await public.get("/health")).status_code == 200
        headers = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json, text/event-stream"}
        for extra in [{"Host": "evil.example"}, {"Origin": "https://evil.example"}]:
            response = await public.post("/mcp", json={}, headers=headers | extra)
            assert response.status_code in {403, 421}
        monkeypatch.setattr(server, "MAX_REQUEST_BYTES", 100)
        assert (await public.post("/mcp", content=b"x" * 101, headers=headers)).status_code == 413

        async def chunks():
            yield b"x" * 60
            yield b"x" * 60

        assert (await public.post("/mcp", content=chunks(), headers=headers)).status_code == 413


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "ftp://example.com/x", "data:image/png;base64,AA==", "http:///x",
])
def test_download_requires_http_url(url):
    with pytest.raises(ValueError):
        server.download_url(url)


@pytest.mark.parametrize("url", [
    "https://user:pass@example.com/x", "http://localhost/x", "http://127.0.0.1/x",
    "http://192.168.1.1/x", "http://[::1]/x", "http://[64:ff9b::808:808]/x",
])
def test_no_extra_download_url_restrictions(url):
    assert str(server.download_url(url)) == url


@pytest.mark.asyncio
async def test_download_total_timeout(monkeypatch):
    wait_for = asyncio.wait_for
    cancelled = False

    async def slow_download(value):
        nonlocal cancelled
        try:
            await asyncio.sleep(60)
        finally:
            cancelled = True

    async def short_wait(awaitable, timeout):
        assert timeout == 30
        return await wait_for(awaitable, 0.01)

    monkeypatch.setattr(server, "_download_image", slow_download)
    monkeypatch.setattr(server.asyncio, "wait_for", short_wait)
    with pytest.raises(ValueError, match="下载超时"):
        await server.download_image("https://example.com/image")
    assert cancelled


class DownloadResponse:
    def __init__(self, status=200, data=b"", location=None, size=None):
        self.status = status
        self.headers = {"Location": location} if location else {}
        self.content_length = size
        self.data = data
        self.content = self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def iter_chunked(self, size):
        for start in range(0, len(self.data), size):
            yield self.data[start:start + size]


def fake_download(monkeypatch, responses, requested):
    class Session:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        def get(self, url, **kwargs):
            assert kwargs["allow_redirects"] is False
            requested.append(str(url))
            return responses.pop(0)

    monkeypatch.setattr(server.aiohttp, "ClientSession", Session)


@pytest.mark.asyncio
async def test_download_and_mcp_url_add(tmp_path, monkeypatch):
    requested = []
    fake_download(monkeypatch, [DownloadResponse(302, location="/actual.png"),
                               DownloadResponse(data=picture())], requested)
    async with connected(tmp_path) as (client, public):
        result = await client.call_tool("add", {"name": "URL 图片", "url": "https://example.com/image"})
        assert not result.isError
        assert requested == ["https://example.com/image", "https://example.com/actual.png"]
        assert (await public.get(text(result).split(" | ")[-1])).content == picture()


@pytest.mark.asyncio
async def test_download_redirect_and_size_limits(monkeypatch):
    requested = []
    fake_download(monkeypatch, [DownloadResponse(302, location="http://127.0.0.1/image"),
                               DownloadResponse(data=b"image")], requested)
    assert await server.download_image("https://example.com/image") == b"image"
    assert requested == ["https://example.com/image", "http://127.0.0.1/image"]
    monkeypatch.setattr(server, "MAX_IMAGE_BYTES", 100)
    for response in [DownloadResponse(size=101), DownloadResponse(data=b"x" * 101)]:
        fake_download(monkeypatch, [response], [])
        with pytest.raises(ValueError, match="10 MiB"):
            await server.download_image("https://example.com/image")
    fake_download(monkeypatch, [DownloadResponse(404)], [])
    with pytest.raises(ValueError, match="HTTP 404"):
        await server.download_image("https://example.com/image")
    fake_download(monkeypatch, [DownloadResponse(302, location="/loop")] * 6, [])
    with pytest.raises(ValueError, match="超过 5 次"):
        await server.download_image("https://example.com/image")


@pytest.mark.asyncio
@pytest.mark.parametrize("location", ["file:///etc/passwd", "ftp://example.com/x"])
async def test_each_redirect_url_is_checked(monkeypatch, location):
    requested = []
    fake_download(monkeypatch, [DownloadResponse(302, location="/next"),
                               DownloadResponse(302, location=location)], requested)
    with pytest.raises(ValueError):
        await server.download_image("https://example.com/image")
    assert requested == ["https://example.com/image", "https://example.com/next"]


@pytest.mark.asyncio
async def test_five_redirects_are_allowed(monkeypatch):
    requested = []
    responses = [DownloadResponse(302, location=f"/step-{i}") for i in range(5)]
    fake_download(monkeypatch, responses + [DownloadResponse(data=b"image")], requested)
    assert await server.download_image("https://example.com/image") == b"image"
    assert len(requested) == 6


def test_concurrent_alias_updates_and_duplicate_names(tmp_path):
    library = server.ImageLibrary(tmp_path, ORIGIN)
    library.add("sample", [], "", picture())
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda i: library.addalias("sample", [f"别名{i}"]), range(20)))
    result = library.search("sample", 20, 0)
    for i in range(20):
        assert f"别名{i}" in result
    with pytest.raises(ValueError, match="32"):
        library.addalias("sample", [f"更多{i}" for i in range(20)])
    assert library.search("sample", 20, 0) == result
    with pytest.raises(ValueError, match="已存在"):
        library.add("SAMPLE", [], "", picture())


@pytest.mark.parametrize("origin,token", [
    ("", TOKEN), ("https://example.com/path", TOKEN), ("https://example.com?x=1", TOKEN),
    ("https://user@example.com", TOKEN), (ORIGIN, ""), (ORIGIN, "short"),
])
def test_invalid_startup_settings(tmp_path, origin, token):
    with pytest.raises(ValueError):
        server.build_app(ORIGIN + "/mcp", origin, token, tmp_path)


@pytest.mark.asyncio
async def test_separate_domains_and_custom_mcp_path(tmp_path):
    app = server.build_app(ORIGIN + "/mcp/images", IMAGE_ORIGIN, TOKEN, tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as http:
            assert (await http.post(ORIGIN + "/mcp/images", json={})).status_code == 401
            assert (await http.post(ORIGIN + "/mcp", json={})).status_code == 404
            async with streamable_http_client(ORIGIN + "/mcp/images?token=" + TOKEN, http_client=http) as (read, write, _):
                async with ClientSession(read, write) as client:
                    await client.initialize()
                    result = await client.call_tool("add", {"name": "分域测试", "base64_data": encoded()})
                    assert not result.isError
                    url = text(result).split(" | ")[-1]
                    assert url.startswith(IMAGE_ORIGIN + "/images/")
                    assert (await http.get(url)).content == picture()
