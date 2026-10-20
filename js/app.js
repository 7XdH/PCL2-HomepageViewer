import { PclTheme } from "./theme.js";
import { PclRenderer } from "./renderer.js";
import { PclRuntime } from "./runtime.js";
import { PclShell } from "./shell.js";

const SOURCE_KEY = "pcl.lab.source.v1";

const PRESETS = {
  tutorial: { title: "PCL 原版教程", path: "assets/presets/tutorial.xaml" },
  gallery: { title: "控件画廊", path: "assets/presets/gallery.xaml" },
  events: { title: "事件测试台", path: "assets/presets/events.xaml" },
  hint: { title: "你知道吗", path: "assets/presets/hint.xaml" }
};

const FALLBACK_XAML = `
<local:MyHint Margin="0,0,0,15" Theme="Blue" Text="当前通过 file:// 打开。预设文件与联网代理需要运行 node server.js 后才能加载；本地文件和源码仍可正常渲染。" />
<local:MyCard Title="PCL Homepage Viewer（第三方）" Margin="0,0,0,15" CanSwap="True">
    <StackPanel Margin="25,40,23,15">
        <TextBlock TextWrapping="Wrap" Margin="0,0,0,8"
                   Text="PCL 自定义主页已经成功启动。你可以把 Custom.xaml 拖入页面，或在左侧粘贴源码。" />
        <TextBlock TextWrapping="Wrap" Margin="0,0,0,10" FontSize="11" Foreground="#8C7721"
                   Text="提示：使用 node server.js 启动本地服务器后，预设与联网主页功能将完整可用。" />
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Left">
            <local:MyButton Margin="0,0,10,0" Height="35" Padding="18,0,18,0" ColorType="Highlight"
                            Text="打开 PCL 仓库" EventType="打开网页" EventData="https://github.com/Meloong-Git/PCL" />
            <local:MyButton Height="35" Padding="18,0,18,0"
                            Text="显示一个弹窗" EventType="弹出窗口" EventData="PCL Homepage Viewer|这个弹窗由 PCL 的自定义事件驱动。\n渲染器没有执行任何脚本。" />
        </StackPanel>
    </StackPanel>
</local:MyCard>
`;

const presetCache = new Map();
let renderToken = 0;
let lastRenderedContent = "";
let codeDirty = false;
let currentFilter = "";

const el = id => document.getElementById(id);
const $ = {
  root: el("pclHomeRoot"),
  homeScroll: el("pclHomeScroll"),
  stage: el("stage"),
  stageFrame: el("stageFrame"),
  scaler: el("pclScaler"),
  zoomLabel: el("zoomLabel"),
  sourceLabel: el("sourceLabel"),
  renderStats: el("renderStats"),
  runtimePill: el("runtimePill"),
  runtimeText: el("runtimeText"),
  fileInput: el("fileInput"),
  dropzone: el("dropzone"),
  fileMeta: el("fileMeta"),
  urlInput: el("urlInput"),
  uaInput: el("uaInput"),
  codeEditor: el("codeEditor"),
  codeLines: el("codeLines"),
  varChips: el("varChips"),
  presetList: el("presetList"),
  eventText: el("eventText"),
  eventCount: el("eventCount"),
  helpBtn: el("helpBtn"),
  renderBtn: el("renderBtn"),
  refreshBtn: el("refreshBtn"),
  fitBtn: el("fitBtn"),
  fullscreenBtn: el("fullscreenBtn"),
  exportBtn: el("exportBtn"),
  applyCodeBtn: el("applyCodeBtn"),
  urlLoadBtn: el("urlLoadBtn"),
  clearVarsBtn: el("clearVarsBtn"),
  eventLogBtn: el("eventLogBtn"),
  stageEmpty: el("stageEmpty")
};

const state = {
  mode: "preset",
  preset: "tutorial",
  fileName: "",
  fileContent: "",
  url: "",
  urlContent: "",
  ua: "",
  code: ""
};

const theme = new PclTheme();

const shell = new PclShell({
  onLaunch: version => runtime.raise([{ type: "启动游戏", data: version }])
});
shell.onReopen = () => fitStage();

const runtime = new PclRuntime({
  shell,
  onRefresh: () => renderCurrent({ reason: "event" }),
  onSettingChange: (key, value) => handleSettingChange(key, value)
});
theme.setHue(Number(runtime.settings.UiLauncherHue));

const renderer = new PclRenderer({
  root: $.root,
  runtime
});

