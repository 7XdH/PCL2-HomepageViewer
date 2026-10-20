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

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const entry of ENTRIES) {
  const source = path.join(ROOT, entry);
  if (!fs.existsSync(source)) {
    throw new Error(`缺少静态文件：${entry}`);
  }
  fs.cpSync(source, path.join(OUT, entry), { recursive: true });
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

console.log(`Static site built to ${path.relative(ROOT, OUT)}`);
