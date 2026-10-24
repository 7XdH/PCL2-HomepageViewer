import { PclRenderer } from "../js/renderer.js";
import { PclRuntime } from "../js/runtime.js";
import { PclXamlError, parseXaml, substitutePlaceholders } from "../js/xaml.js";
import { getProxyUaCandidates, PCL_FALLBACK_UA } from "../js/ua.js";
import { resolveHelpUrls, resolveHelpXamlUrl, helpJsonTitle, helpTitleFromXaml } from "../js/help.js";
import { isOpenableExternalUrl, isMinecraftUrl, normalizeExternalUrl } from "../js/url.js";
import { isSvgResponse, svgResponseHeaders } from "../api/proxy-policy.js";
import { SHELL_PREF_KEY, readShellPreferences, saveShellPreferences } from "../js/shell/helpers.js";
import {
  MAX_SOURCE_BYTES,
  MAX_XAML_DEPTH,
  MAX_XAML_NODES,
  assertSourceWithinLimit,
  formatByteSize
} from "../js/limits.js";
import { PCL_PRESETS, PCL_TEST_UA } from "./pcl-presets.mjs";

const LOCAL_PRESETS = [
  { name: "PCL 原版教程", path: "/assets/presets/tutorial.xaml" },
  { name: "控件画廊", path: "/assets/presets/gallery.xaml" },
  { name: "事件测试台", path: "/assets/presets/events.xaml" },
  { name: "你知道吗", path: "/assets/presets/hint.xaml" }
];

const PRESET_AUDIT_CONCURRENCY = 4;
const PRESET_AUDIT_FETCH_TIMEOUT_MS = 15000;

const createHarness = (id = "pclRegressionRoot", { lazyImages = false } = {}) => {
  const root = document.createElement("div");
  root.id = id;
  root.style.cssText = "position:fixed;left:-20000px;top:0;width:500px;";
  document.body.append(root);

  const shell = {
    getVersion: () => "1.20.1-Fabric",
    getVersionInfo: () => ({ name: "1.20.1-Fabric", meta: "Fabric 0.15.11 · 今天 14:32" }),
    showModal: async () => 1,
    showHint: () => {},
    pushEvent: () => {},
    openUrl: () => true,
    copyText: async () => {},
    download: () => {}
  };
  const runtime = new PclRuntime({ shell, onRefresh: () => {}, onSettingChange: () => {} });
  const renderer = new PclRenderer({
    root,
    runtime,
    getProxyUas: () => getProxyUaCandidates(""),
    lazyImages
  });
  return { root, runtime, renderer };
};

const textOf = (node) =>
  String(node?.textContent || "")
    .replace(/\s+/g, " ")
    .trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForImages = async (root, timeout = 8000) => {
  const started = Date.now();
  let lastSignature = "";
  let stableTicks = 0;

  while (Date.now() - started < timeout) {
    const images = [...root.querySelectorAll("img")];
    const pending = images.some(
      (image) => !image.getAttribute("src") || !image.complete || image.parentElement?.classList.contains("is-loading")
    );
    const signature = images
      .map((image) => `${image.src}|${image.complete}|${image.naturalWidth}|${image.naturalHeight}`)
      .join(";");

    if (!pending && signature === lastSignature) stableTicks += 1;
    else stableTicks = 0;
    lastSignature = signature;

    if (!pending && stableTicks >= 2) return;
    await sleep(120);
  }
};

const measure = (root, result) => {
  const images = [...root.querySelectorAll("img")];
  return {
    controls: result.controls,
    duration: result.duration,
    warnings: result.warnings.slice(),
    issues: (result.issues || []).slice(),
    unsupported: root.querySelectorAll(".pcl-unsupported").length,
    cards: root.querySelectorAll(".pcl-card").length,
    images: images.length,
    brokenImages: images.filter((image) => image.naturalWidth === 0).length,
    textLength: textOf(root).length
  };
};

