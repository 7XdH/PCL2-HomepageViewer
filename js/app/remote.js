import { MAX_SOURCE_BYTES, assertSourceWithinLimit, sourceLimitError } from "../limits.js";

// Mirrors PROXY_STATUS_HEADER in api/proxy-core.js.
const PROXY_STATUS_HEADER = "x-pcl-proxy-status";

export async function readResponseTextLimited(response, label = "远程内容") {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw sourceLimitError(contentLength, label);
  }
  if (!response.body) {
    return assertSourceWithinLimit(await response.text(), label);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        await reader.cancel().catch(() => {});
        throw sourceLimitError(total, label);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* The reader may already be released after cancellation. */
    }
  }
}

// Same header served by api/proxy.js, server.js and the Netlify adapter: the URL
// the upstream chain finally landed on. A relative `Source="images/a.png"` has
// to be resolved against that URL, not against the first request URL, because a
// redirect can move the document to another folder.
const PROXY_FINAL_URL_HEADER = "x-pcl-proxy-final-url";

function readFinalUrl(response) {
  const raw = response.headers.get(PROXY_FINAL_URL_HEADER);
  if (!raw) return "";
  let value = raw;
  try {
    // Vercel's handler encodeURI()s the value; the local server sends it raw.
    value = decodeURI(raw);
  } catch {
    /* Not percent-encoded, keep the raw header. */
  }
  try {
    const parsed = new URL(value);
    return /^https?:$/i.test(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

/**
 * @param {string} url
 * @param {AbortSignal} signal
 * @param {string} ua
 * @param {string} label
 * @param {{ finalUrl?: string }} [info] receives the URL the proxy ended on
 */
export async function fetchViaProxy(url, signal, ua = "", label = "远程内容", info = null) {
  const proxyUrl = new URL("api/proxy", document.baseURI);
  proxyUrl.searchParams.set("url", url);
  if (ua) proxyUrl.searchParams.set("ua", ua);
  const response = await fetch(proxyUrl, { signal, cache: "no-store" });
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  // A 5xx from the function is rewritten by Cloudflare and similar CDNs into a
  // generic HTML error page, so the proxy reports upstream failures as a 200
  // carrying X-PCL-Proxy-Status. Read that first, then fall back to the real
  // status for older deployments and non-CDN hosting.
  const reported = Number(response.headers.get(PROXY_STATUS_HEADER));
  const proxyStatus = Number.isFinite(reported) && reported >= 400 ? reported : 0;
  if (proxyStatus || !response.ok || contentType.includes("text/html")) {
    const text = await readResponseTextLimited(response, `${label}错误响应`).catch(() => "");
    const error = new Error(text.trim() || `代理返回 HTTP ${proxyStatus || response.status}`);
    // The upstream status drives the fallback policy in app/sources.js.
    error.status = proxyStatus || response.status;
    error.code = !proxyStatus && contentType.includes("text/html") ? "PROXY_HTML" : "PROXY_HTTP";
    throw error;
  }
  if (info) info.finalUrl = readFinalUrl(response) || url;
  return readResponseTextLimited(response, label);
}

/**
 * @param {string} url
 * @param {AbortSignal} signal
 * @param {string} label
 * @param {{ finalUrl?: string }} [info]
 */
export async function fetchDirect(url, signal, label = "远程内容", info = null) {
  const response = await fetch(url, {
    signal,
    mode: "cors",
    credentials: "omit",
    cache: "no-cache"
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html")) {
    throw new Error("目标地址返回了 HTML 页面，而不是 XAML。");
  }
  // fetch() follows redirects transparently and response.url holds the landing
  // URL, which is the base relative image sources have to be resolved against.
  if (info) info.finalUrl = response.url || url;
  return readResponseTextLimited(response, label);
}

export function isLikelyXaml(source) {
  let text = String(source ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text) return false;

  // Allow an XML declaration, processing instructions and comments before the root.
  for (let index = 0; index < 8; index += 1) {
    const next = text
      .replace(/^<\?xml[\s\S]*?\?>/i, "")
      .replace(/^<!--[\s\S]*?-->/, "")
      .replace(/^<\?[\s\S]*?\?>/, "")
      .trim();
    if (next === text) break;
    text = next;
  }

  if (!text || /^<!doctype\b/i.test(text) || /^<html(?:\s|>)/i.test(text)) return false;
  return /^<([A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*(?:\s|\/?>)/.test(text);
}

export function isLikelyJson(source) {
  const text = String(source ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text || (text[0] !== "[" && text[0] !== "{")) return false;
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed) && typeof parsed === "object";
  } catch {
    return false;
  }
}

export function responseKind(content) {
  const sample = String(content ?? "")
    .replace(/^\uFEFF/, "")
    .trimStart();
  return sample[0] === "[" || sample[0] === "{"
    ? "JSON"
    : /^<!doctype\s+html\b|^<html(?:\s|>)/i.test(sample)
      ? "HTML"
      : sample
        ? "纯文本或其他格式"
        : "空内容";
}

export function assertRemoteResponse(content, url, { expect = "xaml", label = "联网主页" } = {}) {
  if (expect === "json" ? isLikelyJson(content) : isLikelyXaml(content)) return content;
  const expected = expect === "json" ? "JSON" : "XAML";
  const error = new Error(`无法拉取${label}：目标地址返回的不是 ${expected}（${responseKind(content)}）。\n\n${url}`);
  error.code = expect === "json" ? "NOT_JSON" : "NOT_XAML";
  throw error;
}
