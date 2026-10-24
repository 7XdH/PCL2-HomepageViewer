import { lookup } from "node:dns/promises";
import net from "node:net";

export const MAX_BYTES = 4 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const TIMEOUT_MS = 25_000;
export const MAX_URL_LENGTH = 4096;
export const DEFAULT_USER_AGENT = "PCL2-Homepage-Viewer";
export const MAX_USER_AGENT_LENGTH = 512;
export const PROXY_REFERER = "http://200.open.pcl2.server/";

const ENV_USER_AGENT = (process.env.PCL_PROXY_UA || "").trim();
export const EFFECTIVE_DEFAULT_USER_AGENT =
  ENV_USER_AGENT && /^[\x20-\x7E]{1,512}$/.test(ENV_USER_AGENT) ? ENV_USER_AGENT : DEFAULT_USER_AGENT;

const ALLOWLIST = (process.env.PCL_PROXY_ALLOWLIST || "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, ""))
  .filter(Boolean);

export class ProxyError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "ProxyError";
    this.status = status;
  }
}

// Cloudflare (and several other CDNs) replace the body of any 5xx produced by
// the origin with its own generic error page, so the reason the upstream failed
// never reaches the viewer. Text failures therefore travel as a 200 whose real
// status sits in this header; js/app/remote.js turns it back into an error.
export const PROXY_STATUS_HEADER = "X-PCL-Proxy-Status";

function normalizeFailureStatus(status) {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

export function proxyFailure(status, message, { imageMode = false } = {}) {
  const safeStatus = normalizeFailureStatus(status);
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    [PROXY_STATUS_HEADER]: String(safeStatus)
  };
  // Images keep the real status: <img> only ever needs onerror, and a 200 with
  // a text body would be decoded as a successful (garbage) image.
  if (!imageMode && safeStatus >= 500) {
    return { status: 200, headers, body: String(message ?? "") };
  }
  return { status: safeStatus, headers, body: String(message ?? "") };
}

const BLOCKED_ADDRESSES = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
]) {
  BLOCKED_ADDRESSES.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["64:ff9b::", 96]
]) {
  BLOCKED_ADDRESSES.addSubnet(address, prefix, "ipv6");
}

function normalizeAddress(address) {
  const value = address.toLowerCase().replace(/%.*$/, "");
  if (!value.startsWith("::ffff:")) return value;

  const mapped = value.slice(7);
  if (net.isIP(mapped) === 4) return mapped;

  const parts = mapped.split(":");
  if (parts.length === 2 && parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
    const high = Number.parseInt(parts[0], 16);
    const low = Number.parseInt(parts[1], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return value;
}

export function isBlockedAddress(address, { allowLocal = false } = {}) {
  if (allowLocal) return false;
  const normalized = normalizeAddress(address);
  const family = net.isIP(normalized);
  if (!family) return true;
  return BLOCKED_ADDRESSES.check(normalized, family === 6 ? "ipv6" : "ipv4");
}

export function targetHostname(target) {
  return target.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isBlockedHostname(hostname, { allowLocal = false } = {}) {
  if (allowLocal) return false;
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  );
}

export function isAllowedHost(hostname) {
  if (!ALLOWLIST.length) return true;
  return ALLOWLIST.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
}

export function normalizeUserAgent(rawUserAgent) {
  const value = String(rawUserAgent ?? "").trim();
  if (!value) return EFFECTIVE_DEFAULT_USER_AGENT;
  if (value.length > MAX_USER_AGENT_LENGTH || !/^[\x20-\x7E]+$/.test(value)) {
    throw new ProxyError("UA 必须是 1-512 个可打印 ASCII 字符", 400);
  }
  return value;
}

export function parseTarget(rawTarget, { allowLocal = false } = {}) {
  if (!rawTarget || !String(rawTarget).trim()) {
    throw new ProxyError("缺少 url 参数", 400);
  }
  const raw = String(rawTarget);
  if (raw.length > MAX_URL_LENGTH) {
    throw new ProxyError("网址过长", 400);
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new ProxyError("无效的网址", 400);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new ProxyError("只支持 http:// 与 https://", 400);
  }
  if (target.username || target.password) {
    throw new ProxyError("网址不能包含用户名或密码", 403);
  }

  const port = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
  if (!allowLocal && port !== 80 && port !== 443) {
    throw new ProxyError("只允许 80 与 443 端口", 403);
  }

  const hostname = targetHostname(target);
  if (!hostname) throw new ProxyError("网址缺少主机名", 400);
  if (isBlockedHostname(hostname, { allowLocal })) {
    throw new ProxyError("不允许访问本机或内网主机", 403);
  }
  if (!isAllowedHost(hostname)) {
    throw new ProxyError("目标主机不在代理白名单中", 403);
  }

  return target;
}

export function resolveRedirect(target, location, status, { allowLocal = false } = {}) {
  if (!location) {
    throw new ProxyError(`远程服务器返回 HTTP ${status}，但没有重定向地址`, 502);
  }
  return parseTarget(new URL(location, target).toString(), { allowLocal });
}

// Validate the host and hand back the exact addresses that passed. Callers that
// can pin the connection (node:http / node:https accept a `lookup`) must reuse
// this list; otherwise the socket is free to resolve the name a second time and
// a DNS-rebinding attacker can swap in 127.0.0.1 between check and connect.
export async function resolvePublicAddresses(target, { allowLocal = false } = {}) {
  const hostname = targetHostname(target);
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname, { allowLocal })) {
      throw new ProxyError("不允许访问内网或保留地址", 403);
    }
    return [hostname];
  }

  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ProxyError("无法解析目标域名", 502);
  }
  if (!records.length) {
    throw new ProxyError("目标域名没有可用地址", 502);
  }
  // Every answer must be public: a host that returns one public and one private
  // address would otherwise pass and then connect to whichever the resolver
  // happens to order first.
  if (records.some((record) => isBlockedAddress(record.address, { allowLocal }))) {
    throw new ProxyError("目标域名解析到内网或保留地址", 403);
  }
  return records.map((record) => record.address);
}