const fetchText = async (url) => {
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.trim().slice(0, 180)}`);
  return text;
};

const fetchRemoteXaml = async (url, runtime) => {
  const proxy = new URL("/api/proxy", location.origin);
  proxy.searchParams.set("url", substitutePlaceholders(url, runtime.context, { escape: false }));
  proxy.searchParams.set("ua", PCL_TEST_UA);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PRESET_AUDIT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(proxy, { cache: "no-store", signal: controller.signal });
    const text = await response.text();
    // Upstream 5xx reasons travel in X-PCL-Proxy-Status so CDNs cannot replace
    // them with a generic error page; surface the real status here.
    const reported = Number(response.headers.get("x-pcl-proxy-status"));
    if (Number.isFinite(reported) && reported >= 400) {
      throw new Error(`proxy HTTP ${reported}: ${text.trim().slice(0, 180)}`);
    }
    if (!response.ok) throw new Error(`proxy HTTP ${response.status}: ${text.trim().slice(0, 180)}`);
    if (!/^\s*</.test(text)) throw new Error(`proxy 返回的不是 XAML：${text.trim().slice(0, 100)}`);
    return text;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`proxy 请求超时（${PRESET_AUDIT_FETCH_TIMEOUT_MS / 1000} 秒）`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
};

const renderSource = async (harness, source, images = false) => {
  harness.root.replaceChildren();
  const result = harness.renderer.render(source);
  if (images) await waitForImages(harness.root);
  return measure(harness.root, result);
};
const makeCheck = (results, name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      results.push({ name, ok: true, detail });
    })
    .catch((error) => {
      results.push({ name, ok: false, error: String(error?.message || error) });
    });
};

export async function runRegression() {
  const harness = createHarness();
  const results = [];

  await makeCheck(results, "本地预设批量渲染", async () => {
    const rows = [];
    for (const preset of LOCAL_PRESETS) {
      const source = await fetchText(preset.path);
      const metrics = await renderSource(harness, source);
      rows.push({ name: preset.name, ...metrics });
      if (metrics.unsupported) throw new Error(`${preset.name} 出现 ${metrics.unsupported} 个不支持控件`);
      if (metrics.warnings.length) throw new Error(`${preset.name} 出现警告：${metrics.warnings[0]}`);
      if (!metrics.controls || !metrics.textLength) throw new Error(`${preset.name} 没有渲染出可见内容`);
    }
    return rows;
  });

  await makeCheck(results, "现有主页未超过大小上限", async () => {
    const rows = [];
    for (const preset of LOCAL_PRESETS) {
      const source = await fetchText(preset.path);
      const bytes = new TextEncoder().encode(source).byteLength;
      if (bytes > MAX_SOURCE_BYTES) {
        throw new Error(`${preset.name} 为 ${formatByteSize(bytes)}，超过上限`);
      }
      rows.push({ name: preset.name, bytes });
    }
    return {
      limit: formatByteSize(MAX_SOURCE_BYTES),
      max: formatByteSize(Math.max(...rows.map((row) => row.bytes))),
      rows
    };
  });

  await makeCheck(results, "远程图片懒加载属性", async () => {
    const lazyHarness = createHarness("pclLazyImageTest", { lazyImages: true });
    try {
      lazyHarness.renderer.render(
        '<StackPanel><Image Width="16" Height="16" Source="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" /></StackPanel>'
      );
      const image = lazyHarness.root.querySelector("img");
      if (!image) throw new Error("图片节点没有创建");
      if (image.loading !== "lazy" || image.getAttribute("loading") !== "lazy") {
        throw new Error(`loading 属性错误：${image.getAttribute("loading")}`);
      }
      if (image.decoding !== "async" || image.getAttribute("decoding") !== "async") {
        throw new Error(`decoding 属性错误：${image.getAttribute("decoding")}`);
      }
      return { loading: image.loading, decoding: image.decoding };
    } finally {
      lazyHarness.root.remove();
    }
  });

  await makeCheck(results, "重新渲染后旧图片回调不再改动新文档", async () => {
    // loadImageSource used to keep its onload/onerror alive across renders, so a
    // slow image from the previous source could repaint the new DOM (and log a
    // warning against it). Every render now bumps a generation token.
    const imageHarness = createHarness("pclStaleImageTest");
    try {
      const settled = [];
      const dataUrl = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
      imageHarness.renderer.loadImageSource(
        dataUrl,
        () => settled.push("load"),
        () => settled.push("error")
      );
      if (imageHarness.renderer.pendingImages.size !== 1) {
        throw new Error(`加载中应有 1 条待定请求，实际 ${imageHarness.renderer.pendingImages.size}`);
      }

      // Replace the document before the data URL finishes decoding.
      imageHarness.renderer.render(`<StackPanel><TextBlock Text="第二次渲染" /></StackPanel>`);
      if (imageHarness.renderer.pendingImages.size !== 0) {
        throw new Error(`重渲染后待定请求应清空，实际 ${imageHarness.renderer.pendingImages.size}`);
      }

      await sleep(400);
      if (settled.length) {
        throw new Error(`旧请求的回调仍被执行：${settled.join("、")}`);
      }
      if (imageHarness.renderer.warnings.length) {
        throw new Error(`旧请求向新文档写入警告：${imageHarness.renderer.warnings.join("；")}`);
      }
      if (imageHarness.root.textContent.trim() !== "第二次渲染") {
        throw new Error(`新文档被改动：${imageHarness.root.textContent.trim()}`);
      }

      // A fresh call in the current generation still settles normally.
      const fresh = [];
      imageHarness.renderer.loadImageSource(
        dataUrl,
        () => fresh.push("load"),
        () => fresh.push("error")
      );
      await sleep(400);
      if (fresh[0] !== "load") throw new Error(`当前代次的图片未回调：${fresh.join("、") || "无"}`);
      return { stale: settled.length, fresh: fresh.length };
    } finally {
      imageHarness.root.remove();
    }
  });

  await makeCheck(results, "大小上限拒绝超限内容", async () => {
    const oversized = "x".repeat(MAX_SOURCE_BYTES + 1);
    let error;
    try {
      assertSourceWithinLimit(oversized, "测试主页");
    } catch (caught) {
      error = caught;
    }
    if (!error || error.code !== "SOURCE_TOO_LARGE") {
      throw new Error("超限内容没有被拒绝");
    }
    if (!error.message.includes("超过") || !error.message.includes("4.0 MiB")) {
      throw new Error(`超限错误信息不完整：${error.message}`);
    }
    if (assertSourceWithinLimit("<StackPanel />") !== "<StackPanel />") {
      throw new Error("未超限内容被错误拒绝");
    }
    return { limit: formatByteSize(MAX_SOURCE_BYTES), rejected: true };
  });

  await makeCheck(results, "PCL2 预设面板", async () => {
    const list = document.getElementById("pclPresetList");
    const search = document.getElementById("pclPresetSearch");
    if (!list || !search) throw new Error("找不到 PCL2 预设面板");
    const total = list.querySelectorAll("[data-preset]").length;
    if (total !== PCL_PRESETS.length) {
      throw new Error(`预设数量错误：${total}，期望 ${PCL_PRESETS.length}`);
    }
    if (!list.querySelector(".preset-state--blocked")) throw new Error("安全阻止状态没有显示");
    if (!list.querySelector(".preset-state--warn")) throw new Error("上游不可用状态没有显示");

    search.value = "天气";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(60);
    const filtered = [...list.querySelectorAll("[data-preset]")];
    if (filtered.length !== 1 || !filtered[0].textContent.includes("Weather")) {
      throw new Error(`搜索结果不正确：${filtered.map((item) => item.textContent.trim()).join(" | ")}`);
    }

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(60);
    if (list.querySelectorAll("[data-preset]").length !== PCL_PRESETS.length) {
      throw new Error("清空搜索后没有恢复完整列表");
    }

    const inline = list.querySelector('[data-preset="pcl2-0"]');
    if (!inline) throw new Error("找不到内联预设 #00");
    inline.click();
    const started = Date.now();
    let source = "";
    while (Date.now() - started < 3000) {
      source = document.getElementById("sourceLabel")?.textContent || "";
      if (source.includes("PCL2") && inline.classList.contains("is-active")) break;
      await sleep(50);
    }
    if (!source.includes("PCL2 · 你知道吗") || !inline.classList.contains("is-active")) {
      throw new Error(`内联预设没有正确激活：${source}`);
    }
    return { total, filtered: filtered.length };
  });

  await makeCheck(results, "版本切换高亮跟随当前版本", async () => {
    const shell = window.__PCL_RENDERER__?.shell;
    const card = document.getElementById("pclVersionCard");
    const versionName = document.getElementById("pclVersionName");
    if (!shell?.setVersion || !card || !versionName) throw new Error("找不到版本切换入口");

    const initial = versionName.textContent;
    card.click();
    await sleep(140);
    let buttons = [...document.querySelectorAll("#pclModalButtons button")];
    if (!buttons.length) throw new Error("版本选择弹窗没有打开");
    let highlighted = buttons.find((button) => button.classList.contains("pcl-modal__button--highlight"));
    if (!highlighted || highlighted.textContent !== initial) {
      throw new Error(`初始高亮错误：期望 ${initial}，实际 ${highlighted?.textContent || "无"}`);
    }

    const target = buttons.find((button) => button.textContent !== initial && button.textContent !== "取消");
    if (!target) throw new Error("找不到另一个可切换版本");
    target.click();
    await sleep(280);
    if (versionName.textContent !== target.textContent) {
      throw new Error(`版本没有切换：期望 ${target.textContent}，实际 ${versionName.textContent}`);
    }

    card.click();
    await sleep(140);
    buttons = [...document.querySelectorAll("#pclModalButtons button")];
    highlighted = buttons.find((button) => button.classList.contains("pcl-modal__button--highlight"));
    if (!highlighted || highlighted.textContent !== target.textContent) {
      throw new Error(`切换后高亮错误：期望 ${target.textContent}，实际 ${highlighted?.textContent || "无"}`);
    }
    buttons.find((button) => button.textContent === "取消")?.click();
    await sleep(280);
    shell.setVersion(initial);
    return { from: initial, to: target.textContent };
  });

  await makeCheck(results, "版本与账户选择持久化", async () => {
    const shell = window.__PCL_RENDERER__?.shell;
    if (!shell?.setVersion || !shell?.toggleAccount) {
      throw new Error("找不到版本/账户接口");
    }
    const original = localStorage.getItem(SHELL_PREF_KEY);
    const originalVersion = shell.version;
    const originalAccount = shell.account.name;
    try {
      saveShellPreferences({ version: "1.19.2-Forge", account: "Alex" });
      const saved = readShellPreferences();
      if (saved.version !== "1.19.2-Forge" || saved.account !== "Alex") {
        throw new Error(`偏好读取错误：${JSON.stringify(saved)}`);
      }
      shell.setVersion("1.19.2-Forge");
      if (readShellPreferences().version !== "1.19.2-Forge") {
        throw new Error("版本切换没有写入 localStorage");
      }
      if (shell.account.name === "Steve") shell.toggleAccount();
      if (readShellPreferences().account !== shell.account.name) {
        throw new Error("账户切换没有写入 localStorage");
      }
      localStorage.setItem(SHELL_PREF_KEY, "{ invalid json");
      const fallback = readShellPreferences();
      if (fallback.version !== "1.20.1-Fabric" || fallback.account !== "Steve") {
        throw new Error(`损坏偏好没有回退默认值：${JSON.stringify(fallback)}`);
      }
      return { version: saved.version, account: saved.account };
    } finally {
      shell.setVersion(originalVersion);
      if (shell.account.name !== originalAccount) shell.toggleAccount();
      if (original === null) localStorage.removeItem(SHELL_PREF_KEY);
      else localStorage.setItem(SHELL_PREF_KEY, original);
    }
  });

  await makeCheck(results, "使用说明弹窗滚动布局", async () => {
    const helpButton = document.getElementById("helpBtn");
    if (!helpButton) throw new Error("找不到使用说明按钮");
    helpButton.click();
    await sleep(420);

    const modal = document.querySelector("#pclModalLayer .pcl-modal");
    const title = modal?.querySelector(".pcl-modal__title");
    const caption = modal?.querySelector(".pcl-modal__caption");
    const buttons = modal?.querySelector(".pcl-modal__buttons");
    if (!modal || !title || !caption || !buttons) throw new Error("使用说明弹窗结构不完整");

    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pcl-scale")) || 1;
    const modalRect = modal.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const captionRect = caption.getBoundingClientRect();
    const buttonsRect = buttons.getBoundingClientRect();
    const captionTop = (captionRect.top - modalRect.top) / scale;

    if (modal.scrollTop !== 0) throw new Error(`弹窗被整体滚动：${modal.scrollTop}px`);
    if (titleRect.top < modalRect.top - 0.5) throw new Error("弹窗标题被裁切到窗口上方");
    if (captionTop < 40) throw new Error(`正文滚动条顶部离弹窗上边过近：${captionTop.toFixed(1)}px`);
    if (buttonsRect.bottom > modalRect.bottom + 0.5) throw new Error("弹窗按钮被裁切");
    if (caption.scrollHeight <= caption.clientHeight) throw new Error("使用说明正文没有产生滚动区域");

    [...document.querySelectorAll("#pclModalButtons button")]
      .find((button) => button.textContent === "知道了")
      ?.click();
    await sleep(280);
    return { captionTop, captionHeight: caption.clientHeight };
  });

  await makeCheck(results, "弹窗焦点与背景锁定", async () => {
    const helpButton = document.getElementById("helpBtn");
    if (!helpButton) throw new Error("找不到使用说明按钮");
    helpButton.click();
    await sleep(420);

    const layer = document.getElementById("pclModalLayer");
    const dialog = layer?.querySelector(".pcl-modal");
    const sidebar = document.getElementById("pclSidebar");
    const titlebar = document.getElementById("pclTitlebar");
    const pageHost = document.querySelector(".pcl-page-host");
    const hintStack = document.getElementById("pclHintStack");
    const labPanel = document.querySelector(".lab-panel");
    const buttons = [...(document.querySelectorAll("#pclModalButtons button") || [])];
    const isInert = (element) => Boolean(element?.inert || element?.closest?.("[inert]"));
    try {
      if (!layer || !dialog || !sidebar || !titlebar || !pageHost || !hintStack) {
        throw new Error("弹窗或背景结构不完整");
      }
      if (dialog.getAttribute("aria-describedby") !== "pclModalCaption") {
        throw new Error("弹窗缺少 aria-describedby");
      }
      if (!isInert(sidebar) || !isInert(titlebar) || !isInert(pageHost) || !isInert(hintStack)) {
        throw new Error("弹窗打开后 PCL 窗口背景没有进入 inert");
      }
      if (!isInert(labPanel)) throw new Error("弹窗打开后工具面板没有进入 inert");
      if (isInert(layer) || isInert(dialog)) throw new Error("弹窗自身被错误锁定");
      if (!dialog.contains(document.activeElement)) throw new Error("焦点没有进入弹窗");

      if (buttons.length < 2) throw new Error("弹窗按钮不足，无法验证焦点循环");
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      last.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      if (document.activeElement !== first) throw new Error("Tab 没有循环到第一个按钮");
      first.focus();
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })
      );
      if (document.activeElement !== last) throw new Error("Shift+Tab 没有循环到最后一个按钮");
      return { inert: true, describedBy: "pclModalCaption", buttons: buttons.length };
    } finally {
      [...document.querySelectorAll("#pclModalButtons button")]
        .find((button) => button.textContent === "知道了")
        ?.click();
      await sleep(280);
      if (isInert(sidebar) || isInert(titlebar) || isInert(pageHost) || isInert(hintStack) || isInert(labPanel)) {
        throw new Error("弹窗关闭后背景 inert 没有恢复");
      }
    }
  });

  await makeCheck(results, "外部链接协议白名单", async () => {
    const cases = [
      ["https://example.com", true],
      ["http://example.com", true],
      ["mailto:test@example.com", true],
      ["minecraft://", true],
      ["minecraft-preview://", true],
      ["minecraft:", false],
      ["minecraft://?launch=foo", true],
      ["ftp://example.com", false],
      ["steam://run/730", false],
      ["file:///C:/Windows/System32/calc.exe", false],
      ["javascript://%0Aalert(1)", false],
      ["data:text/html,<script>alert(1)</script>", false]
    ];
    for (const [url, expected] of cases) {
      if (isOpenableExternalUrl(url) !== expected) {
        throw new Error(`协议判断错误：${url} 应为 ${expected ? "允许" : "拒绝"}`);
      }
    }
    if (normalizeExternalUrl("https://example.com") !== "https://example.com/") {
      throw new Error(`URL 规范化错误：${normalizeExternalUrl("https://example.com")}`);
    }
    if (!isMinecraftUrl("minecraft://") || !isMinecraftUrl("minecraft-preview://")) {
      throw new Error("Minecraft 启动器协议识别失败");
    }

    const modalTitles = [];
    let opened = 0;
    const originalModal = harness.runtime.shell.showModal;
    const originalOpenUrl = harness.runtime.shell.openUrl;
    harness.runtime.shell.showModal = async (options) => {
      modalTitles.push(options.title);
      return 1;
    };
    harness.runtime.shell.openUrl = () => {
      opened += 1;
      return true;
    };
    let invalidResult;
    try {
      invalidResult = await harness.runtime.handle("打开网页", "javascript://%0Aalert(1)");
      const validResult = await harness.runtime.handle("打开网页", "https://example.com");
      const minecraftResult = await harness.runtime.handle("打开网页", "minecraft://");
      if (invalidResult !== "invalid-url") throw new Error(`非法协议返回值错误：${invalidResult}`);
      if (validResult !== "https://example.com") throw new Error(`合法协议返回值错误：${validResult}`);
      if (minecraftResult !== "minecraft://") throw new Error(`Minecraft 协议返回值错误：${minecraftResult}`);
    } finally {
      harness.runtime.shell.showModal = originalModal;
      harness.runtime.shell.openUrl = originalOpenUrl;
    }
    if (opened !== 2) throw new Error(`合法协议打开次数错误：实际 ${opened} 次`);
    if (!modalTitles.includes("事件执行失败")) throw new Error("非法协议没有显示错误弹窗");
    return { cases: cases.length, opened };
  });

  await makeCheck(results, "事件日志不截断长内容", async () => {
    const shell = window.__PCL_RENDERER__?.shell;
    if (!shell) throw new Error("找不到 Shell");
    const eventText = document.getElementById("eventText");
    const eventCount = document.getElementById("eventCount");
    if (!eventText) throw new Error("找不到事件条");

    const savedEvents = shell.events.slice();
    const savedText = eventText.textContent;
    const savedStatus = eventText.dataset.status;
    const savedCount = eventCount?.textContent;
    const longData = `长事件数据-${"内容".repeat(160)}-END`;
    try {
      shell.pushEvent({
        type: "长事件测试",
        data: longData,
        status: "ok",
        message: "完整保留",
        time: Date.now()
      });
      const rendered = eventText.textContent;
      if (!rendered.includes(longData)) throw new Error("底部事件条截断了长数据");
      if (!shell.formatEventLog().includes(longData)) throw new Error("事件日志弹窗截断了长数据");
      const style = getComputedStyle(eventText);
      if (style.whiteSpace === "nowrap" || style.textOverflow === "ellipsis") {
        throw new Error(`事件条仍使用截断样式：white-space=${style.whiteSpace}, text-overflow=${style.textOverflow}`);
      }
      const strip = eventText.closest(".event-strip");
      if (!strip) throw new Error("找不到事件条容器");
      if (strip.scrollHeight > strip.clientHeight + 1 || strip.scrollWidth > strip.clientWidth + 1) {
        throw new Error(
          `事件条发生裁切：${strip.scrollWidth}×${strip.scrollHeight} > ${strip.clientWidth}×${strip.clientHeight}`
        );
      }
      if (strip.getBoundingClientRect().height <= 32) throw new Error("长事件没有撑高事件条");
      return { length: longData.length, height: strip.getBoundingClientRect().height };
    } finally {
      shell.events.splice(0, shell.events.length, ...savedEvents);
      eventText.textContent = savedText;
      if (savedStatus) eventText.dataset.status = savedStatus;
      else delete eventText.dataset.status;
      if (eventCount && savedCount != null) eventCount.textContent = savedCount;
    }
  });

  await makeCheck(results, "静态服务器只发布白名单内的文件", async () => {
    const denied = ["/.git/HEAD", "/node_modules/.package-lock.json", "/README.md", "/server.js", "/package.json"];
    for (const path of denied) {
      const response = await fetch(path, { cache: "no-store" });
      if (response.status !== 403) {
        throw new Error(`${path} 应返回 403，实际 ${response.status}`);
      }
    }
    const allowed = ["/css/app.css", "/js/app.js", "/assets/presets/tutorial.xaml", "/home.html"];
    for (const path of allowed) {
      const response = await fetch(path, { cache: "no-store" });
      if (response.status !== 200) {
        throw new Error(`${path} 应返回 200，实际 ${response.status}`);
      }
    }
    return { denied: denied.length, allowed: allowed.length };
  });

  await makeCheck(results, "远程 SVG 沙箱响应", async () => {
    if (!isSvgResponse("image/svg+xml; charset=utf-8", "https://example.com/icon.png")) {
      throw new Error("SVG Content-Type 没有被识别");
    }
    if (!isSvgResponse("application/octet-stream", "https://example.com/icon.svg")) {
      throw new Error("SVG 扩展名没有被识别");
    }
    if (isSvgResponse("image/png", "https://example.com/icon.png")) {
      throw new Error("PNG 被错误识别为 SVG");
    }
    const headers = svgResponseHeaders();
    const csp = headers["Content-Security-Policy"] || "";
    for (const directive of ["default-src 'none'", "script-src 'none'", "object-src 'none'", "sandbox"]) {
      if (!csp.includes(directive)) throw new Error(`SVG CSP 缺少 ${directive}`);
    }
    headers["Content-Security-Policy"] = "tampered";
    if (svgResponseHeaders()["Content-Security-Policy"] === "tampered") {
      throw new Error("SVG 响应头可以被调用方篡改");
    }
    return { csp };
  });

  await makeCheck(results, "本地代理 SSRF 防护", async () => {
    const cases = [
      ["http://127.0.0.1/", 403],
      ["http://localhost/", 403],
      ["http://example.com:8080/", 403]
    ];
    for (const [target, expected] of cases) {
      const response = await fetch(`/api/proxy?url=${encodeURIComponent(target)}`, { cache: "no-store" });
      const body = await response.text();
      if (response.status !== expected) {
        throw new Error(`${target} 应返回 ${expected}，实际 ${response.status}：${body.slice(0, 120)}`);
      }
      if (response.headers.get("access-control-allow-origin") !== "*") {
        throw new Error("代理响应缺少 Access-Control-Allow-Origin");
      }
    }
    return { cases: cases.length };
  });

  await makeCheck(results, "代理失败原因不被 CDN 覆盖", async () => {
    // Cloudflare replaces any 5xx body from the origin, so upstream failures
    // must arrive as a 200 carrying X-PCL-Proxy-Status. Without this the viewer
    // loses the reason and wrongly reports "no /api/proxy on this deployment".
    // The probe goes out to the real internet, so a transient DNS hiccup on the
    // build machine must not fail the suite: retry the readable-reason part.
    const probe = async () => {
      const response = await fetch(
        "/api/proxy?url=" + encodeURIComponent("https://raw.githubusercontent.com/nonexistent-zz/y.yaml"),
        { cache: "no-store" }
      );
      return { response, body: await response.text() };
    };
    let reason = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { response, body } = await probe();
      if (response.status !== 200) {
        throw new Error(`上游 404 时不应再返回 ${response.status}，否则会被 CDN 替换成通用错误页`);
      }
      const reported = response.headers.get("x-pcl-proxy-status");
      if (reported !== "502") throw new Error(`X-PCL-Proxy-Status 应为 502，实际 ${reported}`);
      // A CDN error page is what this test exists to rule out.
      if (/error code:? ?5\d\d/i.test(body)) throw new Error(`拿到的仍是 CDN 通用错误页：${body.slice(0, 120)}`);
      if (body.trim()) {
        reason = body.trim();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (!reason) throw new Error("代理没有给出任何失败原因");
    // Image mode keeps the real status so <img> onerror still fires.
    const image = await fetch(
      "/api/proxy?url=" + encodeURIComponent("https://raw.githubusercontent.com/nonexistent-zz/y.png") + "&image=1",
      { cache: "no-store" }
    );
    if (image.status < 400) {
      throw new Error(`图片失败应保留 4xx/5xx 状态，实际 ${image.status}`);
    }
    return { reason: reason.slice(0, 60), imageStatus: image.status };
  });

  await makeCheck(results, "XAML 安全过滤", async () => {
    const blocked = [
      "<local:WebBrowser />",
      '<local:MyCard Code="alert(1)" />',
      '<TextBlock Text="{x:Static local:Evil.Value}" />',
      "<local:Frame />"
    ];
    for (const source of blocked) {
      try {
        parseXaml(source);
        throw new Error(`危险 XAML 未被拒绝：${source}`);
      } catch (error) {
        if (error.message.startsWith("危险 XAML 未被拒绝")) throw error;
        if (!(error instanceof PclXamlError)) throw error;
      }
    }
    const root = parseXaml('<StackPanel><TextBlock Text="安全内容" /></StackPanel>');
    if (!root.querySelector("TextBlock") && !root.querySelector("*")) {
      throw new Error("合法 XAML 没有解析出节点");
    }
    return { blocked: blocked.length };
  });

  await makeCheck(results, "XAML 的节点数与嵌套层级有上限", async () => {
    // Deep nesting: building nodes recursively would otherwise overflow the
    // stack long before any size limit notices.
    const deep = `${"<StackPanel>".repeat(MAX_XAML_DEPTH + 5)}<TextBlock Text="深" />${"</StackPanel>".repeat(
      MAX_XAML_DEPTH + 5
    )}`;
    try {
      parseXaml(deep);
      throw new Error("过深的 XAML 未被拒绝");
    } catch (error) {
      if (error.message.startsWith("过深的 XAML")) throw error;
      if (!(error instanceof PclXamlError)) throw error;
      if (!error.message.includes(`${MAX_XAML_DEPTH} 层`)) {
        throw new Error(`层级错误提示不清晰：${error.message}`);
      }
    }

    // Too many nodes at a shallow depth.
    const wide = `<StackPanel>${'<TextBlock Text="行" />'.repeat(MAX_XAML_NODES + 50)}</StackPanel>`;
    try {
      parseXaml(wide);
      throw new Error("过大的 XAML 未被拒绝");
    } catch (error) {
      if (error.message.startsWith("过大的 XAML")) throw error;
      if (!(error instanceof PclXamlError)) throw error;
      if (!error.message.includes(`${MAX_XAML_NODES} 个`)) {
        throw new Error(`节点数错误提示不清晰：${error.message}`);
      }
    }

    // A realistic page at the limits must still parse.
    const ok = `<StackPanel>${'<TextBlock Text="行" />'.repeat(500)}</StackPanel>`;
    parseXaml(ok);
    return { maxNodes: MAX_XAML_NODES, maxDepth: MAX_XAML_DEPTH };
  });

  await makeCheck(results, "MyCard 按 Grid 叠放内容与渐变画刷", async () => {
    harness.renderer.render(`
      <local:MyCard Margin="0">
        <Image Height="20" Source="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" />
        <TextBlock Margin="40,2,0,0" Text="叠放内容" />
      </local:MyCard>
    `);
    const card = harness.root.querySelector(".pcl-card");
    const body = card?.querySelector(".pcl-card__body");
    const image = body?.querySelector(".pcl-image-wrap");
    const text = body?.querySelector(".pcl-text");
    if (!card || !body || !image || !text) throw new Error("MyCard 内容没有完整渲染");
    if (getComputedStyle(body).display !== "grid") throw new Error("MyCard 内容没有使用 Grid 叠放");
    const imageRect = image.getBoundingClientRect();
    const textRect = text.getBoundingClientRect();
    if (textRect.top >= imageRect.bottom) throw new Error("MyCard 子元素仍在纵向堆叠");

    harness.renderer.render(`
      <StackPanel>
        <Rectangle Width="100" Height="40">
          <Rectangle.Fill>
            <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
              <GradientStop Color="#FF0000" Offset="0" />
              <GradientStop Color="#0000FF" Offset="1" />
            </LinearGradientBrush>
          </Rectangle.Fill>
        </Rectangle>
        <Rectangle Width="20" Height="20">
          <Rectangle.Fill><SolidColorBrush Color="#00FF00" /></Rectangle.Fill>
        </Rectangle>
      </StackPanel>
    `);
    const shapes = [...harness.root.querySelectorAll(".pcl-shape")];
    if (shapes.length !== 2) throw new Error(`画刷控件数量错误：${shapes.length}`);
    const gradient = getComputedStyle(shapes[0]).backgroundImage;
    if (!gradient.includes("linear-gradient") || gradient.includes("rgba(0, 0, 0, 0)")) {
      throw new Error(`Rectangle.Fill 渐变没有生效：${gradient}`);
    }
    if (getComputedStyle(shapes[1]).backgroundColor !== "rgb(0, 255, 0)") {
      throw new Error("Rectangle.Fill 纯色画刷没有生效");
    }
    return { gradient };
  });

  await makeCheck(results, "无尺寸 MyImage 在格子中按 Stretch 填满，堆叠中保留原尺寸", async () => {
    // PCL banners rely on a stretched <Image> filling its Border/Grid cell.
    // Stack children keep their intrinsic bitmap size.
    const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    harness.renderer.render(`
      <StackPanel>
        <Border Height="200">
          <Image Source="${pixel}" Stretch="UniformToFill" HorizontalAlignment="Stretch" VerticalAlignment="Stretch" />
        </Border>
        <Grid Height="120">
          <Image Source="${pixel}" Stretch="UniformToFill" HorizontalAlignment="Stretch" VerticalAlignment="Stretch" />
        </Grid>
        <Image Source="${pixel}" />
      </StackPanel>
    `);
    const wraps = [...harness.root.querySelectorAll(".pcl-image-wrap")];
    if (wraps.length !== 3) throw new Error(`图片数量错误：${wraps.length}`);
    const inBorder = wraps[0].getBoundingClientRect();
    const inGrid = wraps[1].getBoundingClientRect();
    const inStack = wraps[2].getBoundingClientRect();
    if (Math.round(inBorder.height) !== 200) {
      throw new Error(`Border 内图片没有填满高度：${inBorder.height}`);
    }
    if (Math.round(inGrid.height) !== 120) {
      throw new Error(`Grid 内图片没有填满高度：${inGrid.height}`);
    }
    if (!wraps[0].classList.contains("pcl-image-wrap--fill")) {
      throw new Error("Border 内图片没有启用填充类");
    }
    if (inStack.height > 60) throw new Error(`堆叠中的图片被拉伸：${inStack.height}`);
    return { inBorder: Math.round(inBorder.height), inGrid: Math.round(inGrid.height) };
  });

  // PCL's news homepage paints its version banner with a style that sets
  // `Stretch=UniformToFill` plus `VerticalAlignment=Center`: WPF measures the
  // image at the slot size because UniformToFill can never be smaller than the
  // slot, so the bitmap covers the border and the overflow is clipped top and
  // bottom. Treating the centered alignment as "do not fill" left the banner
  // letterboxed with empty margins on the left and right.
  await makeCheck(results, "UniformToFill 图片即使垂直居中也会铺满并裁剪", async () => {
    const wide =
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1170" height="500"><rect width="1170" height="500" fill="#127ae1"/></svg>'
      );
    harness.renderer.render(`
      <StackPanel>
        <Border Width="460" MaxHeight="140" BorderThickness="4" VerticalAlignment="Top">
          <Image Source="${wide}" Stretch="UniformToFill" VerticalAlignment="Center" />
        </Border>
      </StackPanel>
    `);
    const wrap = harness.root.querySelector(".pcl-image-wrap");
    const border = harness.root.querySelector(".pcl-border");
    const frame = border.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    if (!wrap.classList.contains("pcl-image-wrap--fill")) {
      throw new Error("UniformToFill + VerticalAlignment=Center 没有启用填充");
    }
    const inner = frame.width - 8;
    if (Math.abs(box.width - inner) > 1) {
      throw new Error(`图片没有铺满边框宽度：${box.width.toFixed(1)} vs ${inner.toFixed(1)}`);
    }
    const img = wrap.querySelector("img");
    if (img.style.width !== "100%" || img.style.height !== "100%") {
      throw new Error(`图片没有撑满容器：${img.style.width} × ${img.style.height}`);
    }
    if (img.style.objectFit !== "cover") throw new Error(`UniformToFill 应映射为 cover，实际 ${img.style.objectFit}`);
    return { width: Math.round(box.width), height: Math.round(box.height) };
  });

  await makeCheck(results, "Border.Background 的 ImageBrush 按 Stretch 与对齐铺满", async () => {
    // PCL wallpapers paint a full-bleed Border background with
    // <Border.Background><ImageBrush …/></Border.Background>; resolveColor
    // cannot read that property element, so the brush has to be resolved.
    const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    harness.renderer.render(`
      <StackPanel>
        <Border Width="200" Height="100">
          <Border.Background>
            <ImageBrush ImageSource="${pixel}" Stretch="UniformToFill" AlignmentX="Center" AlignmentY="Center" />
          </Border.Background>
        </Border>
        <Border Width="200" Height="100">
          <Border.Background>
            <ImageBrush ImageSource="${pixel}" Stretch="Uniform" AlignmentX="Left" AlignmentY="Top" />
          </Border.Background>
        </Border>
        <Border Width="200" Height="100">
          <Border.Background>
            <ImageBrush ImageSource="${pixel}" Stretch="Fill" AlignmentX="Right" AlignmentY="Bottom" />
          </Border.Background>
        </Border>
        <Border Width="200" Height="100" Background="#FF224466" />
      </StackPanel>
    `);
    const borders = [...harness.root.querySelectorAll(".pcl-border")];
    if (borders.length !== 4) throw new Error(`Border 数量错误：${borders.length}`);
    const brushes = borders.slice(0, 3).map((node) => {
      const style = getComputedStyle(node);
      return {
        image: style.backgroundImage,
        size: style.backgroundSize,
        position: style.backgroundPosition,
        repeat: style.backgroundRepeat
      };
    });
    const expected = [
      { size: "cover", position: "50% 50%" },
      { size: "contain", position: "0% 0%" },
      { size: "100% 100%", position: "100% 100%" }
    ];
    brushes.forEach((brush, index) => {
      if (!brush.image.startsWith("url(")) throw new Error(`第 ${index + 1} 个 ImageBrush 没有生成背景图`);
      if (brush.size !== expected[index].size) {
        throw new Error(`第 ${index + 1} 个 background-size 错误：${brush.size} != ${expected[index].size}`);
      }
      if (brush.position !== expected[index].position) {
        throw new Error(`第 ${index + 1} 个 background-position 错误：${brush.position}`);
      }
      if (brush.repeat !== "no-repeat") throw new Error(`第 ${index + 1} 个 background-repeat 错误：${brush.repeat}`);
    });
    const solid = getComputedStyle(borders[3]);
    if (solid.backgroundImage !== "none") throw new Error("普通 Background 被误加背景图");
    if (!solid.backgroundColor.includes("34, 68, 102")) {
      throw new Error(`普通 Background 颜色丢失：${solid.backgroundColor}`);
    }
    return { brushes };
  });

  await makeCheck(results, "MyCheckBox 读取 PCL 的 Checked 属性并保留 IsChecked 兼容", async () => {
    harness.renderer.render(`
      <StackPanel>
        <local:MyCheckBox Text="勾选我的世界" Checked="True" />
        <local:MyCheckBox Text="未勾选" Checked="False" />
        <local:MyCheckBox Text="WPF 写法" IsChecked="True" />
      </StackPanel>
    `);
    const boxes = [...harness.root.querySelectorAll(".pcl-check")];
    if (boxes.length !== 3) throw new Error(`复选框数量错误：${boxes.length}`);
    const states = boxes.map((node) => ({
      text: node.textContent.trim(),
      checked: node.classList.contains("is-checked"),
      aria: node.getAttribute("aria-checked")
    }));
    if (!states[0].checked) throw new Error('Checked="True" 没有渲染为勾选状态');
    if (states[1].checked) throw new Error('Checked="False" 被渲染为勾选状态');
    if (!states[2].checked) throw new Error("IsChecked 兼容读取失效");
    if (states[0].aria !== "true" || states[1].aria !== "false") {
      throw new Error(`aria-checked 与状态不同步：${states[0].aria}/${states[1].aria}`);
    }
    return { states };
  });

  await makeCheck(results, "MyCard 标题、正文与按钮不重叠", async () => {
    harness.renderer.render(`
      <local:MyCard Margin="0">
        <Image Height="20" Source="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" />
        <TextBlock Margin="40,8,0,0" Text="标题" />
        <TextBlock Margin="40,13,0,0" Text="正文" Height="20" />
        <StackPanel Margin="40,66,0,0">
          <local:MyTextButton Text="按钮" />
        </StackPanel>
      </local:MyCard>
    `);
    const title = [...harness.root.querySelectorAll(".pcl-text")].find((node) => node.textContent === "标题");
    const body = [...harness.root.querySelectorAll(".pcl-text")].find((node) => node.textContent === "正文");
    const button = harness.root.querySelector(".pcl-textbutton");
    if (!title || !body || !button) throw new Error("MyCard 标题/正文/按钮没有完整渲染");
    // WPF overlay semantics: stretched text boxes fill the cell, so element
    // boxes may legally overlap; what must not overlap is the rendered text.
    const glyphRect = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rect = range.getBoundingClientRect();
      return rect.width > 0 ? rect : el.getBoundingClientRect();
    };
    const titleGlyph = glyphRect(title);
    const bodyGlyph = glyphRect(body);
    const buttonRect = button.getBoundingClientRect();
    if (titleGlyph.bottom > bodyGlyph.top + 1) {
      throw new Error(`标题与正文文字重叠：${titleGlyph.bottom} > ${bodyGlyph.top}`);
    }
    if (bodyGlyph.bottom > buttonRect.top + 1) {
      throw new Error(`正文与按钮重叠：${bodyGlyph.bottom} > ${buttonRect.top}`);
    }
    return {
      titleGlyphBottom: titleGlyph.bottom,
      bodyGlyphTop: bodyGlyph.top,
      bodyGlyphBottom: bodyGlyph.bottom,
      buttonTop: buttonRect.top
    };
  });

  await makeCheck(results, "MyCard 固定高度正文按整行截断并显示省略号", async () => {
    harness.renderer.render(`
      <local:MyCard Margin="0" Width="300">
        <TextBlock Margin="10,8,10,0" FontSize="12" TextWrapping="Wrap" Height="20"
          Text="这是一段很长的测试描述文本，用来验证卡片里写死高度的正文会按整行截断并显示省略号，不会出现被拦腰切开的半行文字。" />
        <StackPanel Margin="10,66,0,0">
          <local:MyTextButton Text="按钮" />
        </StackPanel>
      </local:MyCard>
    `);
    const text = [...harness.root.querySelectorAll(".pcl-text")].find((node) =>
      node.textContent.includes("很长的测试描述")
    );
    const button = harness.root.querySelector(".pcl-textbutton");
    if (!text || !button) throw new Error("MyCard 固定高度正文没有完整渲染");
    const ellipsis = (text.textContent || "").endsWith("…");
    if (!ellipsis) throw new Error(`固定高度正文没有显示省略号：${(text.textContent || "").slice(-20)}`);
    const textRect = text.getBoundingClientRect();
    if (textRect.height > 21) {
      throw new Error(`固定高度没有被遵守：${textRect.height} > 20`);
    }
    const buttonRect = button.getBoundingClientRect();
    if (buttonRect.top < textRect.bottom - 1) {
      throw new Error(`按钮覆盖正文：${buttonRect.top} < ${textRect.bottom}`);
    }
    return { ellipsis, textHeight: textRect.height, buttonTop: buttonRect.top };
  });

  await makeCheck(results, "放大预览时大字号正文不会被截成单个省略号", async () => {
    // The stage scales #pclWindow with --pcl-scale, so getBoundingClientRect()
    // reports scaled pixels while the line budget is unscaled. Before the fix
    // every prefix of a fractional line height measured "too tall" and the
    // binary search settled on length 0, replacing the whole string with "…".
    const scaleProperty = document.documentElement.style.getPropertyValue("--pcl-scale");
    const scalePriority = document.documentElement.style.getPropertyPriority("--pcl-scale");
    harness.renderer.render(`
      <local:MyCard Margin="0" Width="300">
        <TextBlock Margin="10,8,10,0" FontSize="52" Text="10 23" />
        <TextBlock Margin="10,8,10,0" FontSize="36" Text="17°C" />
      </local:MyCard>
    `);
    const nodes = [...harness.root.querySelectorAll(".pcl-text")];
    const original = nodes.map((node) => node.textContent);
    const samples = [];
    for (const scale of [1, 1.063, 1.3]) {
      document.documentElement.style.setProperty("--pcl-scale", String(scale));
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      harness.renderer.render(`
        <local:MyCard Margin="0" Width="300">
          <TextBlock Margin="10,8,10,0" FontSize="52" Text="10 23" />
          <TextBlock Margin="10,8,10,0" FontSize="36" Text="17°C" />
        </local:MyCard>
      `);
      const texts = [...harness.root.querySelectorAll(".pcl-text")].map((node) => node.textContent);
      samples.push({ scale, texts });
      const collapsed = texts.filter((text) => (text || "").trim() === "…");
      if (collapsed.length) {
        throw new Error(`scale ${scale} 下正文被截成省略号：${JSON.stringify(texts)}`);
      }
      if (JSON.stringify(texts) !== JSON.stringify(original)) {
        throw new Error(`scale ${scale} 下短文本被改写：${JSON.stringify(texts)}`);
      }
    }
    if (scaleProperty) document.documentElement.style.setProperty("--pcl-scale", scaleProperty, scalePriority);
    else document.documentElement.style.removeProperty("--pcl-scale");
    return { samples };
  });

  await makeCheck(results, "MyCard 按钮行与图标底部齐平且无多余空白", async () => {
    const icon =
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxMjgnIGhlaWdodD0nMTI4Jz48cmVjdCB3aWR0aD0nMTI4JyBoZWlnaHQ9JzEyOCcgZmlsbD0nIzQ0ODhDQycvPjwvc3ZnPg==";
    harness.renderer.render(`
      <local:MyCard Margin="0" Width="500">
        <Image Height="75" Margin="8,8,5,8" Source="${icon}" />
        <TextBlock Margin="89,8,5,4" FontSize="18" Text="卡片标题" />
        <TextBlock Margin="90,13,0,0" FontSize="11" TextWrapping="Wrap" Height="36"
          Text="这是一段很长的测试描述文本，用来验证卡片内容保持紧凑：标题与正文、正文与按钮之间不留大片空白，卡片左下方不会出现空白区域。" />
        <StackPanel Margin="86,66,0,0" Orientation="Horizontal">
          <local:MyTextButton Text="按钮" />
        </StackPanel>
      </local:MyCard>
    `);
    await waitForImages(harness.root);
    const body = harness.root.querySelector(".pcl-card__body");
    const image = body?.querySelector(".pcl-image-wrap");
    const texts = [...harness.root.querySelectorAll(".pcl-text")];
    const title = texts.find((node) => node.textContent === "卡片标题");
    const desc = texts.find((node) => node.textContent.includes("很长的测试描述"));
    const button = harness.root.querySelector(".pcl-textbutton");
    if (!body || !image || !title || !desc || !button) throw new Error("MyCard 内容没有完整渲染");
    const imageRect = image.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const cardRect = body.closest(".pcl-card").getBoundingClientRect();
    // WPF overlay semantics: stretched/floating boxes may legally overlap;
    // assert on the rendered text (glyphs) instead of element boxes.
    const glyphRect = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rect = range.getBoundingClientRect();
      return rect.width > 0 ? rect : el.getBoundingClientRect();
    };
    const titleGlyph = glyphRect(title);
    const descGlyph = glyphRect(desc);
    if (Math.abs(imageRect.height - 75) > 2) {
      throw new Error(`图标没有按 Height 渲染：${imageRect.height}，应为 75`);
    }
    if (descGlyph.top - titleGlyph.bottom > 14) {
      throw new Error(`标题与正文之间空白过大：${descGlyph.top - titleGlyph.bottom}`);
    }
    if (buttonRect.top < descGlyph.bottom - 1) {
      throw new Error(`按钮覆盖正文：${buttonRect.top} < ${descGlyph.bottom}`);
    }
    if (cardRect.height > imageRect.height + 18) {
      throw new Error(`卡片左下方留白过大：卡片高 ${cardRect.height}`);
    }
    return {
      imageHeight: imageRect.height,
      titleDescGap: descGlyph.top - titleGlyph.bottom,
      descButtonGap: buttonRect.top - descGlyph.bottom,
      cardHeight: cardRect.height
    };
  });

  await makeCheck(results, "MyCard 横幅条纹按 WPF 语义渲染", async () => {
    const stripe =
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxMDAwJyBoZWlnaHQ9JzIwJz48cmVjdCB3aWR0aD0nMTAwMCcgaGVpZ2h0PScyMCcgZmlsbD0nIzEzQTlGRicvPjwvc3ZnPg==";
    harness.renderer.render(`
      <local:MyCard Margin="0" Width="850">
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Center" Margin="0,-175,0,0">
          <Image Height="10" Margin="0,85,0,0" Source="${stripe}" />
        </StackPanel>
        <Rectangle Width="2000" Height="100" Panel.ZIndex="1">
          <Rectangle.Fill>
            <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
              <GradientStop Color="#13A9FF" Offset="0.0" />
            </LinearGradientBrush>
          </Rectangle.Fill>
        </Rectangle>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Center">
          <Image Height="10" Margin="0,90,0,0" Source="${stripe}" />
        </StackPanel>
        <TextBlock Margin="50,20,0,15" FontSize="24" Text="每日整合包推荐" />
      </local:MyCard>
    `);
    await waitForImages(harness.root);
    const body = harness.root.querySelector(".pcl-card__body");
    const images = [...(body?.querySelectorAll("img") ?? [])];
    if (images.length !== 2) throw new Error(`条纹图片数量错误：${images.length}`);
    const bodyTop = body.getBoundingClientRect().top;
    const topStripe = images[0].getBoundingClientRect().top - bodyTop;
    const topHeight = images[0].getBoundingClientRect().height;
    const bottomStripe = images[1].getBoundingClientRect().top - bodyTop;
    const bottomHeight = images[1].getBoundingClientRect().height;
    if (Math.abs(topStripe - 0) > 1.5) {
      throw new Error(`上条纹没有贴住卡片顶部：${topStripe}`);
    }
    if (Math.abs(topHeight - 10) > 1.5) {
      throw new Error(
        `上条纹没有按 Height 渲染：${topHeight}（natural ${images[0].naturalWidth}x${images[0].naturalHeight}，应为 10）`
      );
    }
    if (Math.abs(bottomStripe - 90) > 1.5) {
      throw new Error(`下条纹位置错误：${bottomStripe}，应为 90`);
    }
    if (Math.abs(bottomHeight - 10) > 1.5) {
      throw new Error(`下条纹没有按 Height 渲染：${bottomHeight}，应为 10`);
    }
    const cardRect = body.getBoundingClientRect();
    if (Math.abs(cardRect.height - 100) > 2) {
      throw new Error(`卡片高度错误：${cardRect.height}，应为 100`);
    }
    return { topStripe, topHeight, bottomStripe, bottomHeight, cardHeight: cardRect.height };
  });

  await makeCheck(results, "MyCard 右对齐按钮与左侧文本同行不被下推", async () => {
    harness.renderer.render(`
      <local:MyCard Margin="0" Width="500">
        <TextBlock Margin="50,20,0,15" FontSize="24" Foreground="#fff" Text="每日整合包推荐" />
        <TextBlock Margin="50,50,0,15" FontSize="13" Text="Thank you for subscribing" />
        <StackPanel Margin="86,66,0,0" Orientation="Horizontal" HorizontalAlignment="Right">
          <local:MyTextButton Text="[反馈贴]" />
        </StackPanel>
      </local:MyCard>
    `);
    const texts = [...harness.root.querySelectorAll(".pcl-text")];
    const subtitle = texts.find((node) => node.textContent === "Thank you for subscribing");
    const button = harness.root.querySelector(".pcl-textbutton");
    if (!subtitle || !button) throw new Error("横幅内容没有完整渲染");
    const buttonRect = button.getBoundingClientRect();
    if (Math.abs(buttonRect.top - 66) > 2) {
      throw new Error(`右对齐按钮被下推：顶部 ${buttonRect.top}，应保持 66`);
    }
    const subtitleRect = subtitle.getBoundingClientRect();
    // WPF draws the TextBlock's own line box (13px * 1.1509) below its margin,
    // so the button row can start a fraction of a pixel below that box while
    // still sitting on the same row. Allow a small tolerance instead of the
    // old 1.32em line height that happened to overlap.
    if (buttonRect.top > subtitleRect.bottom + 2) {
      throw new Error(`右对齐按钮应与左侧副标题同区：${buttonRect.top} > ${subtitleRect.bottom}`);
    }
    return { buttonTop: buttonRect.top, subtitleBottom: subtitleRect.bottom };
  });

  await makeCheck(results, "静态 HEAD 请求", async () => {
    const response = await fetch("/", { method: "HEAD", cache: "no-store" });
    if (!response.ok) throw new Error(`HEAD / 返回 HTTP ${response.status}`);
    if (await response.text()) throw new Error("HEAD 响应不应包含响应体");
    if (!response.headers.get("content-length")) throw new Error("HEAD 响应缺少 Content-Length");
    if (response.headers.get("access-control-allow-origin")) {
      throw new Error("静态资源不应统一发送 Access-Control-Allow-Origin");
    }
    return { contentLength: response.headers.get("content-length") };
  });

  await makeCheck(results, "CSP 与安全响应头", async () => {
    const response = await fetch("/", { cache: "no-store" });
    const csp = response.headers.get("content-security-policy") || "";
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'"
    ]) {
      if (!csp.includes(directive)) throw new Error(`CSP 缺少 ${directive}`);
    }
    const requiredHeaders = {
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin"
    };
    for (const [name, expected] of Object.entries(requiredHeaders)) {
      const actual = response.headers.get(name);
      if (actual !== expected) throw new Error(`${name} 期望 ${expected}，实际 ${actual || "（空）"}`);
    }

    const html = await response.text();
    const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i);
    if (!meta) throw new Error("index.html 缺少 CSP meta");
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "object-src 'none'"]) {
      if (!meta[1].includes(directive)) throw new Error(`meta CSP 缺少 ${directive}`);
    }
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error("index.html 仍包含内联脚本");
    if (/\sstyle\s*=/i.test(html)) throw new Error("index.html 仍包含内联样式");
    if (!/<script[^>]+src="js\/boot\.js[^"]*"/i.test(html)) throw new Error("启动兜底脚本没有外部化");
    return { csp, metaCsp: meta[1] };
  });

  await makeCheck(results, "PCL 帮助页地址与标题", async () => {
    const jsonUrl = "https://mcnews.meloong.com/VersionArchiveList.json";
    const urls = resolveHelpUrls(jsonUrl);
    if (urls?.xamlUrl !== "https://mcnews.meloong.com/VersionArchiveList.xaml") {
      throw new Error(`JSON 帮助地址没有转换为 XAML：${urls?.xamlUrl || "（空）"}`);
    }
    if (urls?.jsonUrl !== jsonUrl) throw new Error(`帮助 JSON 地址被错误改写：${urls?.jsonUrl}`);
    if (resolveHelpXamlUrl(jsonUrl) !== urls.xamlUrl) throw new Error("resolveHelpXamlUrl 与解析结果不一致");

    const direct = resolveHelpUrls("https://mcnews.meloong.com/versions/list/wilderness_bound.xaml?x=1");
    if (direct?.xamlUrl !== "https://mcnews.meloong.com/versions/list/wilderness_bound.xaml?x=1") {
      throw new Error(`XAML 帮助地址被错误改写：${direct?.xamlUrl}`);
    }
    if (direct?.jsonUrl !== "https://mcnews.meloong.com/versions/list/wilderness_bound.json?x=1") {
      throw new Error(`XAML 对应 JSON 地址错误：${direct?.jsonUrl}`);
    }
    if (
      resolveHelpXamlUrl("https://mcnews.meloong.com/versions/list/latest") !==
      "https://mcnews.meloong.com/versions/list/latest.xaml"
    ) {
      throw new Error("无扩展名帮助地址没有补全 .xaml");
    }
    if (resolveHelpUrls("帮助/自定义帮助.json") !== null) throw new Error("相对帮助路径不应被当作远程地址");

    const xamlTitle = helpTitleFromXaml('<StackPanel><local:MyCard Title="版本列表">内容</local:MyCard></StackPanel>');
    if (xamlTitle !== "版本列表") throw new Error(`XAML 帮助标题解析错误：${xamlTitle}`);
    const jsonTitle = helpJsonTitle('{"Title":"版本历史记录 | 奔赴荒野 | 26.3"}');
    if (jsonTitle !== "版本历史记录 | 奔赴荒野 | 26.3") throw new Error(`JSON 帮助标题解析错误：${jsonTitle}`);

    const calls = [];
    harness.runtime.onOpenHelp = async (url) => calls.push(url);
    await harness.runtime.handle("打开帮助", jsonUrl);
    harness.runtime.onOpenHelp = null;
    if (calls.length !== 1 || calls[0] !== jsonUrl) throw new Error("远程帮助回调没有触发");
    return { xamlUrl: urls.xamlUrl, title: jsonTitle };
  });

  await makeCheck(results, "PCL 帮助页页面栈", async () => {
    const shell = window.__PCL_RENDERER__?.shell;
    if (!shell?.showHelpPage) throw new Error("找不到 PCL 页面导航接口");
    const windowEl = document.getElementById("pclWindow");
    const helpPage = document.getElementById("pclHelpPage");
    const homePage = document.getElementById("pclHomePage");
    const titlebarSub = document.getElementById("pclTitlebarSub");
    const title = document.getElementById("pclSubpageTitle");
    if (!windowEl || !helpPage || !homePage || !titlebarSub || !title) {
      throw new Error("帮助页 DOM 结构不完整");
    }
    if (helpPage.getAttribute("role") !== "region") {
      throw new Error("帮助页缺少 region 语义");
    }
    if (helpPage.getAttribute("aria-labelledby") !== "pclSubpageTitle") {
      throw new Error("帮助页没有关联 pclSubpageTitle");
    }

    shell.showHelpPage("版本列表");
    await sleep(40);
    if (!windowEl.classList.contains("is-subpage")) throw new Error("帮助页没有进入子页面状态");
    if (helpPage.hidden) throw new Error("帮助页仍然隐藏");
    if (!homePage.hidden) throw new Error("进入帮助页后主页没有隐藏");
    if (titlebarSub.hidden) throw new Error("子页面标题栏仍然隐藏");
    if (title.textContent !== "版本列表") throw new Error(`子页面标题错误：${title.textContent}`);
    const sidebar = document.getElementById("pclSidebar");
    if (sidebar && getComputedStyle(sidebar).display !== "none") throw new Error("帮助页没有隐藏侧栏");

    document.getElementById("pclSubpageBack")?.click();
    await sleep(80);
    if (windowEl.classList.contains("is-subpage")) throw new Error("返回后仍然停留在子页面");
    if (!helpPage.hidden) throw new Error("返回后帮助页没有隐藏");
    if (homePage.hidden) throw new Error("返回后主页没有恢复");
    if (!titlebarSub.hidden) throw new Error("返回后子页面标题栏没有隐藏");
    return { title: "版本列表" };
  });

  await makeCheck(results, "Tooltip 支持键盘焦点", async () => {
    const shell = window.__PCL_RENDERER__?.shell;
    const tooltip = document.getElementById("pclTooltip");
    if (!shell?.hideTooltip || !tooltip || !shell.tooltip) {
      throw new Error("找不到 Tooltip 接口");
    }
    shell.hideTooltip();
    await sleep(170);
    const target = document.createElement("button");
    target.type = "button";
    target.dataset.tooltip = "键盘提示";
    target.style.cssText = "position:fixed;left:12px;top:12px;width:24px;height:24px;";
    document.body.append(target);
    try {
      target.focus({ preventScroll: true });
      await sleep(40);
      if (tooltip.hidden || tooltip.textContent !== "键盘提示") {
        throw new Error("键盘焦点没有显示 Tooltip");
      }
      target.blur();
      await sleep(180);
      if (!tooltip.hidden) throw new Error("失焦后 Tooltip 没有消失");
    } finally {
      target.remove();
      shell.hideTooltip();
      await sleep(170);
    }
    return { text: "键盘提示" };
  });

  await makeCheck(results, "WPF MaxHeight 行高", async () => {
    const text =
      "这段文字用于验证换行后的行距不会重叠。WPF 默认 LineStackingStrategy 是 MaxHeight，因此 LineHeight 小于字体行高时应取字体行高。";
    const xaml = `<FlowDocument FontSize="14"><Paragraph Width="180" LineHeight="12">${text}</Paragraph></FlowDocument>`;
    const metrics = await renderSource(harness, xaml);
    const paragraph = harness.root.querySelector('[data-pcl-type="Paragraph"]');
    if (!paragraph) throw new Error("Paragraph 未渲染");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 1);
    const lines = [];
    for (const rect of rects.sort((a, b) => a.top - b.top)) {
      const line = lines.find((item) => Math.abs(item.top - rect.top) < 2);
      if (line) line.bottom = Math.max(line.bottom, rect.bottom);
      else lines.push({ top: rect.top, bottom: rect.bottom });
    }
    if (lines.length < 2) throw new Error("测试段落没有发生换行");
    let minGap = Infinity;
    for (let index = 1; index < lines.length; index += 1) {
      minGap = Math.min(minGap, lines[index].top - lines[index - 1].bottom);
    }
    if (minGap < -0.5) throw new Error(`行框仍然重叠：${minGap.toFixed(2)}px`);

    const blockXaml = `<FlowDocument FontSize="14"><Paragraph Width="180" LineHeight="12" LineStackingStrategy="BlockLineHeight">${text}</Paragraph></FlowDocument>`;
    await renderSource(harness, blockXaml);
    const blockParagraph = harness.root.querySelector('[data-pcl-type="Paragraph"]');
    const blockLineHeight = Number.parseFloat(getComputedStyle(blockParagraph).lineHeight);
    if (blockLineHeight !== 12) {
      throw new Error(`BlockLineHeight 没有保留 12px：${getComputedStyle(blockParagraph).lineHeight}`);
    }
    return { ...metrics, lines: lines.length, minGap };
  });

  await makeCheck(results, "FlowDocument 分隔线长文字", async () => {
    const content = "这是一个很长很长的分割线标题文字，它应该完整显示并在需要时自动换行，而不是变成省略号。";
    const xaml = `
      <FlowDocument FontSize="14">
        <FlowDocument.Resources>
          <ControlTemplate x:Key="Sep" TargetType="ContentControl">
            <Grid>
              <Line X1="0" X2="10" />
              <Line X1="0" X2="10" />
            </Grid>
          </ControlTemplate>
        </FlowDocument.Resources>
        <ContentControl Content="${content}" Template="{StaticResource Sep}" />
      </FlowDocument>`;
    const metrics = await renderSource(harness, xaml);
    const separator = harness.root.querySelector(".pcl-flow-separator__text");
    if (!separator) throw new Error("分隔线文字未渲染");
    if (separator.textContent !== content) throw new Error("分隔线文字内容不完整");
    const style = getComputedStyle(separator);
    if (style.textOverflow === "ellipsis") throw new Error("分隔线仍然使用省略号");
    if (separator.scrollWidth > separator.clientWidth + 1) {
      throw new Error(`分隔线文字发生横向裁切：${separator.scrollWidth} > ${separator.clientWidth}`);
    }
    const range = document.createRange();
    range.selectNodeContents(separator);
    const lineTops = new Set(
      [...range.getClientRects()]
        .filter((rect) => rect.width > 1 && rect.height > 1)
        .map((rect) => Math.round(rect.top))
    );
    if (lineTops.size < 2) throw new Error("长分隔线文字没有自动换行");
    return { ...metrics, lines: lineTops.size };
  });

  await makeCheck(results, "GroupBox 与 UniformGrid", async () => {
    const xaml = `
      <StackPanel>
        <GroupBox Header="状态" Content="42" />
        <UniformGrid Columns="2">
          <TextBlock Text="A" />
          <TextBlock Text="B" />
        </UniformGrid>
      </StackPanel>`;
    const metrics = await renderSource(harness, xaml);
    const group = harness.root.querySelector('[data-pcl-type="GroupBox"]');
    const grid = harness.root.querySelector('[data-pcl-type="UniformGrid"]');
    if (group?.innerText.replace(/\s+/g, " ").trim() !== "状态 42") throw new Error("GroupBox 内容不正确");
    // Without HeaderTemplate/ContentTemplate the header and content fall back
    // to PCL's global TextBlock style (13px, 1.1509em line box).
    const fallbacks = [
      [".pcl-groupbox__header", "Header"],
      [".pcl-groupbox__content-text", "Content"]
    ];
    for (const [selector, label] of fallbacks) {
      const node = group.querySelector(selector);
      if (!node) throw new Error(`${label} 默认文本未渲染`);
      const style = getComputedStyle(node);
      if (style.fontSize !== "13px") throw new Error(`${label} 默认字号：期望 13px，实际 ${style.fontSize}`);
      const lineHeight = Number.parseFloat(style.lineHeight);
      if (Math.abs(lineHeight - 13 * 1.1509) > 0.2) {
        throw new Error(`${label} 默认行高：期望 ${(13 * 1.1509).toFixed(2)}，实际 ${lineHeight}`);
      }
    }
    if (!grid) throw new Error("UniformGrid 未渲染");
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean);
    if (columns.length !== 2) throw new Error(`UniformGrid 没有形成两列：${columns.join(" ")}`);
    if (metrics.unsupported || metrics.warnings.length) throw new Error("组件渲染出现警告");
    return metrics;
  });

  await makeCheck(results, "GroupBox 按 WPF Aero2 模板布局", async () => {
    const xaml = `
      <StackPanel.Resources>
        <Style TargetType="GroupBox">
          <Setter Property="Margin" Value="5" />
          <Setter Property="MinWidth" Value="90" />
          <Setter Property="MinHeight" Value="60" />
          <Setter Property="HeaderTemplate">
            <Setter.Value>
              <DataTemplate><TextBlock Text="{Binding}" FontSize="12" /></DataTemplate>
            </Setter.Value>
          </Setter>
          <Setter Property="ContentTemplate">
            <Setter.Value>
              <DataTemplate>
                <TextBlock Text="{Binding}" FontSize="22" FontWeight="SemiBold"
                           HorizontalAlignment="Center" VerticalAlignment="Center" />
              </DataTemplate>
            </Setter.Value>
          </Setter>
        </Style>
      </StackPanel.Resources>
      <WrapPanel>
        <GroupBox Header="优先级低" Content="66" />
      </WrapPanel>`;
    const metrics = await renderSource(harness, xaml);
    const group = harness.root.querySelector('[data-pcl-type="GroupBox"]');
    if (!group) throw new Error("GroupBox 未渲染");
    const box = group.getBoundingClientRect();
    const rel = (node) => {
      if (!node) throw new Error("GroupBox 缺少模板部件");
      const rect = node.getBoundingClientRect();
      return { x: rect.x - box.x, y: rect.y - box.y, w: rect.width, h: rect.height };
    };
    const near = (actual, expected, label, tolerance = 0.7) => {
      if (Math.abs(actual - expected) > tolerance) {
        throw new Error(`${label}：期望 ${expected}，实际 ${actual.toFixed(2)}`);
      }
    };

    near(box.width, 90, "GroupBox 宽度");
    near(box.height, 60, "GroupBox 高度");

    const header = rel(group.querySelector(".pcl-groupbox__header"));
    const headerText = rel(group.querySelector(".pcl-groupbox__header-text"));
    const content = rel(group.querySelector(".pcl-groupbox__content"));
    const contentText = rel(group.querySelector(".pcl-groupbox__content-text"));

    // Aero2: 6px side columns, header in the Auto column with 3,1,3,0 padding.
    near(header.x, 6, "Header 左内边距");
    near(header.y, 0, "Header 顶部位置");
    near(header.w, 54, "Header 宽度");
    near(headerText.x, 9, "Header 文本左位置");
    near(headerText.y, 1, "Header 文本顶部位置");
    near(headerText.h, 13.81, "Header 文本行高", 0.4);

    // Two Auto rows of half the header height, 6px bottom row, content below.
    near(content.x, 6, "内容区左内边距");
    near(content.y, header.h, "内容区顶部位置", 0.3);
    near(content.w, 78, "内容区宽度");
    near(content.h, 60 - header.h - 6, "内容区高度", 0.3);
    near(contentText.x + contentText.w / 2, content.x + content.w / 2, "内容文本水平居中", 0.5);
    near(contentText.y + contentText.h / 2, content.y + content.h / 2, "内容文本垂直居中", 0.5);

    const frameTop = Number.parseFloat(getComputedStyle(group.querySelector(".pcl-groupbox__frame")).top);
    near(frameTop, header.h / 2, "框线顶部位置", 0.3);

    // BorderGapMaskConverter(7, header width, frame height) erases the outline
    // from 7px to 7px + header width, down to half the frame height, so the
    // outline never crosses the title.
    const frame = group.querySelector(".pcl-groupbox__frame");
    const gapWidth = Number.parseFloat(getComputedStyle(group).getPropertyValue("--groupbox-gap-width"));
    near(gapWidth, header.w, "缺口宽度");
    const clip = getComputedStyle(frame).clipPath;
    if (!clip.includes("polygon")) throw new Error(`框线缺少缺口遮罩：${clip}`);
    const gapRight = 7 + header.w;
    const gapRightPattern = new RegExp(`${String(+gapRight.toFixed(2)).replace(".", "\\.")}px`);
    if (!gapRightPattern.test(clip)) throw new Error(`缺口右边界异常：${clip}`);
    return metrics;
  });

  await makeCheck(results, "GroupBox 的 Padding 与 BorderThickness 遵循模板", async () => {
    const xaml = `
      <WrapPanel>
        <GroupBox Header="A" Content="1" MinWidth="90" MinHeight="60" Padding="10" BorderThickness="2" />
      </WrapPanel>`;
    const metrics = await renderSource(harness, xaml);
    const group = harness.root.querySelector('[data-pcl-type="GroupBox"]');
    if (!group) throw new Error("GroupBox 未渲染");
    const box = group.getBoundingClientRect();
    const header = group.querySelector(".pcl-groupbox__header").getBoundingClientRect();
    const content = group.querySelector(".pcl-groupbox__content").getBoundingClientRect();
    const frame = group.querySelector(".pcl-groupbox__frame");

    // Padding is a margin around the content presenter, not inner padding.
    const left = content.x - box.x;
    const top = content.y - box.y - header.height;
    if (Math.abs(left - 16) > 0.7) throw new Error(`Padding 左内缩：期望 16，实际 ${left.toFixed(2)}`);
    if (Math.abs(top - 10) > 0.7) throw new Error(`Padding 上内缩：期望 10，实际 ${top.toFixed(2)}`);
    if (Math.abs(content.width - 58) > 0.7) {
      throw new Error(`Padding 后内容宽度：期望 58，实际 ${content.width.toFixed(2)}`);
    }
    // All three nested frame borders use the property value.
    if (getComputedStyle(frame).borderTopWidth !== "2px") {
      throw new Error(`外框厚度：期望 2px，实际 ${getComputedStyle(frame).borderTopWidth}`);
    }
    const inner = getComputedStyle(frame, "::before").borderTopWidth;
    if (inner !== "2px") throw new Error(`内框厚度：期望 2px，实际 ${inner}`);
    return metrics;
  });

  await makeCheck(results, "GroupBox 默认边框取 WPF Aero2 的灰蓝", async () => {
    const xaml = `
      <WrapPanel>
        <GroupBox Header="默认" Content="1" MinWidth="90" MinHeight="60" />
      </WrapPanel>`;
    const metrics = await renderSource(harness, xaml);
    const group = harness.root.querySelector('[data-pcl-type="GroupBox"]');
    if (!group) throw new Error("GroupBox 未渲染");
    const frame = group.querySelector(".pcl-groupbox__frame");
    const outline = getComputedStyle(frame, "::before").borderTopColor;
    if (outline !== "rgb(213, 223, 229)") {
      throw new Error(`默认边框：期望 rgb(213, 223, 229)，实际 ${outline}`);
    }

    // An explicit BorderBrush must still win over the Aero2 fallback.
    const explicit = `
      <WrapPanel>
        <GroupBox Header="显式" Content="1" MinWidth="90" MinHeight="60"
                  BorderBrush="{DynamicResource ColorBrush3}" />
      </WrapPanel>`;
    await renderSource(harness, explicit);
    const tinted = harness.root.querySelector(".pcl-groupbox__frame");
    const tintedOutline = getComputedStyle(tinted, "::before").borderTopColor;
    if (tintedOutline !== "rgb(18, 122, 225)") {
      throw new Error(`显式边框：期望 rgb(18, 122, 225)，实际 ${tintedOutline}`);
    }
    return metrics;
  });

  await makeCheck(results, "缺失的 PCL 输入控件不再落到不支持分支", async () => {
    const xaml = `
      <StackPanel>
        <local:MyTextBox Text="值" HintText="提示" />
        <local:MyComboBox SelectedIndex="1">
          <local:MyComboBoxItem Content="甲" />
          <local:MyComboBoxItem Content="乙" />
        </local:MyComboBox>
        <local:MySearchBox />
        <local:MySlider MaxValue="10" Value="4" />
        <local:MyExtraButton Logo="F1 M2,0 L0,2 8,10 0,18 2,20 10,12 18,20 20,18 12,10 20,2 18,0 10,8 2,0Z" Show="True" />
        <local:MyExtraTextButton Text="附加" Show="True" />
      </StackPanel>`;
    const metrics = await renderSource(harness, xaml);
    const unsupported = Array.from(harness.root.querySelectorAll(".pcl-unsupported")).map((node) => node.textContent);
    if (unsupported.length) throw new Error(`仍有不支持控件：${unsupported.join("、")}`);

    const input = harness.root.querySelector('[data-pcl-type="MyTextBox"] .pcl-input__field');
    if (!input) throw new Error("MyTextBox 未渲染输入框");
    if (input.value !== "值") throw new Error(`MyTextBox 文本：期望 值，实际 ${input.value}`);
    if (input.placeholder !== "提示") throw new Error(`MyTextBox 提示：期望 提示，实际 ${input.placeholder}`);

    const combo = harness.root.querySelector('[data-pcl-type="MyComboBox"]');
    if (!combo) throw new Error("MyComboBox 未渲染");
    const comboValue = combo.querySelector(".pcl-combo__value").textContent;
    if (comboValue !== "乙") throw new Error(`MyComboBox 选中项：期望 乙，实际 ${comboValue}`);
    const items = combo.querySelectorAll(".pcl-combo__item");
    if (items.length !== 2) throw new Error(`MyComboBox 选项数：期望 2，实际 ${items.length}`);

    if (!harness.root.querySelector('[data-pcl-type="MySearchBox"] .pcl-input__field')) {
      throw new Error("MySearchBox 未渲染输入框");
    }

    const slider = harness.root.querySelector('[data-pcl-type="MySlider"]');
    if (!slider) throw new Error("MySlider 未渲染");
    if (slider.getAttribute("aria-valuenow") !== "4") {
      throw new Error(`MySlider 数值：期望 4，实际 ${slider.getAttribute("aria-valuenow")}`);
    }
    const ratio = Number.parseFloat(slider.querySelector(".pcl-slider__dot").style.left);
    if (Math.abs(ratio - 40) > 0.5) throw new Error(`MySlider 位置：期望 40%，实际 ${ratio}%`);

    // Show defaults to False in PCL, so both corner buttons start collapsed.
    const hidden = `<StackPanel>
        <local:MyExtraButton Logo="F1 M0,0 L10,10Z" />
        <local:MyExtraTextButton Text="隐藏" />
      </StackPanel>`;
    await renderSource(harness, hidden);
    for (const type of ["MyExtraButton", "MyExtraTextButton"]) {
      const node = harness.root.querySelector(`[data-pcl-type="${type}"]`);
      if (!node) throw new Error(`${type} 未渲染`);
      if (!node.hidden) throw new Error(`${type} 在未设置 Show 时应隐藏`);
    }
    return metrics;
  });

  await makeCheck(results, "MyListItem 的 Logo 按图片来源而不是几何路径渲染", async () => {
    // MyListItem.xaml.vb:220-252 only falls back to a Shapes.Path when the value
    // is neither an http(s) source nor a .png/.jpg/.webp file. The old regex here
    // also swallowed pack:// bitmaps (their asset path has no extension) and
    // every blob:/svg source, so those logos were parsed as geometry and lost.
    const cases = [
      { logo: "Blocks/Grass.png", kind: "image", why: "本地位图" },
      { logo: "pack://application:,,,/Images/Blocks/Grass.png", kind: "image", why: "pack 位图" },
      { logo: "https://example.com/logo.svg", kind: "image", why: "远程 SVG" },
      { logo: "blob:https://example.com/2b1f0a3e", kind: "image", why: "blob 来源" },
      { logo: "assets/pcl/images/Blocks/Grass.png", kind: "image", why: "站点资源路径" },
      { logo: "F1 M2,0 L0,2 8,10 0,18 2,20 10,12 18,20 20,18 12,10 20,2 18,0 10,8 2,0Z", kind: "path", why: "几何路径" }
    ];
    for (const item of cases) {
      const xaml = `<StackPanel><local:MyListItem Title="标题" Logo="${item.logo}" /></StackPanel>`;
      const metrics = await renderSource(harness, xaml);
      const partial = (metrics.warnings || []).some((text) => /Logo/.test(text));
      const logo = harness.root.querySelector(".pcl-listitem__logo");
      if (!logo) throw new Error(`${item.why}：Logo 未渲染`);
      const image = logo.querySelector("img");
      const svg = logo.querySelector("svg");
      if (item.kind === "image" && !image) {
        throw new Error(`${item.why}（${item.logo}）应渲染为图片，实际 ${svg ? "SVG 路径" : "空"}`);
      }
      if (item.kind === "path" && !svg) {
        throw new Error(`${item.why}（${item.logo}）应渲染为 SVG 路径，实际 ${image ? "图片" : "空"}`);
      }
      if (partial) throw new Error(`${item.why}：Logo 不应产生警告`);
    }
    return null;
  });

  await makeCheck(results, "未知属性按 PCL 的成员名与行号报告", async () => {
    const xaml = `<StackPanel Margin="0">
  <local:MyButton Text="好" />
  <local:MyButton Text="坏" TextColor="Red" />
  <local:MyCard Title="卡片" Height="40" BgColor="#fff" />
