import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findBrowser } from "./browser-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const WANT_PRESETS = args.has("--presets") || args.has("--all");
const WANT_REGRESSION = !args.has("--presets") || args.has("--all");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (fn, { timeout = 20000, interval = 100, label = "operation" } = {}) => {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`等待 ${label} 超时${lastError ? `：${lastError.message}` : ""}`);
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });

class PipeCdp {
  constructor(readable, writable) {
    this.readable = readable;
    this.writable = writable;
    this.buffer = Buffer.alloc(0);
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    readable.on("data", (chunk) => this.onData(chunk));
    readable.on("error", (error) => this.failAll(error));
    readable.on("close", () => this.failAll(new Error("CDP pipe closed")));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index;
    while ((index = this.buffer.indexOf(0)) !== -1) {
      const raw = this.buffer.subarray(0, index).toString("utf8");
      this.buffer = this.buffer.subarray(index + 1);
      if (!raw.trim()) continue;
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!message.id || !this.pending.has(message.id)) continue;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result || {});
    }
  }

  failAll(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error("CDP pipe is closed"));
    const id = ++this.nextId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.writable.write(`${JSON.stringify(message)}\0`);
    });
  }

  close() {
    this.closed = true;
    try {
      this.writable.end();
    } catch {
      /* ignore */
    }
  }
}

class PortCdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    socket.addEventListener("message", (event) => this.onMessage(event));
    socket.addEventListener("error", () => this.failAll(new Error("CDP websocket error")));
    socket.addEventListener("close", () => this.failAll(new Error("CDP websocket closed")));
  }

  static async connect(url) {
    if (typeof WebSocket !== "function") {
      throw new Error("当前 Node.js 不支持 WebSocket，无法使用端口模式");
    }
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP websocket 连接失败")), { once: true });
    });
    return new PortCdp(socket);
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message.id || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result || {});
  }

  failAll(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error("CDP websocket closed"));
    const id = ++this.nextId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(message));
    });
  }

  close() {
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }
}

const attachPage = async (cdp, baseUrl) => {
  const target = await waitFor(
    async () => {
      const result = await cdp.send("Target.getTargets");
      return result.targetInfos?.find((item) => item.type === "page" && item.url.startsWith(baseUrl));
    },
    { label: "浏览器页面" }
  );
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  return attached.sessionId;
};

const evaluate = async (cdp, sessionId, expression, timeout = 180000) => {
  const response = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId,
    timeout
  );
  if (response.exceptionDetails) {
    const details = response.exceptionDetails;
    throw new Error(details.exception?.description || details.text || "浏览器执行失败");
  }
  return response.result?.value;
};

const startServer = async (port) => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  await waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error(`本地服务器退出：${output.slice(-800)}`);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok;
    },
    { timeout: 12000, label: "本地服务器启动" }
  );
  return child;
};

