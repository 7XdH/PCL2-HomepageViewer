import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { isSvgResponse, svgResponseHeaders } from "./api/proxy-policy.js";
import { baseSecurityHeaders, documentSecurityHeaders } from "./api/security-headers.js";
import {
  MAX_BYTES,
  MAX_REDIRECTS,
  TIMEOUT_MS,
  ProxyError,
  createPinnedLookup,
  isBlockedAddress,
  isImageContentType,
  isTextContentType,
  normalizeUserAgent,
  parseTarget,
  proxyFailure,
  proxyRequestHeaders,
  resolvePublicAddresses,
  resolveRedirect
} from "./api/proxy-core.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const ALLOW_LOCAL_PROXY = process.env.PCL_PROXY_ALLOW_LOCAL === "1";
const COMMIT_CACHE_MS = 30_000;
let commitCache = null;
let commitCacheAt = 0;
let commitRequest = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xaml": "application/xml; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const safeDecode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

function send(res, status, body, headers = {}, { head = false, cors = false } = {}) {
  const payload = body ?? "";
  res.writeHead(status, {
    ...baseSecurityHeaders(),
    ...(cors ? { "Access-Control-Allow-Origin": "*" } : {}),
    ...(head ? { "Content-Length": String(Buffer.byteLength(payload)) } : {}),
    ...headers
  });
  res.end(head ? undefined : payload);
}

function sendProxy(res, status, body, headers = {}) {
  send(res, status, body, headers, { cors: true });
}

// Report proxy failures the same way api/proxy.js does: a status read back from
// X-PCL-Proxy-Status instead of a bare 5xx, so behaviour matches the Vercel
// deployment and any CDN in front of it.
function sendProxyFailure(res, status, body, imageMode = false) {
  const failure = proxyFailure(status, body, { imageMode });
  sendProxy(res, failure.status, failure.body, failure.headers);
}

// Only the files the viewer itself publishes are readable. Serving everything
// under ROOT leaked the repository: /.git/HEAD, /node_modules/... and
// /README.md all answered 200, and a symlink inside a served directory could
// point anywhere. Anything not on this list is indistinguishable from missing.
const STATIC_FILES = new Set(["index.html", "home.html", "commit.json", "LICENSE", "LICENCE-PCL.md", ".nojekyll"]);
// api/ and tools/ are public source that the page or the test harness imports
// from the served origin; neither holds secrets.
const STATIC_DIRECTORIES = ["css/", "js/", "assets/", "api/", "tools/"];

function isStaticEntry(relative) {
  const normalized = relative.replaceAll("\\", "/");
  if (normalized.split("/").some((segment) => segment.startsWith("."))) return false;
  if (STATIC_FILES.has(normalized)) return true;
  return STATIC_DIRECTORIES.some((prefix) => normalized.startsWith(prefix));
}

// Text files revalidate with an ETag and are gzipped when the client accepts it.
// Binary assets (images, fonts) are already compressed and rarely worth gzipping.
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".mjs", ".json", ".xaml", ".xml", ".txt", ".md", ".svg"]);
const GZIP_MIN_BYTES = 1024;

