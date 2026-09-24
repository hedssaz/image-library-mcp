import { App } from "@modelcontextprotocol/ext-apps";

const CUSTOM_SIZE = true;
const PREFERRED_IMAGE_SIZE = 150;
const image = document.getElementById("image");
const status = document.getElementById("status");
const app = new App({ name: "Image Viewer", version: "1.0.0" }, {}, { autoResize: false });
let currentImage = null;
let hostMaxWidth = 0;
let lastReportedHeight = null;

function showStatus(message) {
  image.hidden = true;
  image.removeAttribute("src");
  status.textContent = message;
  status.hidden = false;
}

function updateHostWidth(context) {
  const dimensions = context?.containerDimensions;
  const width = dimensions?.maxWidth ?? dimensions?.width;
  if (!Number.isFinite(width) || width <= 0 || width === hostMaxWidth) return false;
  hostMaxWidth = width;
  return true;
}

function tryLayout() {
  if (!currentImage || hostMaxWidth <= 0) return;
  const preferred = CUSTOM_SIZE ? PREFERRED_IMAGE_SIZE : 300;
  const scale = Math.min(1, preferred / currentImage.width, preferred / currentImage.height,
    hostMaxWidth / currentImage.width);
  const size = {
    width: Math.max(1, Math.round(currentImage.width * scale)),
    height: Math.max(1, Math.round(currentImage.height * scale)),
  };
  image.style.maxWidth = `min(100%, ${size.width}px)`;
  image.style.maxHeight = `min(100%, ${size.height}px)`;
  if (image.complete && image.naturalWidth > 0) {
    status.hidden = true;
    image.hidden = false;
  }
  if (CUSTOM_SIZE && size.height !== lastReportedHeight) {
    lastReportedHeight = size.height;
    app.sendSizeChanged({ height: size.height }).catch(error => console.error("图片卡片尺寸协商失败", error));
  }
}

image.onload = tryLayout;
image.onerror = () => {
  currentImage = null;
  showStatus("图片加载失败，请重新选择图片。");
};

// Register before connecting: the host can deliver the result immediately.
app.ontoolresult = (result) => {
  const data = result.structuredContent;
  if (result.isError || typeof data?.url !== "string" || !(data.width > 0) || !(data.height > 0)) {
    currentImage = null;
    showStatus("没有找到这张图片。");
    return;
  }
  currentImage = data;
  showStatus("正在加载图片…");
  image.alt = data.name || "图片";
  image.src = data.url;
  updateHostWidth(app.getHostContext());
  tryLayout();
};

app.onhostcontextchanged = (context) => {
  if (updateHostWidth(context)) tryLayout();
};

app.connect().then(() => {
  updateHostWidth(app.getHostContext());
  tryLayout();
}).catch(() => showStatus("无法连接图片查看器，请重新打开图片。"));