const stopProfileProcesses = (profile) =>
  new Promise((resolve) => {
    const escaped = profile.replace(/'/g, "''");
    const command = process.platform === "win32" ? "pwsh.exe" : "pkill";
    const commandArgs =
      process.platform === "win32"
        ? [
            "-NoProfile",
            "-Command",
            `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' -and ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
          ]
        : ["-f", profile];
    let child;
    try {
      child = spawn(command, commandArgs, { stdio: "ignore", windowsHide: true });
    } catch {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("error", finish);
    child.once("exit", finish);
    setTimeout(finish, 2000);
  });

const cleanupBrowser = async (browser) => {
  if (!browser) return;
  browser.cdp?.close();
  browser.child?.kill();
  if (browser.profile) {
    await stopProfileProcesses(browser.profile);
    await sleep(300);
    try {
      fs.rmSync(browser.profile, { recursive: true, force: true });
    } catch {
      /* The headless browser may still be releasing its profile. */
    }
  }
};

const baseBrowserArgs = (profile, debugArgs, baseUrl) => [
  "--headless=new",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  ...(process.platform !== "win32" ? ["--no-sandbox"] : []),
  ...debugArgs,
  `--user-data-dir=${profile}`,
  baseUrl
];

const startPortBrowser = async (browserPath, baseUrl) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pcl-regression-"));
  const child = spawn(browserPath, baseBrowserArgs(profile, ["--remote-debugging-port=0"], baseUrl), {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  let browserError = "";
  child.stderr?.on("data", (chunk) => {
    browserError += chunk.toString();
  });

  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    await waitFor(() => fs.existsSync(portFile), {
      timeout: 15000,
      label: "浏览器端口文件"
    });
    const [port] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    const target = await waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await response.json();
        return list.find((item) => item.type === "page" && item.url.startsWith(baseUrl));
      },
      { timeout: 15000, label: "浏览器页面" }
    );
    const cdp = await PortCdp.connect(target.webSocketDebuggerUrl);
    return {
      child,
      cdp,
      sessionId: undefined,
      profile,
      browserPath,
      mode: "port"
    };
  } catch (error) {
    child.kill();
    await cleanupBrowser({ child, profile });
    throw new Error(`${error.message}${browserError ? `：${browserError.slice(-800)}` : ""}`);
  }
};

const startPipeBrowser = async (browserPath, baseUrl) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pcl-regression-"));
  const child = spawn(browserPath, baseBrowserArgs(profile, ["--remote-debugging-pipe"], baseUrl), {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let browserError = "";
  child.stderr?.on("data", (chunk) => {
    browserError += chunk.toString();
  });
  const cdp = new PipeCdp(child.stdio[4], child.stdio[3]);
  const sessionId = await waitFor(() => attachPage(cdp, baseUrl), {
    timeout: 15000,
    label: "浏览器 CDP 连接"
  }).catch((error) => {
    throw new Error(`${error.message}${browserError ? `：${browserError.slice(-800)}` : ""}`);
  });
  return { child, cdp, sessionId, profile, browserPath, mode: "pipe" };
};

const startBrowser = async (baseUrl) => {
  const browserPath = findBrowser();
  if (!browserPath) {
    throw new Error("未找到 Edge / Chrome。可通过 PCL_TEST_BROWSER 指定浏览器路径。");
  }

  // Port mode is more reliable with recent Chromium builds. Keep the pipe
  // path as a compatibility fallback for Node versions without WebSocket.
  if (typeof WebSocket === "function") {
    try {
      return await startPortBrowser(browserPath, baseUrl);
    } catch (error) {
      console.warn(`端口模式启动失败，改用 pipe：${error.message}`);
    }
  }
  return startPipeBrowser(browserPath, baseUrl);
};

const saveReport = (name, result) => {
  const folder = path.join(ROOT, "test-results");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, name), `${JSON.stringify(result, null, 2)}\n`);
  return path.relative(ROOT, path.join(folder, name));
};

const printRegression = (result) => {
  console.log("\n[回归测试]");
  for (const item of result.results) {
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.error ? ` — ${item.error}` : ""}`);
  }
  console.log(`结果：${result.ok ? "通过" : "失败"}（${result.results.length} 项）`);
};

const printAudit = (result) => {
  console.log("\n[PCL 预设批量验收]");
  for (const item of result.results) {
    const metrics = item.metrics
      ? `controls=${item.metrics.controls} warnings=${item.metrics.warnings.length} broken=${item.metrics.brokenImages}`
      : "无渲染数据";
    const bytes = item.bytes ? `bytes=${item.bytes}` : "bytes=0";
    console.log(
      `${item.pass ? "PASS" : "FAIL"}  #${String(item.id).padStart(2, "0")} ${item.name} [${item.status}] ${item.duration}ms ${bytes} ${metrics}${item.error ? ` — ${item.error}` : ""}`
    );
  }
  console.log(`统计：${JSON.stringify(result.counts)}`);
  console.log(`结果：${result.ok ? "通过" : "失败"}（${result.results.length} 个预设）`);
};

// Static delivery checks (validators, negotiation, HEAD) exercise headers that
// the browser hides from script, so they run against fetch() instead of CDP.
const runNetworkChecks = async (baseUrl) => {
  const results = [];
  const check = async (name, run) => {
    try {
      const detail = await run();
      results.push({ name, ok: true, detail });
    } catch (error) {
      results.push({ name, ok: false, error: String(error?.message || error) });
    }
  };

  await check("静态资源带 ETag 与条件请求", async () => {
    const url = `${baseUrl}js/app.js`;
    const first = await fetch(url, { cache: "no-store" });
    if (!first.ok) throw new Error(`GET 返回 HTTP ${first.status}`);
    const etag = first.headers.get("etag");
    const lastModified = first.headers.get("last-modified");
    if (!etag) throw new Error("静态响应缺少 ETag");
    if (!lastModified) throw new Error("静态响应缺少 Last-Modified");
    if (!/^W\/"[0-9a-f]+-[0-9a-f]+"$/.test(etag)) throw new Error(`ETag 格式不符合弱校验器约定：${etag}`);

    const revalidate = await fetch(url, { headers: { "If-None-Match": etag }, cache: "no-store" });
    if (revalidate.status !== 304) throw new Error(`If-None-Match 命中应为 304，实际 ${revalidate.status}`);
    if (await revalidate.text()) throw new Error("304 不应包含响应体");

    const mismatched = await fetch(url, { headers: { "If-None-Match": 'W/"0-0"' }, cache: "no-store" });
    if (mismatched.status !== 200) throw new Error(`ETag 不匹配应返回 200，实际 ${mismatched.status}`);

    const since = await fetch(url, { headers: { "If-Modified-Since": lastModified }, cache: "no-store" });
    if (since.status !== 304) throw new Error(`If-Modified-Since 命中应为 304，实际 ${since.status}`);

    // If-None-Match wins over If-Modified-Since (RFC 9110 §13.1.3).
    const precedence = await fetch(url, {
      headers: { "If-None-Match": 'W/"0-0"', "If-Modified-Since": lastModified },
      cache: "no-store"
    });
    if (precedence.status !== 200) {
      throw new Error(`两种校验器同时出错时应以 If-None-Match 为准，实际 ${precedence.status}`);
    }

    const head = await fetch(url, { method: "HEAD", headers: { "Accept-Encoding": "identity" }, cache: "no-store" });
    if (head.headers.get("etag") !== etag) throw new Error("HEAD 与 GET 的 ETag 不一致");
    if (await head.text()) throw new Error("HEAD 不应返回响应体");
    // HEAD must report the same length as the identity GET without reading the
    // file again, so the two paths cannot drift apart.
    const identity = await fetch(url, { headers: { "Accept-Encoding": "identity" }, cache: "no-store" });
    const identityLength = identity.headers.get("content-length");
    if (head.headers.get("content-length") !== identityLength) {
      throw new Error(
        `HEAD 的 Content-Length 与 GET 不一致：${head.headers.get("content-length")} / ${identityLength}`
      );
    }
    return { etag };
  });

  await check("文本资源按协商结果 gzip 压缩", async () => {
    const url = `${baseUrl}js/app.js`;
    const gzipped = await fetch(url, { headers: { "Accept-Encoding": "gzip" }, cache: "no-store" });
    if (gzipped.headers.get("content-encoding") !== "gzip") throw new Error("Accept-Encoding: gzip 时没有压缩");
    if (!/\baccept-encoding\b/i.test(gzipped.headers.get("vary") || "")) {
      throw new Error("压缩响应缺少 Vary: Accept-Encoding");
    }
    const compressedLength = Number(gzipped.headers.get("content-length"));
    const plain = await fetch(url, { headers: { "Accept-Encoding": "identity" }, cache: "no-store" });
    if (plain.headers.get("content-encoding")) throw new Error("identity 请求不应压缩");
    const plainLength = Number(plain.headers.get("content-length"));
    if (!(compressedLength > 0 && plainLength > 0)) throw new Error("响应缺少 Content-Length");
    if (compressedLength >= plainLength) throw new Error(`gzip 没有变小：${compressedLength} >= ${plainLength}`);

    const decoded = await gzipped.text();
    const original = await plain.text();
    if (decoded !== original) throw new Error("压缩与未压缩的响应体内容不一致");

    const head = await fetch(url, { method: "HEAD", headers: { "Accept-Encoding": "gzip" }, cache: "no-store" });
    if (head.headers.get("content-length") !== String(compressedLength)) {
      throw new Error(
        `HEAD 的 Content-Length 与压缩 GET 不一致：${head.headers.get("content-length")} / ${compressedLength}`
      );
    }

    // Already-compressed bytes must not be re-encoded.
    const png = await fetch(`${baseUrl}assets/pcl/images/Blocks/Grass.png`, {
      headers: { "Accept-Encoding": "gzip" },
      cache: "no-store"
    });
    if (png.headers.get("content-encoding") === "gzip") throw new Error("PNG 不应被 gzip 二次压缩");

    return { compressedLength, plainLength };
  });

  await check("HEAD 请求缺失的资源返回 404", async () => {
    for (const target of ["/js/definitely-missing.js", "/assets/presets/missing.xaml"]) {
      const response = await fetch(`${baseUrl}${target.slice(1)}`, { method: "HEAD", cache: "no-store" });
      if (response.status !== 404) throw new Error(`${target} 的 HEAD 应为 404，实际 ${response.status}`);
      if (await response.text()) throw new Error(`${target} 的 HEAD 不应返回响应体`);
    }
    // A denied path must look the same over HEAD as over GET, so probe both.
    const deniedGet = await fetch(`${baseUrl}.git/HEAD`, { cache: "no-store" });
    const deniedHead = await fetch(`${baseUrl}.git/HEAD`, { method: "HEAD", cache: "no-store" });
    if (deniedGet.status !== 403 || deniedHead.status !== 403) {
      throw new Error(`/.git/HEAD 应一致返回 403，实际 GET ${deniedGet.status} / HEAD ${deniedHead.status}`);
    }
    return { missing: 2, denied: deniedGet.status };
  });

  await check("静态目录里的符号链接不能指向仓库外", async () => {
    // A path prefix check cannot see symlinks; the server realpaths the target
    // before reading, so a link inside js/ must not leak an outside file.
    const linkName = `_symlink-probe-${process.pid}.txt`;
    const linkPath = path.join(ROOT, "js", linkName);
    const outside = path.join(os.tmpdir(), `pcl-outside-${process.pid}.txt`);
    const marker = "outside-the-repository";
    fs.writeFileSync(outside, marker);
    try {
      try {
        fs.symlinkSync(outside, linkPath);
      } catch (error) {
        // Windows without developer mode cannot create symlinks; the check is
        // still meaningful on CI and on POSIX, so skip rather than fail.
        return { skipped: `符号链接不可用：${error.code}` };
      }
      const response = await fetch(`${baseUrl}js/${linkName}`, { cache: "no-store" });
      if (response.status !== 404) {
        const body = await response.text();
        throw new Error(
          `越界符号链接应返回 404，实际 ${response.status}${body.includes(marker) ? "（泄露了仓库外内容）" : ""}`
        );
      }
      return { status: 404 };
    } finally {
      try {
        fs.rmSync(linkPath, { force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(outside, { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  return { ok: results.every((item) => item.ok), results };
};

const main = async () => {
  if (args.has("--help")) {
    console.log("用法：node tools/regression.mjs [--presets|--all]");
    console.log("  默认运行本地确定性回归测试。");
    console.log("  --presets 运行 PCL 25 个预设的在线批量验收。");
    console.log("  --all 同时运行两者。");
    return;
  }

  const serverPort = await freePort();
  const baseUrl = `http://127.0.0.1:${serverPort}/`;
  let serverProcess = null;
  let browser = null;

  try {
    serverProcess = await startServer(serverPort);
    let failed = false;

    if (WANT_REGRESSION) {
      const networkResult = await runNetworkChecks(baseUrl);
      printRegression(networkResult);
      if (!networkResult.ok) failed = true;
    }

    browser = await startBrowser(baseUrl);

    if (WANT_REGRESSION) {
      const result = await loadSuite(browser.cdp, browser.sessionId, baseUrl, "runRegression");
      printRegression(result);
      if (!result.ok) failed = true;

      await browser.cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 375, height: 667, deviceScaleFactor: 1, mobile: true },
        browser.sessionId
      );
      try {
        const mobileResult = await loadSuite(browser.cdp, browser.sessionId, baseUrl, "runMobileRegression");
        printRegression(mobileResult);
        if (!mobileResult.ok) failed = true;
      } finally {
        await browser.cdp.send("Emulation.clearDeviceMetricsOverride", {}, browser.sessionId);
      }

      // The auto appearance follows the system, so drive prefers-color-scheme
      // both ways instead of trusting whatever the host OS reports.
      for (const scheme of ["dark", "light"]) {
        await browser.cdp.send(
          "Emulation.setEmulatedMedia",
          { features: [{ name: "prefers-color-scheme", value: scheme }] },
          browser.sessionId
        );
        try {
          const autoResult = await loadSuite(browser.cdp, browser.sessionId, baseUrl, "runAppearanceAutoCheck");
          printRegression(autoResult);
          if (!autoResult.ok) failed = true;
        } finally {
          await browser.cdp.send("Emulation.setEmulatedMedia", { features: [] }, browser.sessionId);
        }
      }
    }

    if (WANT_PRESETS) {
      const result = await loadSuite(browser.cdp, browser.sessionId, baseUrl, "runPresetAudit");
      printAudit(result);
      console.log(`报告：${saveReport("preset-audit.json", result)}`);
      if (!result.ok) failed = true;
    }

    // Runs last: it navigates the tab to home.html, a different document.
    if (WANT_REGRESSION) {
      const homeResult = await loadHomeSuite(browser.cdp, browser.sessionId, baseUrl);
      printRegression(homeResult);
      if (!homeResult.ok) failed = true;
    }

    process.exitCode = failed ? 1 : 0;
  } finally {
    await cleanupBrowser(browser);
    serverProcess?.kill();
  }
};

const isContextDestroyed = (error) =>
  /Execution context was destroyed|Cannot find context|Inspected target navigated|Target closed|Session closed/i.test(
    String(error?.message || error)
  );

const loadSuite = async (cdp, sessionId, baseUrl, method) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await waitFor(
        () =>
          evaluate(
            cdp,
            sessionId,
            "document.readyState === 'complete' && window.__PCL_RENDERER__?.ready === true"
          ).catch(() => false),
        { timeout: 30000, label: "应用就绪" }
      );
      await cdp.send("Runtime.enable", {}, sessionId);
      const moduleUrl = new URL(`/tools/test-suite.js?t=${Date.now()}-${attempt}`, baseUrl).href;
      const expression = `(async () => {
        const module = await import(${JSON.stringify(moduleUrl)});
        return await module.${method}();
      })()`;
      return await evaluate(cdp, sessionId, expression, 240000);
    } catch (error) {
      lastError = error;
      if (!isContextDestroyed(error) || attempt === 2) throw error;
      await sleep(300);
    }
  }
  throw lastError;
};

// home.html is a separate document with its own entry (js/home.js), so its
// checks need their own navigation and readiness probe.
const loadHomeSuite = async (cdp, sessionId, baseUrl) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false },
        sessionId
      );
      await cdp.send("Page.navigate", { url: new URL("/home.html", baseUrl).href }, sessionId);
      await waitFor(
        () =>
          evaluate(cdp, sessionId, "document.readyState === 'complete' && window.__PCL_HOME__?.ready === true").catch(
            () => false
          ),
        { timeout: 30000, label: "独立主页页就绪" }
      );
      await cdp.send("Runtime.enable", {}, sessionId);
      const moduleUrl = new URL(`/tools/home-suite.js?t=${Date.now()}-${attempt}`, baseUrl).href;
      const expression = `(async () => {
        const module = await import(${JSON.stringify(moduleUrl)});
        return await module.runHomeCheck();
      })()`;
      return await evaluate(cdp, sessionId, expression, 180000);
    } catch (error) {
      lastError = error;
      if (!isContextDestroyed(error) || attempt === 2) throw error;
      await sleep(400);
    }
  }
  throw lastError;
};

main().catch((error) => {
  console.error(`测试运行失败：${error?.stack || error}`);
  process.exitCode = 1;
});