// Weak validator: content length plus mtime. Cheap, and unlike a content hash it
// does not require hashing large files on every request.
function makeEtag(stat) {
  return `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
}

function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === "*") return true;
  // Compare the opaque part only, so W/"x" and "x" both match.
  const bare = (value) => value.trim().replace(/^W\//, "");
  const target = bare(etag);
  return header.split(",").some((candidate) => bare(candidate) === target);
}

function modifiedSinceMatches(header, stat) {
  if (!header) return false;
  const since = Date.parse(header);
  if (Number.isNaN(since)) return false;
  // HTTP dates have second granularity; mtimes rarely do, so round down before
  // comparing rather than reporting "changed" forever.
  return Math.trunc(stat.mtimeMs / 1000) * 1000 <= since;
}

const gzip = (buffer) =>
  new Promise((resolve) => {
    zlib.gzip(buffer, { level: 6 }, (error, result) => resolve(error ? buffer : result));
  });

function serveStatic(req, res, pathname) {
  const head = req.method === "HEAD";
  const sendStatic = (status, body, headers = {}) => send(res, status, body, headers, { head });
  const decoded = safeDecode(pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (!isStaticEntry(relative)) {
    sendStatic(403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  const target = path.resolve(ROOT, relative);
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
    sendStatic(403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  fs.stat(target, (error, stat) => {
    if (error) {
      sendStatic(404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    const file = stat.isDirectory() ? path.join(target, "index.html") : target;
    // A path check alone cannot see symlinks, so confirm where the file really
    // lives before reading it.
    fs.realpath(file, (realError, real) => {
      if (realError || !(real === ROOT || real.startsWith(ROOT + path.sep))) {
        sendStatic(404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
        return;
      }
      fs.stat(real, (statError, info) => {
        if (statError) {
          sendStatic(404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
          return;
        }
        const ext = path.extname(real).toLowerCase();
        const type = MIME[ext] || "application/octet-stream";
        const cache = [".html", ".css", ".js", ".mjs", ".xaml", ".xml", ".json"].includes(ext)
          ? "no-cache"
          : "public, max-age=3600";
        const documentHeaders = ext === ".html" ? documentSecurityHeaders() : {};
        const etag = makeEtag(info);
        const validators = {
          ETag: etag,
          "Last-Modified": new Date(Math.trunc(info.mtimeMs / 1000) * 1000).toUTCString(),
          "Cache-Control": cache
        };

        const ifNoneMatch = req.headers["if-none-match"];
        const ifModifiedSince = req.headers["if-modified-since"];
        // If-None-Match wins over If-Modified-Since per RFC 9110 §13.1.3.
        const fresh =
          (ifNoneMatch ? etagMatches(ifNoneMatch, etag) : false) ||
          (!ifNoneMatch && modifiedSinceMatches(ifModifiedSince, info));
        if (fresh) {
          sendStatic(304, "", { ...validators, ...documentHeaders });
          return;
        }

        const acceptsGzip = /\bgzip\b/i.test(req.headers["accept-encoding"] || "");
        const willCompress = acceptsGzip && COMPRESSIBLE.has(ext) && info.size >= GZIP_MIN_BYTES;
        // HEAD only needs the headers. Unless the response will be gzipped we
        // know the length from stat(), so skip reading the file at all.
        if (head && !willCompress) {
          sendStatic(200, "", {
            "Content-Type": type,
            "Content-Length": String(info.size),
            ...validators,
            ...documentHeaders
          });
          return;
        }

        fs.readFile(real, async (readError, data) => {
          if (readError) {
            sendStatic(404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
            return;
          }
          let payload = data;
          let encoding = {};
          if (willCompress) {
            payload = await gzip(data);
            // Vary is mandatory here: a shared cache must not serve the gzipped
            // body to a client that never asked for it.
            encoding = { "Content-Encoding": "gzip", Vary: "Accept-Encoding" };
          }
          sendStatic(200, payload, {
            "Content-Type": type,
            // Stated explicitly so HEAD and a chunked GET agree on the size.
            "Content-Length": String(payload.length),
            ...validators,
            ...encoding,
            ...documentHeaders
          });
        });
      });
    });
  });
}

async function requestOnce(url, redirectsLeft, userAgent, imageMode = false, allowLocal = false, deadline = 0) {
  const parsed = parseTarget(url, { allowLocal });
  // One deadline for the whole redirect chain. Timing each hop separately let a
  // five-hop chain run for 5 x TIMEOUT_MS; api/proxy.js already budgets the
  // whole request through a single AbortController.
  const expiresAt = deadline || Date.now() + TIMEOUT_MS;
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) throw new ProxyError(`请求超时（${TIMEOUT_MS / 1000} 秒）`, 504);
  // Pin the connection to the addresses that were just validated. Without this
  // the socket would resolve the name again and a rebinding answer could point
  // it at 127.0.0.1 after the check had passed.
  const addresses = await resolvePublicAddresses(parsed, { allowLocal });

  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(
      parsed,
      {
        method: "GET",
        headers: proxyRequestHeaders(userAgent, imageMode, { acceptEncoding: true }),
        timeout: Math.max(1, expiresAt - Date.now()),
        lookup: createPinnedLookup(addresses)
      },
      (response) => {
        // Belt and braces: whatever the resolver did, refuse a socket that ended
        // up on a blocked address.
        const remote = response.socket?.remoteAddress;
        if (remote && isBlockedAddress(remote, { allowLocal })) {
          response.destroy();
          reject(new ProxyError("连接落到内网或保留地址", 403));
          return;
        }
        const status = response.statusCode || 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new ProxyError("重定向次数过多", 502));
            return;
          }
          let next;
          try {
            next = resolveRedirect(parsed, location, status, { allowLocal }).toString();
          } catch (error) {
            reject(error);
            return;
          }
          resolve(requestOnce(next, redirectsLeft - 1, userAgent, imageMode, allowLocal, expiresAt));
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new ProxyError(`远程服务器返回 HTTP ${status}`, 502));
          return;
        }

        // Check the type before reading anything. Waiting until the whole body
        // was buffered meant a 4 MB HTML error page or a video was downloaded
        // just to be rejected with 415.
        const contentType = response.headers["content-type"] || "";
        if (
          imageMode
            ? !isImageContentType(contentType, parsed.toString())
            : !isTextContentType(contentType, parsed.toString())
        ) {
          response.resume();
          reject(
            new ProxyError(imageMode ? "目标不是图片内容，无法加载。" : "目标不是文本或 XAML 内容，无法加载。", 415)
          );
          return;
        }

        let stream = response;
        const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
        if (encoding.includes("br")) stream = stream.pipe(zlib.createBrotliDecompress());
        else if (encoding.includes("gzip")) stream = stream.pipe(zlib.createGunzip());
        else if (encoding.includes("deflate")) stream = stream.pipe(zlib.createInflate());

        const chunks = [];
        let size = 0;
        stream.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            stream.destroy(new ProxyError("远程文件过大（超过 4 MB）", 413));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => {
          resolve({
            body: Buffer.concat(chunks),
            contentType: response.headers["content-type"] || "application/octet-stream",
            finalUrl: parsed.toString()
          });
        });
        stream.on("error", reject);
      }
    );

    request.on("timeout", () => request.destroy(new ProxyError(`请求超时（${TIMEOUT_MS / 1000} 秒）`, 504)));
    request.on("error", reject);
    request.end();
  });
}

function readLatestCommit() {
  if (commitCache && Date.now() - commitCacheAt < COMMIT_CACHE_MS) {
    return Promise.resolve(commitCache);
  }
  if (commitRequest) return commitRequest;

  commitRequest = new Promise((resolve, reject) => {
    execFile(
      "git",
      ["log", "-1", "--format=%cI%n%H"],
      { cwd: ROOT, windowsHide: true, timeout: 5000, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const [date, sha] = String(stdout).trim().split(/\r?\n/);
        if (!date || !sha) {
          reject(new Error("git log 返回为空"));
          return;
        }
        resolve({
          date,
          sha,
          source: "local"
        });
      }
    );
  })
    .then((commit) => {
      commitCache = commit;
      commitCacheAt = Date.now();
      return commit;
    })
    .finally(() => {
      commitRequest = null;
    });
  return commitRequest;
}

async function proxy(req, res, requestUrl) {
  const target = requestUrl.searchParams.get("url");
  if (!target) {
    sendProxy(res, 400, "缺少 url 参数", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  const imageMode = requestUrl.searchParams.get("image") === "1";
  let userAgent;
  try {
    userAgent = normalizeUserAgent(requestUrl.searchParams.get("ua"));
  } catch (error) {
    sendProxy(res, error?.status || 400, String(error?.message || error), {
      "Content-Type": "text/plain; charset=utf-8"
    });
    return;
  }
  try {
    const result = await requestOnce(target, MAX_REDIRECTS, userAgent, imageMode, ALLOW_LOCAL_PROXY);
    if (imageMode) {
      if (!isImageContentType(result.contentType, result.finalUrl)) {
        sendProxy(res, 415, "目标不是图片内容，无法加载。", {
          "Content-Type": "text/plain; charset=utf-8"
        });
        return;
      }
      const headers = {
        "Content-Type": result.contentType || "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Access-Control-Allow-Origin": "*",
        "X-PCL-Proxy-Image": "1",
        "X-PCL-Proxy-Ua": encodeURIComponent(userAgent),
        "X-PCL-Proxy-Final-Url": result.finalUrl
      };
      if (isSvgResponse(result.contentType, result.finalUrl)) {
        Object.assign(headers, svgResponseHeaders());
      }
      sendProxy(res, 200, result.body, headers);
      return;
    }
    if (!isTextContentType(result.contentType, result.finalUrl)) {
      sendProxy(res, 415, "目标不是文本或 XAML 内容，无法加载。", {
        "Content-Type": "text/plain; charset=utf-8"
      });
      return;
    }
    sendProxy(res, 200, result.body, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-PCL-Proxy-Ua": encodeURIComponent(userAgent),
      "X-PCL-Proxy-Final-Url": result.finalUrl
    });
  } catch (error) {
    sendProxyFailure(res, error instanceof ProxyError ? error.status : 502, String(error?.message || error), imageMode);
  }
}

const server = http.createServer((req, res) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  } catch {
    send(res, 400, "Bad Request");
    return;
  }

  if (requestUrl.pathname === "/api/health") {
    send(res, 200, JSON.stringify({ ok: true, service: "pcl-homepage-viewer" }), {
      "Content-Type": "application/json; charset=utf-8"
    });
    return;
  }

  if (requestUrl.pathname === "/api/latest-commit") {
    if (req.method !== "GET") {
      send(res, 405, "Method Not Allowed", { Allow: "GET" });
      return;
    }
    readLatestCommit()
      .then((commit) => {
        send(res, 200, JSON.stringify(commit), {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        });
      })
      .catch((error) => {
        send(res, 503, JSON.stringify({ error: String(error?.message || error) }), {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        });
      });
    return;
  }

  if (requestUrl.pathname === "/api/proxy") {
    if (req.method !== "GET") {
      send(res, 405, "Method Not Allowed", { Allow: "GET" });
      return;
    }
    proxy(req, res, requestUrl);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method Not Allowed");
    return;
  }
  serveStatic(req, res, requestUrl.pathname);
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log("");
  console.log("  Plain Craft Launcher (PCL) Homepage Viewer (第三方)");
  console.log(`  http://${displayHost}:${PORT}`);
  console.log("");
  if (HOST === "0.0.0.0" || HOST === "::") {
    console.log("  已监听所有网卡，可通过局域网地址访问；请勿在不可信网络中公开使用。");
  } else {
    console.log(`  仅监听 ${HOST}；需要局域网访问时请设置 HOST=0.0.0.0。`);
  }
  console.log("  联网主页将通过 /api/proxy 代理，远程图片失败时通过 image=1 模式重试。");
  console.log("  默认 UA：PCL2-Homepage-Viewer。");
  console.log("  按 Ctrl + C 停止服务器。");
  console.log("");
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用。可以通过 PORT=另一个端口 node server.js 启动。`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
