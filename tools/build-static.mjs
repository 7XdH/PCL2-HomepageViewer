import fs from "node:fs";
import path from "node:path";
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

console.log(`Static site built to ${path.relative(ROOT, OUT)}`);