function setRuntime(text, mode = "ready") {
  $.runtimeText.textContent = text;
  $.runtimePill.classList.toggle("is-busy", mode === "busy");
  $.runtimePill.classList.toggle("is-error", mode === "error");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function handleSettingChange(key, value) {
  if (key === "UiLauncherHue") {
    theme.setHue(Number(value));
    return;
  }
  if (key === "__variables") {
    updateVariables(value);
  }
}

function updateVariables(variables) {
  const entries = Object.entries(variables || {});
  if (!$.varChips) return;
  $.varChips.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("span");
    empty.className = "var-chips__empty";
    empty.innerHTML = '暂无变量 · 使用 <code>修改变量</code> 事件后出现';
    $.varChips.append(empty);
    return;
  }
  for (const [name, value] of entries.slice(0, 24)) {
    const chip = document.createElement("span");
    chip.className = "var-chip";
    const strong = document.createElement("strong");
    strong.textContent = name;
    const text = document.createElement("span");
    text.textContent = value === "" ? "（空）" : value;
    text.title = `${name} = ${value}`;
    chip.append(strong, text);
    $.varChips.append(chip);
  }
  if (entries.length > 24) {
    const more = document.createElement("span");
    more.className = "var-chips__empty";
    more.textContent = `另有 ${entries.length - 24} 个变量未显示`;
    $.varChips.append(more);
  }
}

function setActiveTab(tab) {
  for (const button of document.querySelectorAll(".source-tab")) {
    const active = button.dataset.tab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const pane of document.querySelectorAll(".source-pane")) {
    const active = pane.dataset.pane === tab;
    pane.hidden = !active;
    pane.classList.toggle("is-active", active);
  }
  if (tab === "code" && !codeDirty) syncEditor(lastRenderedContent);
}

function setPresetActive(id) {
  for (const button of $.presetList?.querySelectorAll("[data-preset]") || []) {
    button.classList.toggle("is-active", button.dataset.preset === id);
  }
}

function updateLineNumbers() {
  if (!$.codeEditor || !$.codeLines) return;
  const count = Math.max(1, $.codeEditor.value.split("\n").length);
  if ($.codeLines.dataset.count !== String(count)) {
    $.codeLines.dataset.count = String(count);
    $.codeLines.textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
  }
  $.codeLines.scrollTop = $.codeEditor.scrollTop;
}

function syncEditor(content) {
  if (!$.codeEditor) return;
  if ($.codeEditor.value !== content) $.codeEditor.value = content;
  updateLineNumbers();
}