</StackPanel>`;
    const metrics = await renderSource(harness, xaml);
    if (!metrics.issues.length) throw new Error("未知属性未被报告");
    const [first, second] = metrics.issues;
    if (first.member !== "PCL.MyButton.TextColor") {
      throw new Error(`成员名：期望 PCL.MyButton.TextColor，实际 ${first.member}`);
    }
    // The authored file keeps the leading newline, so the failing tag is line 3.
    if (first.line !== 3) throw new Error(`行号：期望 3，实际 ${first.line}`);
    if (second.member !== "PCL.MyCard.BgColor") {
      throw new Error(`成员名：期望 PCL.MyCard.BgColor，实际 ${second.member}`);
    }
    if (!first.message.includes("无法设置未知成员")) {
      throw new Error(`提示文案未沿用 PCL 的原话：${first.message}`);
    }

    // Attributes PCL really accepts must not be reported, otherwise every page
    // would light up the badge.
    const legit = `<StackPanel>
  <local:MyButton Text="按钮" ColorType="Highlight" />
  <local:MyCard Title="卡片" Height="40" CanSwap="True" IsSwapped="True" />
  <local:MyHint Text="提示" Theme="Blue" CanClose="True" />
  <local:MyImage Source="https://example.com/a.png" Stretch="UniformToFill" FallbackSource="x.png" />
  <local:MyListItem Title="列表" Info="副标题" Logo="Blocks/CobbleStone.png" LogoScale="0.8" Type="Button" />
