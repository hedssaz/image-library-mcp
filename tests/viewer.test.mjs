import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../ui/viewer.js", import.meta.url), "utf8")
  .replace(/^import .*\n/, "");
const picture = { name: "Test", url: "https://example.test/image.png", width: 800, height: 800 };

function viewer(customSize = true, viewportWidth = 440) {
  const heights = [];
  const timers = new Map();
  const listeners = {};
  let now = 0;
  let nextTimer = 0;
  let context;
  let instance;
  let finishConnect;
  const image = {
    hidden: true, complete: false, naturalWidth: 0, style: {},
    removeAttribute() { this.src = ""; this.complete = false; this.naturalWidth = 0; },
  };
  const status = { hidden: false, textContent: "waiting" };
  const document = {
    documentElement: { clientWidth: viewportWidth },
    getElementById: id => id === "image" ? image : id === "status" ? status : {},
  };
  class App {
    constructor() { instance = this; }
    connect() { return new Promise(resolve => { finishConnect = resolve; }); }
    getHostContext() { return context; }
    sendSizeChanged({ height }) { heights.push(height); return Promise.resolve(); }
  }
  vm.runInNewContext(customSize ? source : source.replace("const CUSTOM_SIZE = true", "const CUSTOM_SIZE = false"), {
    App, console, document,
    getComputedStyle: () => ({ paddingLeft: "18.2px", paddingRight: "0px" }),
    window: { addEventListener: (name, handler) => { listeners[name] = handler; } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    heights, image, status, timers,
    async initialize(value) { context = value; finishConnect(); await Promise.resolve(); },
    receive(data = picture) { instance.ontoolresult({ structuredContent: data }); },
    contextChanged(value) { context = { ...context, ...value }; instance.onhostcontextchanged(value); },
    loaded() { image.complete = true; image.naturalWidth = 800; image.onload(); },
    resize(width) { document.documentElement.clientWidth = width; listeners.resize(); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    },
  };
}

test("width 0 waits briefly, then a valid host width displays the loaded image", async () => {
  const v = viewer();
  await v.initialize({ containerDimensions: { maxWidth: 0 } });
  v.receive(); v.loaded(); v.advance(299);
  assert.deepEqual(v.heights, []);
  assert.equal(v.image.hidden, true);
  v.contextChanged({ containerDimensions: { maxWidth: 440 } });
  assert.deepEqual(v.heights, [150]);
  assert.equal(v.image.hidden, false);
  assert.equal(v.timers.size, 0);
  v.advance(1000);
  assert.deepEqual(v.heights, [150]);
});

test("width stuck at zero falls back to actual viewport minus inset after 300ms", async () => {
  const v = viewer(true, 100);
  await v.initialize({ containerDimensions: { maxWidth: 0 } });
  v.receive(); v.loaded();
  v.advance(200);
  v.contextChanged({ containerDimensions: { maxWidth: 0 } });
  v.advance(100);
  assert.deepEqual(v.heights, [82]);
  assert.equal(v.image.hidden, false);
  assert.equal(v.image.style.maxWidth, "min(100%, 82px)");
});

test("zero host and viewport widths still request a positive preferred height", async () => {
  const v = viewer(true, 0);
  await v.initialize({ containerDimensions: { maxWidth: 0, height: 0 } });
  v.receive(); v.loaded(); v.advance(300);
  assert.deepEqual(v.heights, [150]);
  v.resize(100);
  assert.deepEqual(v.heights, [150, 82]);
  v.resize(440);
  assert.deepEqual(v.heights, [150, 82, 150]);
});

test("a host width arriving long after fallback still resizes the image", async () => {
  const v = viewer();
  await v.initialize({ containerDimensions: { maxWidth: 0 } });
  v.receive(); v.loaded(); v.advance(5000);
  assert.deepEqual(v.heights, [150]);
  v.contextChanged({ containerDimensions: { maxWidth: 100 } });
  assert.deepEqual(v.heights, [150, 82]);
});

test("omitted widths are unbounded and do not start a wait timer", async () => {
  for (const context of [{}, { containerDimensions: { maxHeight: 100 } }]) {
    const v = viewer();
    await v.initialize(context);
    v.receive(); v.loaded();
    assert.equal(v.image.hidden, false);
    assert.equal(v.timers.size, 0);
    assert.deepEqual(v.heights, [context.containerDimensions ? 100 : 150]);
  }
});

test("image and host context can arrive in either order without pre-connect reports", async () => {
  const v = viewer();
  v.receive(); v.loaded(); v.advance(1000);
  assert.deepEqual(v.heights, []);
  await v.initialize({ containerDimensions: { width: 440 } });
  assert.deepEqual(v.heights, [150]);
  assert.equal(v.image.hidden, false);
});

test("declared height caps are honored and height-only cap changes relayout", async () => {
  const v = viewer();
  await v.initialize({ containerDimensions: { maxWidth: 440, maxHeight: 90 } });
  v.receive({ ...picture, width: 400, height: 800 }); v.loaded();
  assert.equal(v.image.style.maxWidth, "min(100%, 45px)");
  assert.deepEqual(v.heights, [90]);
  v.contextChanged({ containerDimensions: { maxWidth: 440, maxHeight: 60 } });
  assert.equal(v.image.style.maxWidth, "min(100%, 30px)");
  assert.deepEqual(v.heights, [90, 60]);
  v.contextChanged({ containerDimensions: { maxWidth: 440 } });
  assert.deepEqual(v.heights, [90, 60, 150]);
});

test("fixed height constrains the image without requesting a different frame height", async () => {
  const v = viewer();
  await v.initialize({ containerDimensions: { width: 440, height: 100 } });
  v.receive(); v.loaded();
  assert.equal(v.image.style.maxHeight, "min(100%, 100px)");
  assert.deepEqual(v.heights, []);
  v.contextChanged({ containerDimensions: { width: 440, height: 50 } });
  assert.equal(v.image.style.maxHeight, "min(100%, 50px)");
  assert.deepEqual(v.heights, []);
});

test("size feedback and browser height-only resize do not cause a notification loop", async () => {
  const v = viewer();
  await v.initialize({ containerDimensions: { maxWidth: 440 } });
  v.receive(); v.loaded();
  v.contextChanged({ containerDimensions: { maxWidth: 440, height: 150 } });
  v.resize(440);
  v.contextChanged({ containerDimensions: { height: 0 } });
  assert.deepEqual(v.heights, [150]);
  v.contextChanged({ containerDimensions: { maxWidth: 100 } });
  v.contextChanged({ containerDimensions: { maxWidth: 100, height: 82 } });
  v.contextChanged({ containerDimensions: { maxWidth: 440 } });
  assert.deepEqual(v.heights, [150, 82, 150]);
});

test("invalid widths use the same bounded wait and never report zero", async () => {
  for (const width of [-1, NaN, Infinity]) {
    const v = viewer();
    await v.initialize({ containerDimensions: { maxWidth: width } });
    v.receive(); v.loaded(); v.advance(300);
    assert.deepEqual(v.heights, [150]);
  }
});

test("small images are not enlarged and extreme ratios never report height 0", async () => {
  const v = viewer();
  await v.initialize({ containerDimensions: { maxWidth: 440 } });
  v.receive({ ...picture, width: 80, height: 60 }); v.loaded();
  assert.deepEqual(v.heights, [60]);
  assert.equal(v.image.style.maxWidth, "min(100%, 80px)");
  v.receive({ ...picture, width: 10000, height: 1 }); v.loaded();
  assert.deepEqual(v.heights, [60, 1]);
});

test("CUSTOM_SIZE=false never reports sizes, including timeout fallback", async () => {
  const v = viewer(false);
  await v.initialize({ containerDimensions: { maxWidth: 0 } });
  v.receive(); v.loaded(); v.advance(300);
  assert.equal(v.image.style.maxWidth, "min(100%, 300px)");
  assert.equal(v.image.hidden, false);
  v.contextChanged({ containerDimensions: { maxWidth: 440, maxHeight: 80 } });
  assert.equal(v.image.style.maxHeight, "min(100%, 80px)");
  assert.deepEqual(v.heights, []);
});

test("errors cancel pending waits and cannot be redisplayed by later updates", async () => {
  for (const fail of [v => v.receive(null), v => v.image.onerror()]) {
    const v = viewer();
    await v.initialize({ containerDimensions: { maxWidth: 0 } });
    v.receive(); v.loaded(); fail(v); v.advance(1000);
    v.contextChanged({ containerDimensions: { maxWidth: 100 } });
    assert.equal(v.image.hidden, true);
    assert.equal(v.timers.size, 0);
    assert.deepEqual(v.heights, []);
  }
});