function updateFileMeta() {
  if (state.mode === "file" && state.fileName) {
    $.dropzone?.classList.add("has-file");
    const size = new Blob([state.fileContent]).size;
    $.fileMeta.textContent = `${state.fileName} · ${size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`}`;
  } else if (state.mode === "url" && state.url) {
    $.fileMeta.textContent = `联网来源 · ${state.url.replace(/^https?:\/\//, "").slice(0, 46)}`;
  } else if (state.mode === "preset") {
    $.fileMeta.textContent = `预设 · ${PRESETS[state.preset]?.title || "未知"}`;
  } else {
    $.fileMeta.textContent = "尚未选择文件";
  }
}

async function loadPreset(id, { force = false } = {}) {
  const preset = PRESETS[id] || PRESETS.tutorial;
  if (!force && presetCache.has(id)) return presetCache.get(id);
  try {
    const response = await fetch(preset.path, { cache: force ? "no-store" : "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) throw new Error("预设内容为空");
    presetCache.set(id, text);
    return text;
  } catch (error) {
    if (location.protocol === "file:") {
      presetCache.set(id, FALLBACK_XAML);
      return FALLBACK_XAML;
    }
    throw new Error(`无法加载预设「${preset.title}」：${error.message}`);
  }
}

function saveSourceState(content) {
  try {
    const payload = {
      mode: state.mode,
      preset: state.preset,
      fileName: state.fileName,
      url: state.url,
      ua: state.ua,
      code: state.mode === "code" ? content : "",
      content: state.mode === "preset" ? "" : content
    };
    if (JSON.stringify(payload).length < 500000) {
      localStorage.setItem(SOURCE_KEY, JSON.stringify(payload));
    }
  } catch {
    /* ignore quota errors */
  }
}

function restoreSourceState() {
  try {
    const raw = localStorage.getItem(SOURCE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return false;
    state.ua = typeof saved.ua === "string" ? saved.ua.trim() : "";
    if (state.ua.length > 512 || (state.ua && !/^[\x20-\x7E]+$/.test(state.ua))) {
      state.ua = "";
    }
    if (saved.mode === "preset" && PRESETS[saved.preset]) {
      state.mode = "preset";
      state.preset = saved.preset;
      return true;
    }
    if (["file", "url", "code"].includes(saved.mode) && typeof saved.content === "string") {
      state.mode = saved.mode;
      state.fileName = saved.fileName || "Custom.xaml";
      state.url = saved.url || "";
      state.fileContent = saved.mode === "file" ? saved.content : "";
      state.urlContent = saved.mode === "url" ? saved.content : "";
      state.code = saved.mode === "code" ? saved.content : "";
      lastRenderedContent = saved.content;
      if (saved.mode === "code") syncEditor(saved.content);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function readFileAsXaml(file) {
  const text = await file.text();
  return text.replace(/^\uFEFF/, "");
}

async function applyFile(file) {
  if (!file) return;
  const content = await readFileAsXaml(file);
  state.mode = "file";
  state.fileName = file.name || "Custom.xaml";
  state.fileContent = content;
  codeDirty = false;
  updateFileMeta();
  setActiveTab("file");
  setPresetActive(null);
  syncEditor(content);
  await renderCurrent({ reason: "file" });
}

async function fetchViaProxy(url, signal) {
  const proxyUrl = new URL("api/proxy", document.baseURI);
  proxyUrl.searchParams.set("url", url);
  if (state.ua) proxyUrl.searchParams.set("ua", state.ua);
  const response = await fetch(proxyUrl, { signal, cache: "no-store" });
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok || contentType.includes("text/html")) {
    const text = await response.text().catch(() => "");
    const error = new Error(text.trim() || `代理返回 HTTP ${response.status}`);
    error.status = response.status;
    error.code = contentType.includes("text/html") ? "PROXY_HTML" : "PROXY_HTTP";
    throw error;
  }
  return response.text();
}

async function fetchDirect(url, signal) {
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
  return response.text();
}

async function fetchRemoteXaml(url) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 22000);
  let proxyError = null;
  try {
    if (location.protocol === "http:" || location.protocol === "https:") {
      try {
        return await fetchViaProxy(url, controller.signal);
      } catch (error) {
        if (error.name === "AbortError") throw error;
        proxyError = error;
      }
    }

    const canFallbackToDirect =
      !proxyError ||
      !proxyError.status ||
      proxyError.status === 404 ||
      proxyError.status === 405 ||
      proxyError.status >= 500 ||
      proxyError.code === "PROXY_HTML";
    if (!canFallbackToDirect) {
      throw new Error(
        `无法拉取联网主页：${proxyError.message}\n\n` +
        "请确认地址有效，或检查代理设置是否可用。"
      );
    }

    try {
      return await fetchDirect(url, controller.signal);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      const proxyMissing =
        !proxyError ||
        proxyError.status === 404 ||
        proxyError.status === 405 ||
        proxyError.code === "PROXY_HTML";
      const proxyHint = proxyError
        ? proxyMissing
          ? `未找到可用的 /api/proxy（${proxyError.message}）。当前部署可能是纯静态站点。`
          : `代理请求失败（${proxyError.message}）。`
        : "未找到可用的 /api/proxy。";
      throw new Error(
        `无法拉取联网主页：${error.message}\n\n` +
        proxyHint + "\n" +
        "目标站点未开放 CORS 时，需要可用的服务端代理（例如 Vercel Function /api/proxy），" +
        "或运行 node server.js 使用本地代理。"
      );
    }
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时（22 秒）。");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}


async function resolveCurrentContent({ forceRemote = false } = {}) {
  if (state.mode === "file") {
    if (!state.fileContent.trim()) throw new Error("尚未选择本地 XAML 文件。");
    return state.fileContent;
  }
  if (state.mode === "code") {
    const code = $.codeEditor?.value ?? state.code;
    if (!code.trim()) throw new Error("源码编辑器为空。");
    return code;
  }
  if (state.mode === "url") {
    if (!state.url) throw new Error("尚未填写联网主页地址。");
    if (!state.urlContent || forceRemote) {
      if (forceRemote) state.urlContent = "";
      shell.setLoading(true, "正在拉取联网主页…");
      const content = await fetchRemoteXaml(state.url);
      state.urlContent = content;
      shell.setLoading(false, "");
    }
    if (!state.urlContent.trim()) throw new Error("联网主页返回了空内容。");
    return state.urlContent;
  }
  return loadPreset(state.preset);
}

function sourceLabel() {
  if (state.mode === "preset") return PRESETS[state.preset]?.title || "PCL 预设";
  if (state.mode === "file") return state.fileName || "本地 XAML";
  if (state.mode === "url") return state.url.replace(/^https?:\/\//, "") || "联网主页";
  return "内联源码";
}

async function renderCurrent({ reason = "manual", forceRemote = false } = {}) {
  const token = ++renderToken;
  setRuntime(reason === "initial" ? "正在加载" : "正在渲染", "busy");
  $.renderBtn.disabled = true;
  let network = state.mode === "url" && (!state.urlContent || forceRemote);
  if (network) shell.setLoading(true, "正在拉取联网主页…");

  try {
    const content = await resolveCurrentContent({ forceRemote });
    if (token !== renderToken) return false;
    const result = renderer.render(content);
    if (token !== renderToken) return false;

    lastRenderedContent = content;
    codeDirty = false;
    syncEditor(content);
    state.code = state.mode === "code" ? content : state.code;
    $.sourceLabel.textContent = sourceLabel();
    $.renderStats.textContent = `${result.controls} 个控件 · ${result.duration} ms${result.warnings.length ? ` · ${result.warnings.length} 个警告` : ""}`;
    $.renderStats.title = result.warnings.length ? result.warnings.join("\n") : "";
    setRuntime("渲染就绪", "ready");
    setPresetActive(state.mode === "preset" ? state.preset : null);
    updateFileMeta();
    saveSourceState(content);
    fitStage();
    return true;
  } catch (error) {
    if (token !== renderToken) return false;
    setRuntime("渲染失败", "error");
    $.renderStats.textContent = "渲染失败";
    $.renderStats.title = error.message || String(error);
    shell.setLoading(false);
    const networkFailure = state.mode === "url" && String(error.message || error).startsWith("无法拉取联网主页");
    shell.showModal({
      title: networkFailure ? "联网主页加载失败" : "加载主页失败",
      caption: networkFailure
        ? String(error.message || error)
        : `主页内容编写有误，请根据下列错误信息进行检查：\n\n${error.message || error}`,
      buttons: ["重试", "取消"],
      warn: true
    }).then(choice => {
      if (choice === 0) renderCurrent({ forceRemote: true });
    });
    return false;
  } finally {
    if (network) shell.setLoading(false);
    $.renderBtn.disabled = false;
  }
}

function fitStage() {
  const frame = $.stageFrame;
  if (!frame) return;
  const rect = frame.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const mobile = window.innerWidth <= 820;
  const horizontalPadding = mobile ? 10 : 30;
  const verticalPadding = mobile ? 16 : 20;
  const availableWidth = Math.max(220, rect.width - horizontalPadding);
  const availableHeight = Math.max(150, rect.height - verticalPadding);
  const minScale = mobile ? 0.62 : 0.5;
  const maxScale = 1.35;
  let scale = Math.min(maxScale, availableWidth / 850, availableHeight / 500);
  if (scale < minScale) scale = minScale;
  scale = Math.max(0.3, Math.floor(scale * 1000) / 1000);
  document.documentElement.style.setProperty("--pcl-scale", String(scale));
  if ($.zoomLabel) $.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
}


async function loadPresetAndRender(id) {
  if (!PRESETS[id]) return;
  state.mode = "preset";
  state.preset = id;
  codeDirty = false;
  setPresetActive(id);
  setActiveTab("file");
  updateFileMeta();
  await renderCurrent({ reason: "preset" });
}

async function loadUrlAndRender() {
  const url = $.urlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    shell.showModal({
      title: "网址无效",
      caption: "联网主页地址必须以 http:// 或 https:// 开头。",
      buttons: ["确定"],
      warn: true
    });
    return;
  }
  const ua = $.uaInput.value.trim();
  if (ua.length > 512 || (ua && !/^[\x20-\x7E]+$/.test(ua))) {
    shell.showModal({
      title: "UA 无效",
      caption: "User-Agent 必须是 1–512 个可打印 ASCII 字符，不能包含换行或控制字符。留空则使用默认值 PCL2-Homepage-Viewer。",
      buttons: ["确定"],
      warn: true
    });
    return;
  }
  state.mode = "url";
  state.url = url;
  state.ua = ua;
  state.urlContent = "";
  codeDirty = false;
  setPresetActive(null);
  setActiveTab("url");
  updateFileMeta();
  await renderCurrent({ reason: "url", forceRemote: true });
  $.urlInput.value = state.url;
  $.uaInput.value = state.ua;
}

async function applyCodeAndRender() {
  state.mode = "code";
  state.code = $.codeEditor.value;
  setPresetActive(null);
  setActiveTab("code");
  await renderCurrent({ reason: "code" });
}

function exportCurrent() {
  const content = lastRenderedContent || $.codeEditor.value || FALLBACK_XAML;
  const fileName = state.mode === "file" && state.fileName ? state.fileName : "Custom.xaml";
  const blob = new Blob([content], { type: "application/xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  shell.showHint(`已导出：${fileName}`, "Green");
}

async function showHelp() {
  if (shell.windowEl.classList.contains("is-closed")) shell.reopenWindow();
  if (shell.windowEl.classList.contains("is-minimized")) shell.toggleMinimized(false);
  const choice = await shell.showModal({
    title: "使用说明",
    caption:
      "原作者：龙腾猫跃 · 赞助链接：https://meloong.com/afd/a/LTCat\n\n" +
      "Plain Craft Launcher (PCL) Homepage Viewer 是第三方独立作品，在浏览器中复刻 PCL 2 的自定义主页（Custom.xaml）外观与事件，与 PCL 官方无关。\n\n" +
      "1. 在左侧选择本地文件、联网地址、源码，或点击快速预设。\n" +
      "2. 渲染时会解析 PCL 的 WPF XAML 方言，支持 MyCard、MyHint、MyButton、MyTextButton、MyIconButton、MyIconTextButton、MyListItem、MyImage，以及 StackPanel、Grid、Border、TextBlock、Path 等常用 WPF 控件。\n" +
      "3. 自定义事件会进入事件引擎：打开网页、弹出窗口、弹出提示、复制文本、刷新主页、修改变量、切换页面等均可工作。修改设置与变量会保存在 localStorage 中，并参与 {variable:...} 与 {setup:...} 替换。\n\n" +
      "浏览器限制：打开文件／执行命令、启动游戏、加入房间、导入整合包等操作不会真正执行，渲染器会显示与 PCL 一致的提示或弹窗。\n\n" +
      "快捷键：Ctrl + Enter 渲染，Ctrl + O 打开文件。联网加载建议通过 node server.js 启动本地代理。",
    buttons: ["打开 PCL 仓库", "知道了"]
  });
  if (choice === 0) shell.openUrl("https://github.com/Meloong-Git/PCL");
}

async function showEventLog() {
  if (shell.windowEl.classList.contains("is-closed")) shell.reopenWindow();
  if (shell.windowEl.classList.contains("is-minimized")) shell.toggleMinimized(false);
  const choice = await shell.showModal({
    title: "事件日志",
    caption: shell.formatEventLog(),
    buttons: ["清空", "关闭"]
  });
  if (choice === 0) {
    shell.events.length = 0;
    $.eventCount.textContent = "0";
    $.eventText.textContent = "事件日志已清空。";
    $.eventText.dataset.status = "idle";
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
    return;
  }
  $.stage.requestFullscreen?.().catch(() => {
    shell.showHint("当前浏览器不支持全屏预览。", "Red");
  });
}


function bindUi() {
  for (const button of document.querySelectorAll(".source-tab")) {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  }

  $.dropzone?.addEventListener("click", () => $.fileInput.click());
  $.fileInput?.addEventListener("change", () => {
    const file = $.fileInput.files?.[0];
    if (file) applyFile(file);
    $.fileInput.value = "";
  });

  $.urlLoadBtn?.addEventListener("click", () => loadUrlAndRender());
  $.urlInput?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadUrlAndRender();
    }
  });
  $.uaInput?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadUrlAndRender();
    }
  });
  for (const button of document.querySelectorAll("[data-fill-url]")) {
    button.addEventListener("click", () => {
      $.urlInput.value = button.dataset.fillUrl;
      loadUrlAndRender();
    });
  }

  $.codeEditor?.addEventListener("input", () => {
    codeDirty = true;
    state.code = $.codeEditor.value;
    updateLineNumbers();
  });
  $.codeEditor?.addEventListener("scroll", updateLineNumbers, { passive: true });
  $.codeEditor?.addEventListener("keydown", event => {
    if (event.key === "Tab") {
      event.preventDefault();
      const start = $.codeEditor.selectionStart;
      const end = $.codeEditor.selectionEnd;
      const value = $.codeEditor.value;
      $.codeEditor.value = `${value.slice(0, start)}  ${value.slice(end)}`;
      $.codeEditor.selectionStart = $.codeEditor.selectionEnd = start + 2;
      codeDirty = true;
      updateLineNumbers();
    }
  });
  $.applyCodeBtn?.addEventListener("click", () => applyCodeAndRender());

  for (const button of $.presetList?.querySelectorAll("[data-preset]") || []) {
    button.addEventListener("click", () => loadPresetAndRender(button.dataset.preset));
  }

  $.renderBtn?.addEventListener("click", () => renderCurrent({ reason: "manual" }));
  $.refreshBtn?.addEventListener("click", () => renderCurrent({ reason: "refresh", forceRemote: true }));
  $.fitBtn?.addEventListener("click", () => fitStage());
  $.fullscreenBtn?.addEventListener("click", toggleFullscreen);
  $.exportBtn?.addEventListener("click", exportCurrent);
  $.helpBtn?.addEventListener("click", showHelp);
  $.eventLogBtn?.addEventListener("click", showEventLog);
  $.clearVarsBtn?.addEventListener("click", () => {
    runtime.clearVariables();
    updateVariables(runtime.variables);
    shell.showHint("已清空自定义变量", "Green");
  });

  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (document.activeElement === $.codeEditor || !document.querySelector('[data-pane="code"]')?.hidden) {
        applyCodeAndRender();
      } else {
        renderCurrent({ reason: "manual" });
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
      event.preventDefault();
      $.fileInput.click();
    }
  });

  document.addEventListener("fullscreenchange", () => window.setTimeout(fitStage, 80));
  window.addEventListener("resize", () => window.setTimeout(fitStage, 40));

  let dragDepth = 0;
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes("Files");
  document.addEventListener("dragenter", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    document.body.classList.add("is-dragging-file");
  });
  document.addEventListener("dragover", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", () => {
    if (dragDepth <= 0) return;
    dragDepth -= 1;
    if (!dragDepth) document.body.classList.remove("is-dragging-file");
  });
  document.addEventListener("drop", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("is-dragging-file");
    const file = event.dataTransfer?.files?.[0];
    if (file) applyFile(file);
  });
  document.addEventListener("dragend", () => {
    dragDepth = 0;
    document.body.classList.remove("is-dragging-file");
    $.dropzone?.classList.remove("is-dragover");
  });
  window.addEventListener("blur", () => {
    dragDepth = 0;
    document.body.classList.remove("is-dragging-file");
    $.dropzone?.classList.remove("is-dragover");
  });

  $.dropzone?.addEventListener("dragover", event => {
    event.preventDefault();
    $.dropzone.classList.add("is-dragover");
  });
  $.dropzone?.addEventListener("dragleave", () => $.dropzone.classList.remove("is-dragover"));
  $.dropzone?.addEventListener("drop", event => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    document.body.classList.remove("is-dragging-file");
    $.dropzone.classList.remove("is-dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) applyFile(file);
  });
}