</StackPanel>`;
    const clean = await renderSource(harness, legit);
    if (clean.issues.length) {
      throw new Error(`误报：${clean.issues.map((issue) => issue.member).join("、")}`);
    }
    return metrics;
  });

  await makeCheck(results, "远程 XAML 的颜色与样式值不能夹带 CSS", async () => {
    const xaml = `<StackPanel>
  <Border x:Name="hostile" Background="url(https://tracker.invalid/bg.png)" Width="100" Height="20" />
  <TextBlock x:Name="filled" Text="填充" Foreground="red; background-image: url(https://tracker.invalid/t.png)" />
  <TextBlock x:Name="cursored" Text="光标" Cursor="url(https://tracker.invalid/c.cur), auto" />
  <TextBlock x:Name="fonted" Text="字体" FontFamily="Arial; background: url(https://tracker.invalid/f.png)" />
  <TextBlock x:Name="badhex" Text="坏色" Foreground="#12" />
  <TextBlock x:Name="good" Text="正常" Foreground="{DynamicResource ColorBrush3}" FontFamily="微软雅黑" Cursor="Hand" />
  <StackPanel.Resources>
    <Style TargetType="TextBlock" x:Key="injected">
      <Setter Property="background-image" Value="url(https://tracker.invalid/s.png)" />
      <Setter Property="Background" Value="url(https://tracker.invalid/s2.png)" />
    </Style>
  </StackPanel.Resources>
  <TextBlock x:Name="styled" Text="样式" Style="{StaticResource injected}" />
