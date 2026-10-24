import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findBrowser } from "./browser-path.mjs";

// Smoke test for the static build. `tools/build-static.mjs` only copies files,
// so a missing entry, a broken ?v= stamp or a module import that points at a
// file nobody shipped would go unnoticed until someone opened the deployed site.
// This runs the same build the CI uploads and checks it actually renders.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const REQUIRED = [
  "index.html",
  "home.html",
  "commit.json",
  ".nojekyll",
  "css/app.css",
  "css/pcl-theme.css",
  "css/xaml.css",
  "css/appearance.css",
  "js/app.js",
  "js/home.js",
  "js/boot.js",
  "js/boot-theme.js",
  "js/renderer.js",
  "assets/presets/tutorial.xaml",
  "assets/pcl/fonts/PCL-English.ttf"
];

const failures = [];
const fail = (message) => failures.push(message);

const assertFile = (relative) => {
  const absolute = path.join(DIST, relative);
  if (!fs.existsSync(absolute)) {
    fail(`构建产物缺少 ${relative}`);
    return null;
  }
  return fs.readFileSync(absolute, "utf8");
};

// Every *relative* import in the shipped bundles must also be shipped. Node's
// static build copies whole directories, so this mostly guards against a module
// that reaches outside them.
const checkModuleGraph = () => {
  const seen = new Set();
  const pending = ["js/app.js", "js/home.js"];
  while (pending.length) {
    const relative = pending.pop();
    if (seen.has(relative)) continue;
    seen.add(relative);
    const source = assertFile(relative);
    if (source == null) continue;
    const pattern = /(?:^|[^\w$])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] || match[2];
      if (!specifier || !specifier.startsWith(".")) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier.split("?")[0]));
      if (!fs.existsSync(path.join(DIST, target))) fail(`${relative} 导入了未发布的模块 ${target}`);
      else pending.push(target);
    }
  }
  return seen.size;
};

// `?v=` is what Busts stale CDN copies; an entry that misses it can be served
// from cache after a deploy.
const checkCacheStamps = () => {
  for (const document of ["index.html", "home.html"]) {
    const html = assertFile(document);
    if (html == null) continue;
    const stamped = [...html.matchAll(/\b(?:href|src)=["']([^"']+\.(?:css|js))(\?v=([0-9a-f]+))?["']/g)];
    if (!stamped.length) {
      fail(`${document} 没有引用任何本地样式或脚本`);
      continue;
    }
    const buildIds = new Set();
    for (const [, url, query, id] of stamped) {
      if (!query) fail(`${document} 的 ${url} 缺少 ?v= 构建戳`);
      else buildIds.add(id);
      if (!fs.existsSync(path.join(DIST, url))) fail(`${document} 引用了未发布的 ${url}`);
    }
    if (buildIds.size > 1) fail(`${document} 混用了多个构建戳：${[...buildIds].join(", ")}`);
  }
};

// The renderer writes cards into #pclHomeRoot; if the boot fallback is still up
// or the render threw, the dumped DOM shows it.
const checkRenderedDom = async (browserPath, baseUrl, document, rootSelector) => {
  const profile = fs.mkdtempSync(path.join(ROOT, "test-results", ".smoke-"));
  try {
    const dom = await new Promise((resolve, reject) => {
      execFile(
        browserPath,
        [
          "--headless=new",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-default-browser-check",
          ...(process.platform !== "win32" ? ["--no-sandbox"] : []),
          `--user-data-dir=${profile}`,
          "--dump-dom",
          "--virtual-time-budget=12000",
          `${baseUrl}${document}`
        ],
        { timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (error, stdout) => (error && !stdout ? reject(error) : resolve(stdout))
      );
    });
    if (!dom.includes(rootSelector.replace(/^#/, 'id="'))) {
      fail(`${document} 的 DOM 里没有 ${rootSelector}`);
    }
    const cards = (dom.match(/pcl-card__header/g) || []).length;
    if (cards < 4) fail(`${document} 只渲染出 ${cards} 张卡片，教程主页应有更多`);
    if (dom.includes("不支持的控件类型")) fail(`${document} 出现了不支持控件的占位`);
    if (/id="bootFallback"[^>]*>/.test(dom) && !/id="bootFallback"[^>]*hidden/.test(dom)) {
      fail(`${document} 的启动兵底没有隐藏，说明首帧没有完成`);
    }
    return cards;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
};

const startStaticServer = () =>
  new Promise((resolve) => {
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".xaml": "application/xml; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ttf": "font/ttf",
      ".woff2": "font/woff2",
      ".ico": "image/x-icon"
    };
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^\/+/, "");
      const target = path.resolve(DIST, relative);
      if (!target.startsWith(DIST + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        response.writeHead(404).end("Not Found");
        return;
      }
      response.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream" });
      response.end(fs.readFileSync(target));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const main = async () => {
  if (!fs.existsSync(DIST)) {
    console.error("dist 不存在，请先运行 npm run build");
    process.exitCode = 1;
    return;
  }

  for (const relative of REQUIRED) assertFile(relative);
  const modules = checkModuleGraph();
  checkCacheStamps();

  const browserPath = findBrowser();
  let cards = null;
  if (!browserPath) {
    // CI installs one; a developer machine without a browser can still check
    // the file and module graph parts.
    console.warn("未找到 Edge / Chrome，跳过渲染烟雾测试（可用 PCL_TEST_BROWSER 指定）。");
  } else {
    const server = await startStaticServer();
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}/`;
      const indexCards = await checkRenderedDom(browserPath, baseUrl, "", "#pclHomeRoot");
      const homeCards = await checkRenderedDom(browserPath, baseUrl, "home.html", "#homeRoot");
      cards = { index: indexCards, home: homeCards };
    } finally {
      server.close();
    }
  }

  if (failures.length) {
    console.error("[构建烟雾测试]");
    for (const message of failures) console.error(`FAIL  ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[构建烟雾测试] PASS 模块 ${modules} 个${cards ? `，卡片 index=${cards.index} home=${cards.home}` : ""}`);
};

main().catch((error) => {
  console.error(`构建烟雾测试失败：${error?.stack || error}`);
  process.exitCode = 1;
});