export async function assertPublicTarget(target, options = {}) {
  await resolvePublicAddresses(target, options);
}

// A `lookup` for node:http(s) that only ever answers with the addresses that
// were already validated, ignoring whatever DNS says at connect time.
export function createPinnedLookup(addresses) {
  const pinned = addresses
    .map((address) => ({ address: normalizeAddress(address), family: net.isIP(normalizeAddress(address)) }))
    .filter((entry) => entry.family === 4 || entry.family === 6);

  return (hostname, options, callback) => {
    let opts = options;
    let done = callback;
    if (typeof opts === "function") {
      done = opts;
      opts = {};
    }
    if (!pinned.length) {
      done(new Error("没有可用的固定地址"));
      return;
    }
    const family = Number(opts?.family) || 0;
    const usable = family ? pinned.filter((entry) => entry.family === family) : pinned;
    const results = usable.length ? usable : pinned;
    if (opts?.all) {
      done(null, results);
      return;
    }
    done(null, results[0].address, results[0].family);
  };
}

export function proxyRequestHeaders(userAgent, imageMode, { acceptEncoding = false } = {}) {
  return {
    "User-Agent": userAgent,
    Referer: PROXY_REFERER,
    Accept: imageMode ? "image/*,*/*" : "text/xml,application/xml,text/plain,*/*",
    ...(acceptEncoding ? { "Accept-Encoding": "gzip, deflate, br" } : {})
  };
}

export function isTextContentType(contentType, finalUrl = "") {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("text/html")) return false;

  let pathname = "";
  try {
    pathname = new URL(finalUrl).pathname.toLowerCase();
  } catch {
    pathname = "";
  }

  return (
    /xml|text|json|javascript/i.test(type) ||
    !type ||
    (/octet-stream/i.test(type) && /\.(xaml|xml|txt)$/i.test(pathname))
  );
}

export function isImageContentType(contentType, finalUrl = "") {
  const type = String(contentType || "").toLowerCase();
  if (/^image\//i.test(type)) return true;

  let pathname = "";
  try {
    pathname = new URL(finalUrl).pathname.toLowerCase();
  } catch {
    pathname = "";
  }
  return !type || (/octet-stream/i.test(type) && /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(pathname));
}
