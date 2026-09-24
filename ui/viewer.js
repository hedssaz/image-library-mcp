import { App } from "@modelcontextprotocol/ext-apps";

const CUSTOM_SIZE = true;
const PREFERRED_IMAGE_SIZE = 150;
const image = document.getElementById("image");
const status = document.getElementById("status");
const container = document.getElementById("app");
const app = new App({ name: "Image Viewer", version: "1.0.0" }, {}, { autoResize: false });
let currentImage = null;
let connected = false;
let widthWaitTimer;
let widthWaitExpired = false;
let lastReportedHeight = null;

function showStatus(message) {
  clearTimeout(widthWaitTimer);
  widthWaitTimer = undefined;
  image.hidden = true;
  image.removeAttribute("src");
  status.textContent = message;
  status.hidden = false;
}

function positive(value) {
  return Number.isFinite(value) && value > 0;
}

function tryLayout() {
  if (!currentImage || !connected) return;
  const dimensions = app.getHostContext()?.containerDimensions ?? {};
  const hostWidth = dimensions.width ?? dimensions.maxWidth;
  // Missing width is unbounded. An explicit zero may be transient during mounting.
  if (hostWidth != null && !positive(hostWidth) && !widthWaitExpired) {
    if (widthWaitTimer === undefined) {
      widthWaitTimer = setTimeout(() => {
        widthWaitTimer = undefined;
        widthWaitExpired = true;
        tryLayout();
      }, 300);
    }
    return;
  }
  clearTimeout(widthWaitTimer);
  widthWaitTimer = undefined;

  const style = getComputedStyle(container);
  const inset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const viewportWidth = document.documentElement.clientWidth;
  const maxWidth = Math.max(1, Math.min(
    positive(hostWidth) ? hostWidth : Infinity,
    positive(viewportWidth) ? viewportWidth : Infinity,
  ) - inset);
  const hostHeight = dimensions.height ?? dimensions.maxHeight;
  // A flexible iframe's current height is our output, not a sizing constraint.
  const maxHeight = positive(hostHeight) ? hostHeight : Infinity;
  const preferred = CUSTOM_SIZE ? PREFERRED_IMAGE_SIZE : 300;
  const scale = Math.min(1, preferred / currentImage.width, preferred / currentImage.height,
    maxWidth / currentImage.width, maxHeight / currentImage.height);
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
  if (CUSTOM_SIZE && !positive(dimensions.height) && size.height !== lastReportedHeight) {
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
  widthWaitExpired = false;
  showStatus("正在加载图片…");
  image.alt = data.name || "图片";
  image.src = data.url;
  tryLayout();
};

app.onhostcontextchanged = tryLayout;
window.addEventListener("resize", tryLayout);

app.connect().then(() => {
  connected = true;
  tryLayout();
}).catch(() => showStatus("无法连接图片查看器，请重新打开图片。"));