async function init() {
  window.__PCL_RENDERER__ = { renderer, runtime, shell, theme, renderCurrent, state };
  updateVariables(runtime.variables);

  const restored = restoreSourceState();
  if (!restored || !PRESETS[state.preset]) {
    state.mode = "preset";
    state.preset = "tutorial";
  }

  if (state.mode === "url") {
    $.urlInput.value = state.url;
    setActiveTab("url");
  } else if (state.mode === "code") {
    syncEditor(state.code);
    setActiveTab("code");
  } else {
    setActiveTab("file");
  }
  $.uaInput.value = state.ua;
  setPresetActive(state.mode === "preset" ? state.preset : null);
  updateFileMeta();
  bindUi();

  await renderCurrent({ reason: "initial" });
  requestAnimationFrame(() => fitStage());

  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(() => fitStage());
    observer.observe($.stageFrame);
  }
  window.addEventListener("resize", () => fitStage());
  document.fonts?.ready?.then(() => fitStage()).catch(() => {});

  if (location.protocol === "file:") {
    shell.showHint("file:// 模式下联网代理不可用；如需完整功能，请运行 node server.js。", "Blue");
  }
}

init().catch(error => {
  console.error(error);
  setRuntime("初始化失败", "error");
  shell.showModal({
    title: "初始化失败",
    caption: String(error?.message || error),
    buttons: ["确定"],
    warn: true
  });
});

