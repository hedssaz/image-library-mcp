import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../ui/viewer.js", import.meta.url), "utf8")
  .replace(/^import .*\n/, "");
const picture = { name: "Test", url: "https://example.test/image.png", width: 800, height: 800 };

function viewer(customSize = true) {
  const heights = [];
  let context;
  let instance;
  let finishConnect;
  const image = {
    hidden: true, complete: false, naturalWidth: 0, style: {},
    removeAttribute() { this.src = ""; this.complete = false; this.naturalWidth = 0; },
  };
  const status = { hidden: false, textContent: "waiting" };
  class App {
    constructor() { instance = this; }
    connect() { return new Promise(resolve => { finishConnect = resolve; }); }
    getHostContext() { return context; }
    sendSizeChanged({ height }) { heights.push(height); return Promise.resolve(); }
  }
  vm.runInNewContext(customSize ? source : source.replace("const CUSTOM_SIZE = true", "const CUSTOM_SIZE = false"), {
    App, console, document: { getElementById: id => id === "image" ? image : status },
  });
  return {
    heights, image, status,
    async initialize(value) { context = value; finishConnect(); await Promise.resolve(); },
    receive(data = picture) { instance.ontoolresult({ structuredContent: data }); },
    contextChanged(value) { context = { ...context, ...value }; instance.onhostcontextchanged(value); },
    loaded() { image.complete = true; image.naturalWidth = 800; image.onload(); },
  };
}

test("image arriving at width 0 waits, then lays out when the host supplies 440", async () => {
  const v = viewer();
  await v.initialize({ containerDimensions: { maxWidth: 0 } });
  v.receive();
  v.loaded();
  assert.deepEqual(v.heights, []);
  assert.equal(v.image.hidden, true);
  v.contextChanged({ containerDimensions: { maxWidth: 440 } });
  assert.deepEqual(v.heights, [150]);
  assert.equal(v.image.style.maxWidth, "min(100%, 150px)");
  assert.equal(v.image.hidden, false);
});

test("host width may arrive before the image", async () => {
  const v = viewer();
  await v.initialize({ containerDimensions: { width: 440 } });
  assert.deepEqual(v.heights, []);
  v.receive();
  v.loaded();
  assert.deepEqual(v.heights, [150]);
  assert.equal(v.image.hidden, false);
});

test("image may arrive before initialization completes", async () => {
  const v = viewer();
  v.receive();
  v.loaded();
  assert.deepEqual(v.heights, []);
  await v.initialize({ containerDimensions: { maxWidth: 440 } });
  assert.deepEqual(v.heights, [150]);
  assert.equal(v.image.hidden, false);
});

test("width changes relayout; duplicate widths and height feedback do not loop", async () => {
  const v = viewer();
  await v.initialize({ containerDimensions: { maxWidth: 440 } });
  v.receive(); v.loaded();
  v.contextChanged({ containerDimensions: { maxWidth: 440, height: 150 } });
  v.contextChanged({ containerDimensions: { height: 0 } });
  assert.deepEqual(v.heights, [150]);
  v.contextChanged({ containerDimensions: { maxWidth: 100 } });
  v.contextChanged({ containerDimensions: { maxWidth: 100, height: 100 } });
  assert.deepEqual(v.heights, [150, 100]);
  v.contextChanged({ containerDimensions: { maxWidth: 440 } });
  v.receive(); v.loaded();
  assert.deepEqual(v.heights, [150, 100, 150]);
});

test("unavailable or invalid widths never produce a size report", async () => {
  const v = viewer();
  await v.initialize({});
  v.receive(); v.loaded();
  for (const width of [0, -1, NaN, Infinity]) {
    v.contextChanged({ containerDimensions: { maxWidth: width } });
  }
  assert.deepEqual(v.heights, []);
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

test("CUSTOM_SIZE=false keeps size reports disabled across width changes", async () => {
  const v = viewer(false);
  await v.initialize({ containerDimensions: { maxWidth: 0 } });
  v.receive(); v.loaded();
  v.contextChanged({ containerDimensions: { maxWidth: 440 } });
  assert.equal(v.image.style.maxWidth, "min(100%, 300px)");
  v.contextChanged({ containerDimensions: { maxWidth: 100 } });
  assert.equal(v.image.style.maxWidth, "min(100%, 100px)");
  assert.deepEqual(v.heights, []);
});

test("invalid image results cannot be redisplayed by later host updates", async () => {
  const v = viewer();
  await v.initialize({ containerDimensions: { maxWidth: 440 } });
  v.receive(); v.loaded();
  v.receive(null);
  v.contextChanged({ containerDimensions: { maxWidth: 100 } });
  assert.equal(v.image.hidden, true);
  assert.deepEqual(v.heights, [150]);
});