</StackPanel>`;
    // Any image the renderer *did* accept would be fetched by the browser; the
    // one below is the only allowed load, so counting requests proves the
    // hostile values never reached a style attribute.
    const requested = [];
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function patched(method, url, ...rest) {
      requested.push(String(url));
      return originalOpen.call(this, method, url, ...rest);
    };
    let metrics;
    try {
      metrics = await renderSource(harness, xaml);
    } finally {
      XMLHttpRequest.prototype.open = originalOpen;
    }
    const root = harness.root;
    const hostile = root.querySelector(".pcl-border");
    if (hostile && /url\(/i.test(hostile.getAttribute("style") || "")) {
      throw new Error(`Background 的 url() 被写进了样式：${hostile.getAttribute("style")}`);
    }
    const allStyles = [hostile, ...root.querySelectorAll(".pcl-text")]
      .filter(Boolean)
      .map((node) => node.getAttribute("style") || "")
      .join(" | ");
    if (/tracker\.invalid/i.test(allStyles)) {
      throw new Error(`有 url() 逃过了过滤：${allStyles}`);
    }
    const cursors = Array.from(root.querySelectorAll(".pcl-text")).map((node) => node.style.cursor);
    if (cursors.some((value) => /url/i.test(value))) {
      throw new Error(`Cursor 的 url() 被应用了：${cursors.join(", ")}`);
    }
    if (requested.some((url) => /tracker\.invalid/i.test(url))) {
      throw new Error(`过滤后的值仍然发起了请求：${requested.join(", ")}`);
    }
    // Legitimate values still work.
    const colored = Array.from(root.querySelectorAll(".pcl-text")).find(
      (node) => node.style.color && node.style.color.includes("--pcl-c3")
    );
    if (!colored) throw new Error("合法的 ColorBrush3 没有生效");
    const pointered = Array.from(root.querySelectorAll(".pcl-text")).find((node) => node.style.cursor === "pointer");
    if (!pointered) throw new Error("合法的 Cursor=Hand 没有映射成 pointer");
    return metrics;
  });

  await makeCheck(results, "PCL 替换标记", async () => {
    const expected = {
      pcl_version: "2.99.0.0",
      pcl_version_code: "414",
      pcl_version_branch: "快照版",
      pcl_build_type: "Snapshot",
      pcl_branch: "OpenSource",
      identify: "0000-0000-0000-0000",
      name: "1.20.1-Fabric",
      version: "1.20.1",
      fabric: "0.15.11",
      forge: "",
      user: "Steve",
      login: "离线"
    };
    const values = Object.fromEntries(Object.keys(expected).map((key) => [key, harness.runtime.getPlaceholder(key)]));
    for (const [key, value] of Object.entries(expected)) {
      if (values[key] !== value) throw new Error(`${key} 期望 ${value}，实际 ${values[key]}`);
    }

    harness.runtime.variables.TestXml = "<&";
    const escaped = substitutePlaceholders("{variable:TestXml}", harness.runtime.context);
    if (escaped !== "&lt;&amp;") throw new Error(`变量没有正确转义：${escaped}`);
    const rawUrl = substitutePlaceholders("https://example.com/{version}/{name}?a=1&b=2", harness.runtime.context, {
      escape: false
    });
    if (rawUrl !== "https://example.com/1.20.1/1.20.1-Fabric?a=1&b=2") {
      throw new Error(`URL 替换不正确：${rawUrl}`);
    }
    const unknown = substitutePlaceholders("{Binding}", harness.runtime.context);
    if (unknown !== "{Binding}") throw new Error("未知标记被错误替换");
    return values;
  });

  await makeCheck(results, "替换标记页面渲染", async () => {
    const xaml = `<TextBlock Text="{pcl_version} | {date} | {name} | {fabric} | {pcl_md5} | {unknown}" />`;
    const metrics = await renderSource(harness, xaml);
    const text = textOf(harness.root);
    if (!text.includes("2.99.0.0") || !text.includes("1.20.1-Fabric") || !text.includes("0.15.11")) {
      throw new Error(`页面没有显示替换结果：${text}`);
    }
    if (!text.includes("{unknown}")) throw new Error("未知标记没有保留");
    if (metrics.unsupported || metrics.warnings.length) throw new Error("替换标记页面出现警告");
    return { text, ...metrics };
  });

  await makeCheck(results, "窗口阴影安全区", async () => {
    window.dispatchEvent(new Event("resize"));
    await sleep(180);
    const frame = document.getElementById("stageFrame");
    const windowEl = document.getElementById("pclWindow");
    if (!frame || !windowEl) throw new Error("找不到预览舞台");
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pcl-scale"));
    if (!scale) throw new Error("--pcl-scale 未设置");
    const frameRect = frame.getBoundingClientRect();
    const windowRect = windowEl.getBoundingClientRect();
    const margins = {
      left: windowRect.left - frameRect.left,
      right: frameRect.right - windowRect.right,
      top: windowRect.top - frameRect.top,
      bottom: frameRect.bottom - windowRect.bottom
    };
    const required = { left: 36 * scale, right: 36 * scale, top: 16 * scale, bottom: 88 * scale };
    const epsilon = 1.5;
    for (const side of Object.keys(required)) {
      if (margins[side] + epsilon < required[side]) {
        throw new Error(`${side} 阴影安全区不足：${margins[side].toFixed(1)} < ${required[side].toFixed(1)}`);
      }
    }
    if (frame.scrollWidth > frame.clientWidth + 1 || frame.scrollHeight > frame.clientHeight + 1) {
      throw new Error(
        `舞台出现溢出：${frame.scrollWidth}×${frame.scrollHeight} > ${frame.clientWidth}×${frame.clientHeight}`
      );
    }
    return { scale, margins, required };
  });

  await makeCheck(results, "玻璃衬底跟随窗口", async () => {
    const scaler = document.getElementById("pclScaler");
    if (!scaler) throw new Error("找不到 PCL 缩放容器");
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pcl-scale"));
    if (!scale) throw new Error("--pcl-scale 未设置");
    const panel = getComputedStyle(scaler, "::before");
    if (!panel || panel.content === "none" || panel.content === "normal") {
      throw new Error("玻璃衬底伪元素不存在");
    }
    const inset = parseFloat(panel.top);
    const radius = parseFloat(panel.borderTopLeftRadius);
    const expectedInset = -12 * scale;
    const expectedRadius = 14 * scale;
    if (!Number.isFinite(inset) || Math.abs(inset - expectedInset) > 0.6) {
      throw new Error(`玻璃衬底外扩量错误：${panel.top}，期望 ${expectedInset.toFixed(2)}px`);
    }
    if (!Number.isFinite(radius) || Math.abs(radius - expectedRadius) > 0.6) {
      throw new Error(`玻璃衬底圆角没有缩放：${panel.borderTopLeftRadius}，期望 ${expectedRadius.toFixed(2)}px`);
    }
    const windowEl = document.getElementById("pclWindow");
    const caption = document.querySelector(".stage__caption");
    if (windowEl && caption && getComputedStyle(caption).display !== "none") {
      const panelBottom = windowEl.getBoundingClientRect().bottom - parseFloat(panel.bottom);
      const captionTop = caption.getBoundingClientRect().top;
      if (captionTop < panelBottom + 2) {
        throw new Error(`尺寸文字压在衬底边缘：${captionTop.toFixed(1)} < ${panelBottom.toFixed(1)} + 2`);
      }
    }
    return { scale, inset, radius };
  });

  await makeCheck(results, "移动端点击高亮已关闭", async () => {
    const value = getComputedStyle(document.body).getPropertyValue("-webkit-tap-highlight-color").trim();
    if (value && value !== "transparent" && !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(value)) {
      throw new Error(`-webkit-tap-highlight-color 仍为 ${value}`);
    }
    return value || "transparent";
  });

  await makeCheck(results, "UA fallback 顺序", async () => {
    const defaultCandidates = getProxyUaCandidates("");
    const customCandidates = getProxyUaCandidates("CustomUA/1.0");
    const sameCandidates = getProxyUaCandidates(PCL_FALLBACK_UA);
    if (JSON.stringify(defaultCandidates) !== JSON.stringify(["", PCL_FALLBACK_UA])) {
      throw new Error(`默认 UA 顺序错误：${JSON.stringify(defaultCandidates)}`);
    }
    if (JSON.stringify(customCandidates) !== JSON.stringify(["CustomUA/1.0", PCL_FALLBACK_UA])) {
      throw new Error(`自定义 UA 顺序错误：${JSON.stringify(customCandidates)}`);
    }
    if (JSON.stringify(sameCandidates) !== JSON.stringify([PCL_FALLBACK_UA])) {
      throw new Error(`PCL UA 去重失败：${JSON.stringify(sameCandidates)}`);
    }
    return { defaultCandidates, customCandidates, sameCandidates };
  });

  await makeCheck(results, "切换渲染会取消旧请求", async () => {
    const api = window.__PCL_RENDERER__;
    if (!api?.renderCurrent || !api.state) throw new Error("找不到渲染器接口");
    const savedState = {
      mode: api.state.mode,
      preset: api.state.preset,
      url: api.state.url,
      urlContent: api.state.urlContent
    };
    const originalFetch = window.fetch;
    const signals = [];
    let proxyCalls = 0;
    window.fetch = (input, init = {}) => {
      const target = String(input?.url || input);
      if (!target.includes("/api/proxy")) return originalFetch(input, init);
      proxyCalls += 1;
      signals.push(init.signal);
      if (proxyCalls === 1) {
        return new Promise((resolve, reject) => {
          const rejectAborted = () => reject(new DOMException("Aborted", "AbortError"));
          if (init.signal?.aborted) rejectAborted();
          else init.signal?.addEventListener("abort", rejectAborted, { once: true });
        });
      }
      return Promise.resolve(
        new Response('<StackPanel><TextBlock Text="第二次渲染" /></StackPanel>', {
          status: 200,
          headers: { "Content-Type": "application/xml; charset=utf-8" }
        })
      );
    };

    try {
      api.state.mode = "url";
      api.state.url = "https://cancellation.invalid/homepage.xaml";
      api.state.urlContent = "";
      const first = api.renderCurrent({ reason: "abort-test" });
      if (proxyCalls !== 1) throw new Error(`旧请求没有发出：${proxyCalls}`);
      const second = api.renderCurrent({ reason: "abort-test" });
      await first;
      const secondOk = await second;
      if (!signals[0]?.aborted) throw new Error("旧请求没有被 AbortController 取消");
      if (!secondOk) throw new Error("新请求没有完成渲染");
      if (!textOf(document.getElementById("pclHomeRoot")).includes("第二次渲染")) {
        throw new Error("新请求的结果没有显示在预览中");
      }
      return { requests: proxyCalls, firstAborted: signals[0].aborted };
    } finally {
      window.fetch = originalFetch;
      const restoreState = { ...savedState };
      if (restoreState.mode === "url" && !restoreState.urlContent) {
        restoreState.mode = "preset";
        restoreState.preset = "tutorial";
      }
      Object.assign(api.state, restoreState);
      await api.renderCurrent({ reason: "restore" });
    }
  });

  await makeCheck(results, "非法联网地址在发出请求前就被拒绝", async () => {
    const api = window.__PCL_RENDERER__;
    if (!api?.renderCurrent || !api.state) throw new Error("找不到渲染器接口");
    const savedState = {
      mode: api.state.mode,
      preset: api.state.preset,
      url: api.state.url,
      urlContent: api.state.urlContent
    };
    const originalFetch = window.fetch;
    const originalModal = api.shell.showModal;
    let proxyCalls = 0;
    const modals = [];
    window.fetch = (input, init = {}) => {
      const target = String(input?.url || input);
      if (target.includes("/api/proxy")) proxyCalls += 1;
      return originalFetch(input, init);
    };
    api.shell.showModal = async (options) => {
      modals.push(options);
      return 1;
    };
    const cases = [
      ["https://user:pass@example.com/Custom.xaml", /用户名或密码/],
      ["https://example.com:8080/Custom.xaml", /80 与 443/],
      ["http://", /完整的 URL/]
    ];
    try {
      for (const [url, pattern] of cases) {
        api.state.mode = "url";
        api.state.url = url;
        api.state.urlContent = "";
        const ok = await api.renderCurrent({ reason: "url-validation" });
        if (ok) throw new Error(`${url} 竟然渲染成功`);
        if (proxyCalls !== 0) throw new Error(`${url} 在拒绝前就发出了代理请求`);
        const caption = String(modals.at(-1)?.caption || "");
        if (!pattern.test(caption)) throw new Error(`${url} 的提示不具体：${caption}`);
      }
      return { rejected: cases.length, proxyCalls };
    } finally {
      window.fetch = originalFetch;
      api.shell.showModal = originalModal;
      const restoreState = { ...savedState };
      if (restoreState.mode === "url" && !restoreState.urlContent) {
        restoreState.mode = "preset";
        restoreState.preset = "tutorial";
      }
      Object.assign(api.state, restoreState);
      await api.renderCurrent({ reason: "restore" });
    }
  });

  await makeCheck(results, "远程预设取不到时按预设失败分类并强制重试", async () => {
    const api = window.__PCL_RENDERER__;
    if (!api?.renderCurrent || !api.state) throw new Error("找不到渲染器接口");
    const savedState = {
      mode: api.state.mode,
      preset: api.state.preset,
      url: api.state.url,
      urlContent: api.state.urlContent
    };
    const originalFetch = window.fetch;
    const originalModal = api.shell.showModal;
    const modals = [];
    let attempts = 0;
    window.fetch = (input) => {
      const target = String(input?.url || input);
      if (!target.includes("/api/proxy") && target.startsWith("http")) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      attempts += 1;
      return Promise.reject(new TypeError("fetch failed"));
    };
    api.shell.showModal = async (options) => {
      modals.push(options);
      // 点「重试」的分支会再次强制拉取，这里只让第一次失败弹窗被点击。
      return modals.length === 1 ? 0 : 1;
    };
    try {
      api.state.mode = "preset";
      api.state.preset = "pcl2-4";
      api.state.url = "";
      api.state.urlContent = "";
      const ok = await api.renderCurrent({ reason: "preset-failure", forceRemote: true });
      if (ok) throw new Error("预设明明取不到却渲染成功");
      const first = modals[0] || {};
      if (first.title !== "PCL2 预设加载失败") {
        throw new Error(`标题没有按远程预设分类：${first.title}`);
      }
      if (!/无法加载 PCL2 预设/.test(String(first.caption))) {
        throw new Error(`正文没有保留原始原因：${first.caption}`);
      }
      if (!Array.isArray(first.buttons) || first.buttons[0] !== "重试") {
        throw new Error(`重试按钮缺失：${JSON.stringify(first.buttons)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      // 「重试」走 forceRemote，所以必须再拉一次；同一份失败若被缓存命中就
      // 不会出现第二个弹窗。用弹窗次数而不是 attempts 判断，因为重试是在
      // renderCurrent 的微任务里立刻发出的，await 返回时可能已经发完。
      if (modals.length < 2) {
        throw new Error(`点「重试」后没有重新渲染（弹窗只有 ${modals.length} 次）`);
      }
      if (attempts < 2) {
        throw new Error(`点「重试」后没有重新发起请求（attempts=${attempts}）`);
      }
      return { title: first.title, attempts, modals: modals.length };
    } finally {
      window.fetch = originalFetch;
      api.shell.showModal = originalModal;
      Object.assign(api.state, { ...savedState, mode: "preset", preset: "tutorial" });
      await api.renderCurrent({ reason: "restore" });
    }
  });

  await makeCheck(results, "导出按钮写入编辑器里的最新内容", async () => {
    const api = window.__PCL_RENDERER__;
    const editor = document.getElementById("codeEditor");
    const exportBtn = document.getElementById("exportBtn");
    if (!api?.state || !editor || !exportBtn) throw new Error("找不到源码编辑器或导出按钮");

    const savedMode = api.state.mode;
    const savedPreset = api.state.preset;
    const savedCode = api.state.code;
    const savedEditor = editor.value;

    // 让「源码」页成为当前来源，并先在预览里渲染一份旧内容。
    document.querySelector('[data-tab="code"]')?.click();
    editor.value = '<TextBlock Text="已渲染的旧内容" />';
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    api.state.mode = "code";
    api.state.code = editor.value;
    await api.renderCurrent({ reason: "export-test-old" });
    if (api.state.mode !== "code") throw new Error("没有切换到源码来源");

    // 然后只改编辑器、不再渲染，导出应当拿到新值。
    editor.value = '<TextBlock Text="尚未渲染的新内容" />';
    editor.dispatchEvent(new Event("input", { bubbles: true }));

    const blobs = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob) => {
      blobs.push(blob);
      return "blob:test";
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function noop() {};
    let exportedName = "";
    const originalAppend = document.body.append;
    try {
      // 记录 download 属性：append 之后读取不到已移除的节点，所以在 click 处抓。
      HTMLAnchorElement.prototype.click = function captureName() {
        exportedName = this.download;
      };
      exportBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (!blobs.length) throw new Error("导出没有生成 Blob");
      const text = await blobs[0].text();
      if (!text.includes("尚未渲染的新内容")) {
        throw new Error(`导出的仍是旧内容：${text.slice(0, 80)}`);
      }
      if (!exportedName.endsWith(".xaml")) throw new Error(`导出文件名不正确：${exportedName}`);
      return { length: text.length, fileName: exportedName };
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
      document.body.append = originalAppend;
      editor.value = savedEditor;
      Object.assign(api.state, { mode: savedMode, preset: savedPreset, code: savedCode });
      await api.renderCurrent({ reason: "restore" });
    }
  });

  await makeCheck(results, "半透明兄弟元素不会盖住文本", async () => {
    // WPF composites Opacity after painting, so a Border with Opacity="0.5"
    // placed before a TextBlock in a Grid never covers it. CSS would turn the
    // Border into a stacking context and lift it above the text, so every
    // layout child gets z-index:0 to keep document order authoritative.
    await renderSource(
      harness,
      `<Grid>
        <Border Background="#000000" Opacity="0.5" />
        <TextBlock Text="Nguyen Hoang Bridge" />
      </Grid>`
    );
    const grid = harness.root.querySelector(".pcl-grid");
    if (!grid) throw new Error("网格没有渲染");
    const layers = [...grid.children].map((node) => ({
      cls: node.className,
      z: getComputedStyle(node).zIndex
    }));
    if (layers.length !== 2) throw new Error(`子元素数量错误：${layers.length}`);
    for (const layer of layers) {
      if (layer.z !== "0") throw new Error(`层叠层级不是 0：${layer.cls} -> ${layer.z}`);
    }
    return { layers };
  });
  await makeCheck(results, "标题栏字标的描边不会被裁掉左半边", async () => {
    // The svg viewBox is PCL's bare geometry box, so the 2.2px pen straddles it
    // by 1.1px on every side. With the default `overflow: hidden` the outer half
    // of the P's left stroke disappeared (1.0px instead of 2.0px measured
    // against PCL). Keep `visible` and the slot sized to PCL's ink box.
    const logo = document.querySelector(".pcl-titlebar__logo");
    if (!logo) throw new Error("缺少标题栏字标");
    const path = logo.querySelector("path");
    if (!path) throw new Error("字标没有路径");
    const overflow = getComputedStyle(logo).overflow;
    if (overflow !== "visible") throw new Error(`字标溢出被裁剪：overflow=${overflow}`);
    const box = logo.getBoundingClientRect();
    if (!box.height) throw new Error("字标高度为 0");
    const ratio = box.width / box.height;
    const expected = 36.3 / 14.2;
    if (Math.abs(ratio - expected) > 0.01) {
      throw new Error(`字标比例不是 PCL 的 36.3:14.2：${ratio.toFixed(3)}`);
    }
    // The rule above only matters because the geometry box sits exactly on the
    // viewBox edge, leaving the pen outside it.
    const bb = path.getBBox();
    if (Math.abs(bb.x - 26) > 0.01) throw new Error(`字标几何盒左边界：期望 26，实际 ${bb.x}`);
    return { overflow, ratio: Number(ratio.toFixed(3)) };
  });
  await makeCheck(results, "MyIconButton 把图标适配进 5px 内边距的内容区", async () => {
    // PCL's template is a Border whose Path has Stretch="Uniform" Margin="5", so
    // a 180x35 button shows a 25px tall icon. An auto-sized grid track let the
    // square SVG drive a max-content row and the face grew to 168x168.
    await renderSource(
      harness,
      `<StackPanel>
        <local:MyIconButton Width="180" Height="35" Logo="F1 M2,2 L22,2 L22,22 L2,22 Z" />
        <local:MyIconButton Width="100" Height="100" Logo="F1 M2,2 L22,2 L22,22 L2,22 Z" />
      </StackPanel>`
    );
    const buttons = [...harness.root.querySelectorAll(".pcl-iconbutton")];
    if (buttons.length !== 2) throw new Error(`图标按钮数量：期望 2，实际 ${buttons.length}`);
    const rows = buttons.map((button) => {
      const face = button.querySelector(".pcl-iconbutton__face");
      const svg = button.querySelector("svg");
      if (!face || !svg) throw new Error("图标按钮缺少 face 或 svg");
      const b = button.getBoundingClientRect();
      const f = face.getBoundingClientRect();
      const s = svg.getBoundingClientRect();
      // 5px padding on both sides: the content rect is height - 10.
      const expected = (b.height - 10) / b.height;
      if (Math.abs(f.height / b.height - expected) > 0.01) {
        throw new Error(`face 高度没有跟随内容区：${f.height.toFixed(1)} / ${b.height.toFixed(1)}`);
      }
      if (s.height > f.height + 0.5 || s.width > f.width + 0.5) {
        throw new Error(
          `图标溢出内容区：svg ${s.width.toFixed(1)}x${s.height.toFixed(1)} / face ${f.width.toFixed(1)}x${f.height.toFixed(1)}`
        );
      }
      if (Math.abs(s.height - f.height) > 0.5) {
        throw new Error(`图标没有按 Uniform 铺满内容区高度：${s.height.toFixed(1)} vs ${f.height.toFixed(1)}`);
      }
      return { button: [+b.width.toFixed(1), +b.height.toFixed(1)], face: [+f.width.toFixed(1), +f.height.toFixed(1)] };
    });
    return { rows };
  });
  await makeCheck(results, "四档外观切换与画布压暗", async () => {
    // The shell offers light / dark / amoled plus an auto option that follows
    // the system (covered by runAppearanceAutoCheck). The two dark ones differ
    // only in how they back the canvas, and both dim the canvas to 90%
    // brightness. The canvas keeps rendering the same PCL pixels throughout.
    const group = document.getElementById("themeSwitch");
    if (!group) throw new Error("缺少外观切换控件");
    const buttons = [...group.querySelectorAll("[data-appearance]")];
    const names = buttons.map((button) => button.dataset.appearance);
    if (names.join(",") !== "auto,light,dark,amoled") {
      throw new Error("外观档位不是四档：" + names.join(","));
    }
    // Auto resolves to one of the concrete appearances, so leave it out of the
    // fixed-workspace loop below.
    const fixed = names.filter((name) => name !== "auto");

    const root = document.documentElement;
    const canvas = document.getElementById("pclWindow");
    if (!canvas) throw new Error("缺少预览画布");
    const previous = root.dataset.appearance || root.dataset.theme;
    const previousStored = window.localStorage.getItem("pcl.lab.appearance.v1");
    const seen = {};
    try {
      for (const name of fixed) {
        buttons.find((button) => button.dataset.appearance === name).click();
        await sleep(120);
        const checked = buttons
          .filter((button) => button.getAttribute("aria-checked") === "true")
          .map((button) => button.dataset.appearance);
        if (checked.length !== 1 || checked[0] !== name) {
          throw new Error("选中状态错误：" + name + " -> " + checked.join(","));
        }
        if (root.dataset.theme !== name) throw new Error("未写入 data-theme：" + root.dataset.theme);
        if (window.localStorage.getItem("pcl.lab.appearance.v1") !== name) {
          throw new Error("未记住外观选择：" + name);
        }
        const filter = getComputedStyle(canvas).filter;
        const expected = name === "light" ? "none" : "brightness(0.9)";
        if (filter !== expected) throw new Error(name + " 的画布压暗错误：" + filter);
        seen[name] = {
          filter,
          body: getComputedStyle(document.body).backgroundImage.slice(0, 48)
        };
      }
      if (seen.dark.body === seen.amoled.body) throw new Error("深色与 AMOLED 外壳没有区别");
      if (seen.dark.body === seen.light.body) throw new Error("深色与浅色外壳没有区别");
    } finally {
      try {
        if (previousStored == null) window.localStorage.removeItem("pcl.lab.appearance.v1");
        else window.localStorage.setItem("pcl.lab.appearance.v1", previousStored);
      } catch {
        /* storage may be unavailable; the result is already collected */
      }
      buttons.find((button) => button.dataset.appearance === (previous || "light"))?.click();
    }
    return seen;
  });

  const ok = results.every((item) => item.ok);
  window.__PCL_TEST_RESULT__ = { suite: "regression", ok, results };
  return window.__PCL_TEST_RESULT__;
}

