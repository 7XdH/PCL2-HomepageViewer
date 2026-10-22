import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist");
const ENTRIES = [
  "index.html",
  "css",
  "js",
  "assets",
  ".nojekyll",
  "LICENSE",
  "LICENCE-PCL.md"
];

function walkEntry(absolute, relative, visit) {
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) {
      walkEntry(path.join(absolute, name), `${relative}/${name}`, visit);
    }
    return;
  }
  if (stat.isFile()) visit(absolute, relative);
}

function createBuildId() {
  const hash = crypto.createHash("sha256");
  for (const entry of ENTRIES) {
    const absolute = path.join(ROOT, entry);
    if (!fs.existsSync(absolute)) throw new Error(`缺少静态文件：${entry}`);
    walkEntry(absolute, entry, (file, relative) => {
      hash.update(relative.replaceAll("\\", "/"));
      hash.update(fs.readFileSync(file));
    });
  }
  return hash.digest("hex").slice(0, 12);
}

function addCacheVersion(file) {
  const absolute = path.join(OUT, file);
  if (!fs.existsSync(absolute)) return;
  const original = fs.readFileSync(absolute, "utf8");
  const rewritten = original.replace(
    /(\b(?:href|src)=["'])([^"']+?\.(?:css|js|mjs))(?:\?v=[^"']*)?(["'])/g,
    (match, prefix, url, suffix) => {
      if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url) || url.startsWith("data:") || url.startsWith("#")) {
        return match;
      }
      return `${prefix}${url}?v=${BUILD_ID}${suffix}`;
    }
  );
  if (rewritten !== original) fs.writeFileSync(absolute, rewritten);
}

function addModuleCacheVersions(file) {
  const absolute = path.join(OUT, file);
  if (!fs.existsSync(absolute)) return;
  const original = fs.readFileSync(absolute, "utf8");
  const rewritten = original.replace(
    /(["'])(\.{1,2}\/[^"']+?\.js)(?:\?v=[^"']*)?\1/g,
    (match, quote, url) => `${quote}${url}?v=${BUILD_ID}${quote}`
  );
  if (rewritten !== original) fs.writeFileSync(absolute, rewritten);
}

const BUILD_ID = createBuildId();

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const entry of ENTRIES) {
  const source = path.join(ROOT, entry);
  if (!fs.existsSync(source)) {
    throw new Error(`缺少静态文件：${entry}`);
  }
  fs.cpSync(source, path.join(OUT, entry), { recursive: true });
}

addCacheVersion("index.html");
for (const file of fs.readdirSync(path.join(OUT, "js"))) {
  if (file.endsWith(".js")) addModuleCacheVersions(`js/${file}`);
}

try {
  const output = execFileSync("git", ["log", "-1", "--format=%cI%n%H"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true
  }).trim();
  const [date, sha] = output.split(/\r?\n/);
  if (date && sha) {
    fs.writeFileSync(
      path.join(OUT, "commit.json"),
      `${JSON.stringify({ date, sha, source: "build" }, null, 2)}\n`
    );
  }
} catch {
  console.warn("未生成 commit.json：当前目录没有可用的 git 历史。");
}

console.log(`Static site built to ${path.relative(ROOT, OUT)} (build ${BUILD_ID})`);
