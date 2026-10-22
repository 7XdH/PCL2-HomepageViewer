import { isSvgResponse, svgResponseHeaders } from "./proxy-policy.js";
import { baseSecurityHeaders } from "./security-headers.js";
import {
  MAX_BYTES,
  MAX_REDIRECTS,
  TIMEOUT_MS,
  ProxyError,
  assertPublicTarget,
  isImageContentType,
  isTextContentType,
  normalizeUserAgent,
  parseTarget,
  proxyRequestHeaders,
  resolveRedirect
} from "./proxy-core.js";

function send(response, status, body, headers = {}) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  for (const [key, value] of Object.entries({ ...baseSecurityHeaders(), ...headers })) {
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

async function readBody(response, finalUrl, imageMode = false) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
    await discardBody(response);
    throw new ProxyError("远程文件过大（超过 4 MB）", 413);
  }
  const contentType = response.headers.get("content-type") || "";
  if (imageMode) {
    if (!isImageContentType(contentType, finalUrl)) {
      await discardBody(response);
      throw new ProxyError("目标不是图片内容，无法加载。", 415);
    }
  } else if (!isTextContentType(contentType, finalUrl)) {
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

async function fetchTarget(initialTarget, userAgent, imageMode = false) {
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
        headers: proxyRequestHeaders(userAgent, imageMode)
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await discardBody(response);
        if (redirects >= MAX_REDIRECTS) {
          throw new ProxyError("重定向次数过多", 502);
        }
        target = resolveRedirect(target, location, response.status);
        continue;
      }

      if (!response.ok) {
        await discardBody(response);
        throw new ProxyError(`远程服务器返回 HTTP ${response.status}`, 502);
      }

      const finalUrl = target.toString();
      const contentType = response.headers.get("content-type") || "";
      const body = await readBody(response, finalUrl, imageMode);
      return { body, finalUrl, contentType };
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
    const imageMode = requestUrl.searchParams.get("image") === "1";
    const userAgent = normalizeUserAgent(requestUrl.searchParams.get("ua"));
    const result = await fetchTarget(target, userAgent, imageMode);
    const headers = {
      "X-PCL-Proxy": "vercel",
      "X-PCL-Proxy-Ua": encodeURIComponent(userAgent),
      "X-PCL-Proxy-Final-Url": encodeURI(result.finalUrl)
    };
    if (imageMode) {
      Object.assign(headers, {
        "Content-Type": result.contentType || "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Access-Control-Allow-Origin": "*",
        "X-PCL-Proxy-Image": "1"
      });
      if (isSvgResponse(result.contentType, result.finalUrl)) {
        Object.assign(headers, svgResponseHeaders());
      }
    }
    send(response, 200, result.body, headers);
  } catch (error) {
    const status = error instanceof ProxyError ? error.status : 502;
    send(response, status, String(error?.message || error));
  }
}