export async function runAppearanceAutoCheck() {
  const results = [];

  await makeCheck(results, "跟随系统外观遵循 prefers-color-scheme", async () => {
    // The host OS is emulated by the harness, so read the same query the
    // module reads instead of assuming dark or light.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const expectDark = media.matches;
    const group = document.getElementById("themeSwitch");
    if (!group) throw new Error("缺少外观切换控件");
    const buttons = [...group.querySelectorAll("[data-appearance]")];
    const names = buttons.map((button) => button.dataset.appearance);
    if (names.join(",") !== "auto,light,dark,amoled") {
      throw new Error("外观档位不是四档：" + names.join(","));
    }

    const root = document.documentElement;
    const canvas = document.getElementById("pclWindow");
    const previous = root.dataset.appearance;
    const previousStored = window.localStorage.getItem("pcl.lab.appearance.v1");
    const seen = {};
    try {
      buttons.find((button) => button.dataset.appearance === "auto").click();
      await sleep(120);
      if (window.localStorage.getItem("pcl.lab.appearance.v1") !== "auto") {
        throw new Error("未记住跟随系统档位");
      }
      // data-appearance keeps the preference while data-theme holds the
      // workspace the preference resolves to.
      if (root.dataset.appearance !== "auto") {
        throw new Error("data-appearance 不是 auto：" + root.dataset.appearance);
      }
      const expectedTheme = expectDark ? "dark" : "light";
      if (root.dataset.theme !== expectedTheme) {
        throw new Error(`跟随系统解析错误：期望 ${expectedTheme}，实际 ${root.dataset.theme}`);
      }
      const filter = getComputedStyle(canvas).filter;
      const expectedFilter = expectDark ? "brightness(0.9)" : "none";
      if (filter !== expectedFilter) {
        throw new Error(`跟随系统的画布亮度错误：期望 ${expectedFilter}，实际 ${filter}`);
      }
      seen.scheme = expectDark ? "dark" : "light";
      seen.theme = root.dataset.theme;
      seen.filter = filter;

      // An explicit choice must ignore the system preference.
      buttons.find((button) => button.dataset.appearance === "amoled").click();
      await sleep(120);
      if (root.dataset.theme !== "amoled") throw new Error("显式选择被系统覆盖：" + root.dataset.theme);
      if (root.dataset.appearance !== "amoled") throw new Error("data-appearance 未更新：" + root.dataset.appearance);
    } finally {
      try {
        if (previousStored == null) window.localStorage.removeItem("pcl.lab.appearance.v1");
        else window.localStorage.setItem("pcl.lab.appearance.v1", previousStored);
      } catch {
        /* storage may be unavailable; the result is already collected */
      }
      buttons.find((button) => button.dataset.appearance === (previous || "light"))?.click();
    }
    return seen;
  });

  const ok = results.every((item) => item.ok);
  window.__PCL_TEST_RESULT__ = { suite: "appearance-auto", ok, results };
  return window.__PCL_TEST_RESULT__;
}

