import { lookup } from "node:dns/promises";
import net from "node:net";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 25_000;
const MAX_URL_LENGTH = 4096;

const PCL_USER_AGENT =
  "PCL2/2.11.0 Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.132 Safari/537.36";

const ALLOWLIST = (process.env.PCL_PROXY_ALLOWLIST || "")
  .split(",")
  .map(entry => entry.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, ""))
  .filter(Boolean);

class ProxyError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "ProxyError";
    this.status = status;
  }
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
  if (parts.length === 2 && parts.every(part => /^[0-9a-f]{1,4}$/.test(part))) {
    const high = Number.parseInt(parts[0], 16);
    const low = Number.parseInt(parts[1], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return value;
}

function isBlockedAddress(address) {
  const normalized = normalizeAddress(address);
  const family = net.isIP(normalized);
  if (!family) return true;
  return BLOCKED_ADDRESSES.check(normalized, family === 6 ? "ipv6" : "ipv4");
}

function targetHostname(target) {
  return target.hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

function isBlockedHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  );
}

function isAllowedHost(hostname) {
  if (!ALLOWLIST.length) return true;
  return ALLOWLIST.some(entry => hostname === entry || hostname.endsWith(`.${entry}`));
}

function parseTarget(rawTarget) {
  if (!rawTarget || !rawTarget.trim()) {
    throw new ProxyError("缺少 url 参数", 400);
  }
  if (rawTarget.length > MAX_URL_LENGTH) {
    throw new ProxyError("网址过长", 400);
  }

  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    throw new ProxyError("无效的网址", 400);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new ProxyError("只支持 http:// 与 https://", 400);
  }
  if (target.username || target.password) {
    throw new ProxyError("网址不能包含用户名或密码", 403);
  }

  const port = target.port
    ? Number(target.port)
    : target.protocol === "https:"
      ? 443
      : 80;
  if (port !== 80 && port !== 443) {
    throw new ProxyError("只允许 80 与 443 端口", 403);
  }

  const hostname = targetHostname(target);
  if (!hostname) throw new ProxyError("网址缺少主机名", 400);
  if (isBlockedHostname(hostname)) {
    throw new ProxyError("不允许访问本机或内网主机", 403);
  }
  if (!isAllowedHost(hostname)) {
    throw new ProxyError("目标主机不在代理白名单中", 403);
  }

  return target;
}

async function assertPublicTarget(target) {
  const hostname = targetHostname(target);
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new ProxyError("不允许访问内网或保留地址", 403);
    }
    return;
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
  if (records.some(record => isBlockedAddress(record.address))) {
    throw new ProxyError("目标域名解析到内网或保留地址", 403);
  }
}

function send(response, status, body, headers = {}) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  for (const [key, value] of Object.entries(headers)) {
    response.setHeader(key, value);
  }
  response.end(body);
}

async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The connection may already be closed; there is nothing else to clean up.
  }
}

function isTextResponse(response, finalUrl) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html")) return false;

  let pathname = "";
  try {
    pathname = new URL(finalUrl).pathname.toLowerCase();
  } catch {
    pathname = "";
  }

  return (
    /xml|text|json|javascript/i.test(contentType) ||
    !contentType ||
    (/octet-stream/i.test(contentType) && /\.(xaml|xml|txt)$/i.test(pathname))
  );
}

async function readBody(response, finalUrl) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
    await discardBody(response);
    throw new ProxyError("远程文件过大（超过 4 MB）", 413);
  }
  if (!isTextResponse(response, finalUrl)) {
    await discardBody(response);
    throw new ProxyError("目标不是文本或 XAML 内容，无法加载。", 415);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ProxyError("远程文件过大（超过 4 MB）", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function fetchTarget(initialTarget) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let target = parseTarget(initialTarget);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await assertPublicTarget(target);

      const response = await fetch(target, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        cache: "no-store",
        headers: {
          "User-Agent": PCL_USER_AGENT,
          Referer: "http://200.open.pcl2.server/",
          Accept: "text/xml,application/xml,text/plain,*/*"
        }
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await discardBody(response);
        if (!location) {
          throw new ProxyError(`远程服务器返回 HTTP ${response.status}，但没有重定向地址`, 502);
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new ProxyError("重定向次数过多", 502);
        }
        target = parseTarget(new URL(location, target).toString());
        continue;
      }

      if (!response.ok) {
        await discardBody(response);
        throw new ProxyError(`远程服务器返回 HTTP ${response.status}`, 502);
      }

      const finalUrl = target.toString();
      const body = await readBody(response, finalUrl);
      return { body, finalUrl };
    }
    throw new ProxyError("重定向次数过多", 502);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new ProxyError(`请求超时（${TIMEOUT_MS / 1000} 秒）`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    send(response, 405, "Method Not Allowed");
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(request.url || "/", `https://${request.headers.host || "localhost"}`);
  } catch {
    send(response, 400, "Bad Request");
    return;
  }

  try {
    const target = requestUrl.searchParams.get("url");
    const result = await fetchTarget(target);
    send(response, 200, result.body, {
      "X-PCL-Proxy": "vercel",
      "X-PCL-Proxy-Final-Url": encodeURI(result.finalUrl)
    });
  } catch (error) {
    const status = error instanceof ProxyError ? error.status : 502;
    send(response, status, String(error?.message || error));
  }
}

