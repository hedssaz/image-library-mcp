import { App } from "@modelcontextprotocol/ext-apps";

const CUSTOM_SIZE = true;
const PREFERRED_IMAGE_SIZE = 200;
const image = document.getElementById("image");
const status = document.getElementById("status");
const app = new App({ name: "Image Viewer", version: "1.0.0" }, {}, { autoResize: false });
let sizeNegotiated = false;

function showStatus(message) {
  image.hidden = true;
  image.removeAttribute("src");
  status.textContent = message;
  status.hidden = false;
}

image.onload = () => {
  status.hidden = true;
  image.hidden = false;
};
image.onerror = () => showStatus("图片加载失败，请重新选择图片。");

// Register before connecting: the host can deliver the result immediately.
app.ontoolresult = (result) => {
  const data = result.structuredContent;
  if (result.isError || typeof data?.url !== "string" || !(data.width > 0) || !(data.height > 0)) {
    showStatus("没有找到这张图片。");
    return;
  }
  showStatus("正在加载图片…");
  const host = CUSTOM_SIZE ? app.getHostContext()?.containerDimensions : undefined;
  const preferred = CUSTOM_SIZE ? PREFERRED_IMAGE_SIZE : 300;
  const maxWidth = Math.min(preferred, host?.maxWidth ?? host?.width ?? preferred);
  const maxHeight = Math.min(preferred, host?.maxHeight ?? host?.height ?? preferred);
  const scale = Math.min(1, maxWidth / data.width, maxHeight / data.height);
  const size = { width: Math.round(data.width * scale), height: Math.round(data.height * scale) };
  image.style.width = `${size.width}px`;
  image.style.height = `${size.height}px`;
  image.alt = data.name || "图片";
  image.src = data.url;
  if (CUSTOM_SIZE && !sizeNegotiated) {
    sizeNegotiated = true;
    app.sendSizeChanged({ height: size.height }).catch(error => console.error("图片卡片尺寸协商失败", error));
  }
};

app.connect().catch(() => showStatus("无法连接图片查看器，请重新打开图片。"));
