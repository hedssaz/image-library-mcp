import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

const bundle = await build({
  entryPoints: ["ui/viewer.js"], bundle: true, write: false,
  format: "iife", platform: "browser", target: "es2022",
  minify: true, legalComments: "inline",
});
const script = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await writeFile("viewer.html", `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>图片</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body, #app { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: transparent; }
body { font: 14px/1.5 system-ui, sans-serif; }
#app { display: flex; align-items: center; justify-content: flex-start; padding-inline-start: 2.5em; }
img { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; object-position: left center; }
p { margin: 0; padding: 8px; color: var(--color-text-secondary, #777); }
[hidden] { display: none !important; }
</style>
</head>
<body>
<figure id="app">
<img id="image" alt="图片" referrerpolicy="no-referrer" hidden>
<p id="status" role="status">正在等待图片…</p>
</figure>
<script>${script}</script>
</body>
</html>
`);
console.log("Built self-contained viewer.html");
