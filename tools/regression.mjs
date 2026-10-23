import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const findOnPath = (name) => {
  const extensions = process.platform === "win32" ? [".exe", ""] : [""];
  for (const folder of String(process.env.PATH || "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(folder, `${name}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
};

const findBrowser = () => {
  const candidates = [
    process.env.PCL_TEST_BROWSER,
    process.platform === "win32" &&
      path.join(process.env["PROGRAMFILES"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    process.platform === "win32" &&
      path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    process.platform === "win32" &&
      path.join(process.env["PROGRAMFILES"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    process.platform === "win32" &&
      path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    findOnPath("google-chrome"),
    findOnPath("chromium"),
    findOnPath("chromium-browser"),
    findOnPath("msedge")
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
};

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
    browser = await startBrowser(baseUrl);
    let failed = false;

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

main().catch((error) => {
  console.error(`测试运行失败：${error?.stack || error}`);
  process.exitCode = 1;
});