export async function runMobileRegression() {
  const results = [];

  await makeCheck(results, "375px 移动端预览横向滚动", async () => {
    const started = Date.now();
    const stage = document.getElementById("stage");
    const frame = document.getElementById("stageFrame");
    const scaler = document.getElementById("pclScaler");
    if (!stage || !frame || !scaler) throw new Error("缺少预览舞台节点");
    if (window.innerWidth > 820) throw new Error(`移动端视口宽度为 ${window.innerWidth}`);

    while (Date.now() - started < 3000 && !stage.classList.contains("is-pannable")) {
      await sleep(50);
    }
    if (!stage.classList.contains("is-pannable")) throw new Error("移动端没有启用横向滚动模式");

    const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pcl-scale"));
    if (!(scale >= 0.55)) throw new Error(`移动端缩放 ${scale} 低于可读下限`);
    if (frame.scrollWidth <= frame.clientWidth) {
      throw new Error(`预览未溢出：${frame.scrollWidth} <= ${frame.clientWidth}`);
    }
    if (getComputedStyle(frame).overflowX !== "auto") {
      throw new Error("预览框没有设置 overflow-x: auto");
    }
    if (scaler.getBoundingClientRect().left < frame.getBoundingClientRect().left) {
      throw new Error("横向滚动内容被居中裁切，无法从左侧开始阅读");
    }
    const hint = document.querySelector(".stage__caption-scroll");
    if (!hint || getComputedStyle(hint).display === "none") {
      throw new Error("移动端缺少横向滑动提示");
    }
    return { scale, clientWidth: frame.clientWidth, scrollWidth: frame.scrollWidth };
  });

  await makeCheck(results, "移动端标题栏容纳四档外观且不溢出", async () => {
    // Four appearance options plus the help button used to push the product
    // name down to a few pixels, so the header is checked for overflow and for
    // the collapsed help label rather than trusting the stylesheet.
    const header = document.querySelector(".lab-header");
    const brand = document.querySelector(".lab-brand");
    const group = document.getElementById("themeSwitch");
    const help = document.getElementById("helpBtn");
    if (!header || !brand || !group || !help) throw new Error("缺少标题栏节点");
    const items = [...group.querySelectorAll("[data-appearance]")];
    if (items.length !== 4) throw new Error("外观档位不是四档：" + items.length);
    if (header.scrollWidth > header.clientWidth + 1) {
      throw new Error(`标题栏溢出：${header.scrollWidth} > ${header.clientWidth}`);
    }
    if (group.getBoundingClientRect().right > header.getBoundingClientRect().right + 1) {
      throw new Error("外观切换控件超出标题栏");
    }
    const label = help.querySelector(".lab-text-button__label");
    if (label && getComputedStyle(label).display !== "none") {
      throw new Error("窄屏下说明按钮的文字没有收起");
    }
    if (!help.getAttribute("aria-label")) throw new Error("说明按钮收起文字后缺少可访问名称");
    const brandText = document.querySelector(".lab-brand__text");
    const expectBrandText = window.innerWidth > 360;
    if (expectBrandText === (getComputedStyle(brandText).display === "none")) {
      throw new Error(`品牌文字在最窄屏幕的显示状态不对：${window.innerWidth}px`);
    }
    return { viewport: window.innerWidth, help: Math.round(help.getBoundingClientRect().width) };
  });

  const ok = results.every((item) => item.ok);
  window.__PCL_TEST_RESULT__ = { suite: "mobile", ok, results };
  return window.__PCL_TEST_RESULT__;
}

