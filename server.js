import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { isSvgResponse, svgResponseHeaders } from "./api/proxy-policy.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 25000;
const DEFAULT_USER_AGENT = "PCL2-Homepage-Viewer";
const MAX_USER_AGENT_LENGTH = 512;

const ENV_USER_AGENT = (process.env.PCL_PROXY_UA || "").trim();
const EFFECTIVE_DEFAULT_USER_AGENT =
  ENV_USER_AGENT && /^[\x20-\x7E]{1,512}$/.test(ENV_USER_AGENT)
    ? ENV_USER_AGENT
    : DEFAULT_USER_AGENT;

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

const safeDecode = value => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    ...headers
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const decoded = safeDecode(pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = path.resolve(ROOT, relative);
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
    send(res, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  fs.stat(target, (error, stat) => {
    if (error) {
      send(res, 404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    const file = stat.isDirectory() ? path.join(target, "index.html") : target;
    fs.readFile(file, (readError, data) => {
      if (readError) {
        send(res, 404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext] || "application/octet-stream";
      const cache = [".html", ".css", ".js", ".mjs", ".xaml", ".xml", ".json"].includes(ext)
        ? "no-cache"
        : "public, max-age=3600";
      send(res, 200, data, { "Content-Type": type, "Cache-Control": cache });
    });
  });
}

function normalizeUserAgent(rawUserAgent) {
  const value = String(rawUserAgent ?? "").trim();
  if (!value) return EFFECTIVE_DEFAULT_USER_AGENT;
  if (value.length > MAX_USER_AGENT_LENGTH || !/^[\x20-\x7E]+$/.test(value)) {
    throw new Error("UA 必须是 1-512 个可打印 ASCII 字符");
  }
  return value;
}

function requestOnce(
  url,
  redirectsLeft,
  userAgent,
  accept = "text/xml,application/xml,text/plain,*/*"
) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error("无效的网址"));
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      reject(new Error("只支持 http:// 与 https://"));
      return;
    }

    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(
      parsed,
      {
        method: "GET",
        headers: {
          "User-Agent": userAgent,
          Referer: "http://200.open.pcl2.server/",
          Accept: accept,
          "Accept-Encoding": "gzip, deflate, br"
        },
        timeout: TIMEOUT_MS
      },
      response => {
        const status = response.statusCode || 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("重定向次数过多"));
            return;
          }
          const next = new URL(location, parsed).toString();
          resolve(requestOnce(next, redirectsLeft - 1, userAgent, accept));
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`远程服务器返回 HTTP ${status}`));
          return;
        }

        let stream = response;
        const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
        if (encoding.includes("br")) stream = stream.pipe(zlib.createBrotliDecompress());
        else if (encoding.includes("gzip")) stream = stream.pipe(zlib.createGunzip());
        else if (encoding.includes("deflate")) stream = stream.pipe(zlib.createInflate());

        const chunks = [];
        let size = 0;
        stream.on("data", chunk => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            stream.destroy(new Error("远程文件过大（超过 4 MB）"));
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

    request.on("timeout", () => request.destroy(new Error("请求超时")));
    request.on("error", reject);
    request.end();
  });
}

function readLatestCommit() {
  return new Promise((resolve, reject) => {
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
  });
}

async function proxy(req, res, requestUrl) {
  const target = requestUrl.searchParams.get("url");
  if (!target) {
    send(res, 400, "缺少 url 参数", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  const imageMode = requestUrl.searchParams.get("image") === "1";
  let userAgent;
  try {
    userAgent = normalizeUserAgent(requestUrl.searchParams.get("ua"));
  } catch (error) {
    send(res, 400, String(error?.message || error), { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  try {
    const result = await requestOnce(
      target,
      MAX_REDIRECTS,
      userAgent,
      imageMode ? "image/*,*/*" : "text/xml,application/xml,text/plain,*/*"
    );
    let finalPath = "";
    try {
      finalPath = new URL(result.finalUrl).pathname.toLowerCase();
    } catch {
      finalPath = "";
    }
    if (imageMode) {
      const isImage =
        /^image\//i.test(result.contentType) ||
        (/octet-stream/i.test(result.contentType) &&
          /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(finalPath));
      if (!isImage) {
        send(res, 415, "目标不是图片内容，无法加载。", {
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
      send(res, 200, result.body, headers);
      return;
    }
    const isText =
      /xml|text|json|javascript/i.test(result.contentType) ||
      !result.contentType ||
      (/octet-stream/i.test(result.contentType) && /\.(xaml|xml|txt)$/i.test(finalPath));
    if (!isText) {
      send(res, 415, "目标不是文本内容，无法作为 XAML 加载。", {
        "Content-Type": "text/plain; charset=utf-8"
      });
      return;
    }
    send(res, 200, result.body, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-PCL-Proxy-Ua": encodeURIComponent(userAgent),
      "X-PCL-Proxy-Final-Url": result.finalUrl
    });
  } catch (error) {
    send(res, 502, String(error?.message || error), {
      "Content-Type": "text/plain; charset=utf-8"
    });
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
      send(res, 405, "Method Not Allowed");
      return;
    }
    readLatestCommit()
      .then(commit => {
        send(res, 200, JSON.stringify(commit), {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        });
      })
      .catch(error => {
        send(res, 503, JSON.stringify({ error: String(error?.message || error) }), {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        });
      });
    return;
  }

  if (requestUrl.pathname === "/api/proxy") {
    if (req.method !== "GET") {
      send(res, 405, "Method Not Allowed");
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

server.listen(PORT, () => {
  console.log("");
  console.log("  Plain Craft Launcher (PCL) Homepage Viewer (第三方)");
  console.log(`  http://localhost:${PORT}`);
  console.log("");
  console.log("  联网主页将通过 /api/proxy 代理，远程图片失败时通过 image=1 模式重试。");
  console.log("  默认 UA：PCL2-Homepage-Viewer。");
  console.log("  按 Ctrl + C 停止服务器。");
  console.log("");
});

server.on("error", error => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用。可以通过 PORT=另一个端口 node server.js 启动。`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

