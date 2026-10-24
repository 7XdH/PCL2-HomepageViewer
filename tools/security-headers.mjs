import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCUMENT_CSP, baseSecurityHeaders } from "../api/security-headers.js";

// The same CSP and security headers live in four places: the two documents
// (meta tag), the local server, vercel.json and netlify.toml. Keeping them in
// sync by hand drifted twice already, so `api/security-headers.js` is the only
// source and this module both rewrites and verifies the copies.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `frame-ancestors` is header-only: a meta CSP silently ignores it, so it must
// not appear there or it would look enforced while doing nothing.
const hasDirective = (csp, name) => csp.split(";").some((part) => part.trim().startsWith(`${name} `));
const withoutDirective = (csp, name) =>
  csp
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${name} `))
    .join("; ");

export { DOCUMENT_CSP };
export const META_CSP = withoutDirective(DOCUMENT_CSP, "frame-ancestors"); // HSTS is terminated at the edge; the local server speaks plain HTTP on
// 127.0.0.1 and must not advertise it.
export const EDGE_SECURITY_HEADERS = { ...baseSecurityHeaders(), "Strict-Transport-Security": "max-age=31536000" };
// Netlify and Vercel serve the proxy from the same origin, so CORP stays
// same-origin there just like the local server.
const HEADER_ORDER = Object.keys(EDGE_SECURITY_HEADERS);

const EXTRA_VERCEL_HEADERS = [
  { source: "/commit.json", headers: [{ key: "Cache-Control", value: "no-cache" }] },
  { source: "/(.*)\\.xaml", headers: [{ key: "Content-Type", value: "application/xml; charset=utf-8" }] }
];

const escapeToml = (value) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export const readMetaCsp = (file) => {
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  const match = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
  return match ? match[1] : null;
};

export const applyMetaCsp = (file) => {
  const absolute = path.join(ROOT, file);
  const html = fs.readFileSync(absolute, "utf8");
  const next = html.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)/, `$1${META_CSP}$2`);
  if (next !== html) fs.writeFileSync(absolute, next);
  return next !== html;
};

export const buildVercelHeaders = () => [
  {
    source: "/(.*)",
    headers: HEADER_ORDER.map((key) => ({ key, value: EDGE_SECURITY_HEADERS[key] }))
  },
  ...["/", "/index.html", "/home.html"].map((source) => ({
    source,
    headers: [{ key: "Content-Security-Policy", value: DOCUMENT_CSP }]
  })),
  ...EXTRA_VERCEL_HEADERS
];

export const applyVercel = () => {
  const absolute = path.join(ROOT, "vercel.json");
  const original = fs.readFileSync(absolute, "utf8");
  const config = JSON.parse(original);
  // Keep unknown top-level keys; only the headers block is generated.
  const next = `${JSON.stringify({ ...config, headers: buildVercelHeaders() }, null, 2)}\n`;
  if (next !== original) fs.writeFileSync(absolute, next);
  return next !== original;
};

const netlifyHeadersBlock = () => {
  const blocks = [
    ["/*", HEADER_ORDER.map((key) => [key, EDGE_SECURITY_HEADERS[key]])],
    ...["/", "/index.html", "/home.html"].map((for_) => [for_, [["Content-Security-Policy", DOCUMENT_CSP]]]),
    ["/*.xaml", [["Content-Type", "application/xml; charset=utf-8"]]]
  ];
  return blocks
    .map(([for_, values]) => {
      const lines = values.map(([key, value]) => `    ${key} = "${escapeToml(value)}"`);
      return `[[headers]]\n  for = "${for_}"\n  [headers.values]\n${lines.join("\n")}`;
    })
    .join("\n\n");
};

export const readNetlifyPreamble = () => {
  const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  const marker = toml.indexOf("[[headers]]");
  return marker < 0 ? toml.trimEnd() : toml.slice(0, marker).trimEnd();
};

export const applyNetlify = () => {
  const absolute = path.join(ROOT, "netlify.toml");
  const original = fs.readFileSync(absolute, "utf8");
  const next = `${readNetlifyPreamble()}\n\n${netlifyHeadersBlock()}\n`;
  if (next !== original) fs.writeFileSync(absolute, next);
  return next !== original;
};

// Returns one line per inconsistency so the CLI and the unit test share the
// wording.
export const collectDrift = () => {
  const problems = [];

  if (hasDirective(META_CSP, "frame-ancestors")) {
    problems.push("META_CSP 不该包含 frame-ancestors（meta 不支持该指令）");
  }
  if (!hasDirective(DOCUMENT_CSP, "frame-ancestors")) {
    problems.push("DOCUMENT_CSP 缺少 frame-ancestors，响应头就挡不住被 iframe 嵌入了");
  }

  for (const file of ["index.html", "home.html"]) {
    const meta = readMetaCsp(file);
    if (meta == null) problems.push(`${file} 没有 CSP meta`);
    else if (meta !== META_CSP) problems.push(`${file} 的 meta CSP 与 api/security-headers.js 不一致`);
  }

  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  if (/DOCUMENT_CSP|documentSecurityHeaders/.test(server) === false) {
    problems.push("server.js 没有使用共享的 documentSecurityHeaders()");
  }
  if (/Content-Security-Policy"\s*:/.test(server)) {
    problems.push("server.js 里出现了硬编码的 CSP，应改用 api/security-headers.js");
  }

  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const expectedVercel = buildVercelHeaders();
  if (JSON.stringify(vercel.headers) !== JSON.stringify(expectedVercel)) {
    problems.push("vercel.json 的 headers 与生成结果不一致");
  }

  const netlify = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  const expectedNetlify = `${readNetlifyPreamble()}\n\n${netlifyHeadersBlock()}\n`;
  if (netlify !== expectedNetlify) problems.push("netlify.toml 的 [[headers]] 与生成结果不一致");

  // A copy that is merely present is not enough: the edge files must carry the
  // directives the code declares, or a deploy would quietly weaken the policy.
  for (const [label, csp] of [
    ["vercel.json", DOCUMENT_CSP],
    ["netlify.toml", DOCUMENT_CSP]
  ]) {
    for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) {
      if (!csp.includes(directive)) problems.push(`${label} 的 CSP 缺少 ${directive}`);
    }
  }

  return problems;
};

export const applyAll = () => {
  const changes = [];
  for (const file of ["index.html", "home.html"]) {
    if (applyMetaCsp(file)) changes.push(file);
  }
  if (applyVercel()) changes.push("vercel.json");
  if (applyNetlify()) changes.push("netlify.toml");
  return changes;
};

const main = () => {
  const write = process.argv.includes("--write");
  if (write) {
    const changes = applyAll();
    console.log(changes.length ? `已更新：${changes.join("、")}` : "已经是最新状态");
    return;
  }
  const problems = collectDrift();
  if (problems.length) {
    console.error("[安全响应头一致性]");
    for (const problem of problems) console.error(`FAIL  ${problem}`);
    console.error("\n运行 node tools/security-headers.mjs --write 可重新生成。");
    process.exitCode = 1;
    return;
  }
  console.log("[安全响应头一致性] PASS meta / server / vercel / netlify 同源");
};

if (process.argv[1] && process.argv[1].endsWith("security-headers.mjs")) main();