const classifyPreset = (preset, result) => {
  const expected = preset.expected;
  const error = result.error || "";
  if (expected === "blocked") {
    if (result.error && /x:Static|x:Code|安全|不允许使用/.test(error)) {
      return { status: "blocked", pass: true };
    }
    return { status: result.error ? "error" : "unexpected-pass", pass: false };
  }
  if (expected === "unavailable") {
    if (result.stage === "fetch") return { status: "unavailable", pass: true };
    if (result.error) return { status: "error", pass: false };
    return { status: "recovered", pass: true };
  }
  if (result.error) return { status: "error", pass: false };
  return {
    status: result.metrics?.warnings?.length ? "warning" : "ok",
    pass: !result.metrics?.unsupported
  };
};

export async function runPresetAudit() {
  const results = new Array(PCL_PRESETS.length);
  const concurrency = Math.min(PRESET_AUDIT_CONCURRENCY, PCL_PRESETS.length);
  let nextIndex = 0;

  const runOne = async (preset, index) => {
    const started = performance.now();
    const harness = createHarness(`pclAuditRoot-${preset.id}`);
    const record = {
      id: preset.id,
      name: preset.name,
      expected: preset.expected,
      status: "pending",
      pass: false,
      duration: 0,
      stage: "start",
      error: "",
      bytes: 0,
      metrics: null
    };

    try {
      let source;
      if (preset.kind === "inline") {
        source = preset.xaml;
      } else {
        record.stage = "fetch";
        source = await fetchRemoteXaml(preset.url, harness.runtime);
      }
      record.bytes = new TextEncoder().encode(source).byteLength;
      if (record.bytes > MAX_SOURCE_BYTES) {
        throw new Error(`源内容为 ${formatByteSize(record.bytes)}，超过 ${formatByteSize(MAX_SOURCE_BYTES)} 上限`);
      }
      record.stage = "render";
      record.metrics = await renderSource(harness, source, true);
      record.stage = "done";
    } catch (error) {
      record.error = String(error?.message || error);
    } finally {
      harness.root.remove();
    }

    record.duration = Math.round(performance.now() - started);
    const classification = classifyPreset(preset, record);
    record.status = classification.status;
    record.pass = classification.pass;
    results[index] = record;
  };

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= PCL_PRESETS.length) return;
      await runOne(PCL_PRESETS[index], index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  const counts = results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const ok = results.every((item) => item.pass);
  window.__PCL_TEST_RESULT__ = { suite: "presets", ok, counts, results };
  return window.__PCL_TEST_RESULT__;
}
