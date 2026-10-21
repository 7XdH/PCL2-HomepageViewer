import { PclTheme } from "./theme.js";
import { PclRenderer } from "./renderer.js?v=20261021k";
import { PclRuntime } from "./runtime.js?v=20261021q";
import { PclShell } from "./shell.js?v=20261022a";
import { substitutePlaceholders } from "./xaml.js?v=20261021c";
import { getProxyUaCandidates, PCL_FALLBACK_UA } from "./ua.js?v=20261021e";
import { PCL2_PRESETS } from "./pcl-presets.js?v=20261021j";
import { resolveHelpUrls, helpJsonTitle, helpTitleFromXaml } from "./help.js?v=20261021n";
import {
  MAX_SOURCE_BYTES,
  SOURCE_STATE_PERSIST_LIMIT,
  assertSourceWithinLimit,
  sourceLimitError
} from "./limits.js?v=20261022b";

const SOURCE_KEY = "pcl.lab.source.v1";

const LOCAL_PRESETS = {
  tutorial: { title: "PCL 原版教程", path: "assets/presets/tutorial.xaml" },
  gallery: { title: "控件画廊", path: "assets/presets/gallery.xaml" },
  events: { title: "事件测试台", path: "assets/presets/events.xaml" },
  hint: { title: "你知道吗", path: "assets/presets/hint.xaml" }
};

const PRESETS = {
  ...LOCAL_PRESETS,
  ...Object.fromEntries(
    PCL2_PRESETS.map(preset => [
      `pcl2-${preset.id}`,
      {
        title: preset.name,
        kind: preset.kind || "remote",
        url: preset.url || "",
        xaml: preset.xaml || "",
        expected: preset.expected,
        pclId: preset.id
      }
    ])
  )
};

const PCL2_OK_COUNT = PCL2_PRESETS.filter(preset => preset.expected === "ok").length;
const PCL_PRESET_STATES = {
  ok: { label: "通常可用", className: "ok", hint: "按 PCL2 UA 拉取，已知可以正常渲染。" },
  unavailable: { label: "上游可能不可用", className: "warn", hint: "上游站点可能已下线；点击后仍会尝试拉取。" },
  blocked: { label: "会被安全阻止", className: "blocked", hint: "上游主页包含 x:Static 或 x:Code，渲染器会拒绝执行。" }
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
let renderAbort = null;
let lastRenderedContent = "";
let codeDirty = false;
let currentFilter = "";
let helpToken = 0;
let helpAbort = null;
let helpHistory = [];
let helpReturnFocus = null;
let sourceStateWarned = false;

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
  pclPresetList: el("pclPresetList"),
  pclPresetSearch: el("pclPresetSearch"),
  pclPresetCount: el("pclPresetCount"),
  pclPresetEmpty: el("pclPresetEmpty"),
  helpScroll: el("pclHelpScroll"),
  helpRoot: el("pclHelpRoot"),
  eventText: el("eventText"),
  eventCount: el("eventCount"),
  helpBtn: el("helpBtn"),
  renderBtn: el("renderBtn"),
  refreshBtn: el("refreshBtn"),
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
  onSettingChange: (key, value) => handleSettingChange(key, value),
  onOpenHelp: address => openRemoteHelp(address)
});
shell.onAccountChange = user => runtime.setUser(user);
theme.setHue(Number(runtime.settings.UiLauncherHue));

const renderer = new PclRenderer({
  root: $.root,
  runtime,
  getProxyUa: () => state.ua,
  getProxyUas: () => getProxyUaCandidates(state.ua)
});

const helpRenderer = new PclRenderer({
  root: $.helpRoot,
  runtime,
  getProxyUa: () => state.ua,
  getProxyUas: () => getProxyUaCandidates(state.ua)
});

shell.onSubpageBack = () => goBackHelp();
shell.onSubpageDismiss = () => resetHelpState();

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
  for (const button of document.querySelectorAll("#presetList [data-preset], #pclPresetList [data-preset]")) {
    button.classList.toggle("is-active", button.dataset.preset === id);
  }
}

function pclPresetHost(preset) {
  if (!preset.url) return "内置 XAML";
  return preset.url.replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
}

function renderPclPresets(filter = "") {
  if (!$.pclPresetList) return;
  const query = filter.trim().toLowerCase();
  const items = PCL2_PRESETS.filter(preset => {
    const info = preset.kind === "inline"
      ? { label: "内置内容" }
      : PCL_PRESET_STATES[preset.expected] || PCL_PRESET_STATES.unavailable;
    const haystack = `${preset.name} ${preset.url || ""} ${info.label}`.toLowerCase();
    return !query || haystack.includes(query);
  });

  $.pclPresetList.replaceChildren();
  for (const preset of items) {
    const key = `pcl2-${preset.id}`;
    const info = preset.kind === "inline"
      ? { label: "内置内容", className: "inline", hint: "直接使用内置 XAML，无需联网。" }
      : PCL_PRESET_STATES[preset.expected] || PCL_PRESET_STATES.unavailable;
    const host = pclPresetHost(preset);

    const button = document.createElement("button");
    button.type = "button";
    button.className = `preset-item preset-item--pcl preset-item--${info.className}`;
    button.dataset.preset = key;
    button.title = `${preset.name}\n${preset.url || "内置 XAML"}\n${info.hint}`;
    button.setAttribute("aria-label", `${preset.name}，${info.label}`);

    const glyph = document.createElement("span");
    glyph.className = "preset-item__glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = String(preset.id).padStart(2, "0");

    const body = document.createElement("span");
    body.className = "preset-item__body";
    const strong = document.createElement("strong");
    strong.textContent = preset.name;
    const small = document.createElement("small");
    const hostSpan = document.createElement("span");
    hostSpan.className = "preset-host";
    hostSpan.textContent = host;
    const stateSpan = document.createElement("span");
    stateSpan.className = `preset-state preset-state--${info.className}`;
    stateSpan.textContent = info.label;
    small.append(hostSpan, stateSpan);
    body.append(strong, small);

    const arrow = document.createElement("span");
    arrow.className = "preset-item__arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";

    button.append(glyph, body, arrow);
    $.pclPresetList.append(button);
  }

  if ($.pclPresetEmpty) $.pclPresetEmpty.hidden = items.length > 0;
  if ($.pclPresetCount) {
    $.pclPresetCount.textContent = query
      ? `${items.length}/${PCL2_PRESETS.length} 个`
      : `${PCL2_PRESETS.length} 个 · ${PCL2_OK_COUNT} 可渲染`;
  }
  setPresetActive(state.mode === "preset" ? state.preset : null);
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
    const preset = PRESETS[state.preset];
    $.fileMeta.textContent = `${preset?.url ? "在线预设" : "预设"} · ${preset?.title || "未知"}`;
  } else {
    $.fileMeta.textContent = "尚未选择文件";
  }
}

async function loadPreset(id, { force = false, signal } = {}) {
  const preset = PRESETS[id] || PRESETS.tutorial;
  const cacheKey = PRESETS[id] ? id : "tutorial";
  if (preset.kind === "inline") return preset.xaml;

  if (preset.url) {
    if (!force && presetCache.has(cacheKey)) return presetCache.get(cacheKey);
    try {
      const text = await fetchRemoteXaml(resolveRemoteUrl(preset.url), {
        uaCandidates: getProxyUaCandidates(PCL_FALLBACK_UA),
        signal
      });
      presetCache.set(cacheKey, text);
      return text;
    } catch (error) {
      if (error.name === "AbortError" || error.code === "SOURCE_TOO_LARGE") throw error;
      throw new Error(`无法加载 PCL2 预设「${preset.title}」：${error.message}`);
    }
  }

  if (!force && presetCache.has(cacheKey)) return presetCache.get(cacheKey);
  try {
    const response = await fetch(preset.path, {
      signal,
      cache: force ? "no-store" : "no-cache"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await readResponseTextLimited(response, `预设「${preset.title}」`);
    if (!text.trim()) throw new Error("预设内容为空");
    presetCache.set(cacheKey, text);
    return text;
  } catch (error) {
    if (error.name === "AbortError" || error.code === "SOURCE_TOO_LARGE") throw error;
    if (location.protocol === "file:") {
      presetCache.set(cacheKey, FALLBACK_XAML);
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
    const serialized = JSON.stringify(payload);
    if (serialized.length < SOURCE_STATE_PERSIST_LIMIT) {
      localStorage.setItem(SOURCE_KEY, serialized);
    } else if (!sourceStateWarned) {
      sourceStateWarned = true;
      shell.showHint(
        "主页内容超过约 500 KB，刷新后不会自动恢复；请使用“导出”保存。",
        "Yellow"
      );
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
  const label = `文件“${file.name || "Custom.xaml"}”`;
  if (file.size > MAX_SOURCE_BYTES) throw sourceLimitError(file.size, label);
  const text = await file.text();
  return assertSourceWithinLimit(text.replace(/^\uFEFF/, ""), label);
}

async function applyFile(file) {
  if (!file) return;
  let content;
  try {
    content = await readFileAsXaml(file);
  } catch (error) {
    shell.showModal({
      title: "无法打开文件",
      caption: String(error?.message || error),
      buttons: ["确定"],
      warn: true
    });
    return;
  }
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

async function readResponseTextLimited(response, label = "远程内容") {
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

async function fetchViaProxy(url, signal, ua = "", label = "远程内容") {
  const proxyUrl = new URL("api/proxy", document.baseURI);
  proxyUrl.searchParams.set("url", url);
  if (ua) proxyUrl.searchParams.set("ua", ua);
  const response = await fetch(proxyUrl, { signal, cache: "no-store" });
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok || contentType.includes("text/html")) {
    const text = await readResponseTextLimited(response, `${label}错误响应`).catch(() => "");
    const error = new Error(text.trim() || `代理返回 HTTP ${response.status}`);
    error.status = response.status;
    error.code = contentType.includes("text/html") ? "PROXY_HTML" : "PROXY_HTTP";
    throw error;
  }
  return readResponseTextLimited(response, label);
}

async function fetchDirect(url, signal, label = "远程内容") {
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
  return readResponseTextLimited(response, label);
}

function isLikelyXaml(source) {
  let text = String(source ?? "").replace(/^\uFEFF/, "").trim();
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

function isLikelyJson(source) {
  const text = String(source ?? "").replace(/^\uFEFF/, "").trim();
  if (!text || !/^[\[{]/.test(text)) return false;
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed) && typeof parsed === "object";
  } catch {
    return false;
  }
}

function responseKind(content) {
  const sample = String(content ?? "").replace(/^\uFEFF/, "").trimStart();
  return /^[\[{]/.test(sample)
    ? "JSON"
    : /^<!doctype\s+html\b|^<html(?:\s|>)/i.test(sample)
      ? "HTML"
      : sample
        ? "纯文本或其他格式"
        : "空内容";
}

function assertRemoteResponse(content, url, { expect = "xaml", label = "联网主页" } = {}) {
  if (expect === "json" ? isLikelyJson(content) : isLikelyXaml(content)) return content;
  const expected = expect === "json" ? "JSON" : "XAML";
  const error = new Error(
    `无法拉取${label}：目标地址返回的不是 ${expected}（${responseKind(content)}）。\n\n${url}`
  );
  error.code = expect === "json" ? "NOT_JSON" : "NOT_XAML";
  throw error;
}

async function fetchRemoteText(
  url,
  {
    uaCandidates = getProxyUaCandidates(state.ua),
    expect = "xaml",
    label = "联网主页",
    signal
  } = {}
) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 22000);
  let proxyError = null;
  try {
    if (location.protocol === "http:" || location.protocol === "https:") {
      for (const ua of uaCandidates) {
        try {
          const content = await fetchViaProxy(url, controller.signal, ua, label);
          try {
            return assertRemoteResponse(content, url, { expect, label });
          } catch (error) {
            if (error.name === "AbortError") throw error;
            proxyError = error;
          }
        } catch (error) {
          if (error.name === "AbortError") throw error;
          proxyError = error;
        }
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
        `无法拉取${label}：${proxyError.message}\n\n` +
        "请确认地址有效，或检查代理设置是否可用。"
      );
    }

    let directContent;
    try {
      directContent = await fetchDirect(url, controller.signal, label);
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
        `无法拉取${label}：${error.message}\n\n` +
        proxyHint + "\n" +
        "目标站点未开放 CORS 时，需要可用的服务端代理（例如 Vercel Function /api/proxy），" +
        "或运行 node server.js 使用本地代理。"
      );
    }
    return assertRemoteResponse(directContent, url, { expect, label });
  } catch (error) {
    if (error.name === "AbortError" && timedOut) throw new Error("请求超时（22 秒）。");
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function fetchRemoteXaml(url, options = {}) {
  return fetchRemoteText(url, { ...options, expect: "xaml" });
}


function resolveRemoteUrl(url) {
  // PCL expands placeholders before requesting the page; URL values must not be XML-escaped.
  return substitutePlaceholders(url, runtime.context, { escape: false });
}

async function resolveCurrentContent({ forceRemote = false, signal } = {}) {
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
      const content = await fetchRemoteXaml(resolveRemoteUrl(state.url), { signal });
      state.urlContent = content;
    }
    if (!state.urlContent.trim()) throw new Error("联网主页返回了空内容。");
    return state.urlContent;
  }
  return loadPreset(state.preset, { force: forceRemote, signal });
}

function sourceLabel() {
  if (state.mode === "preset") {
    const preset = PRESETS[state.preset];
    if (!preset) return "PCL 预设";
    return preset.pclId == null ? preset.title : `PCL2 · ${preset.title}`;
  }
  if (state.mode === "file") return state.fileName || "本地 XAML";
  if (state.mode === "url") return state.url.replace(/^https?:\/\//, "") || "联网主页";
  return "内联源码";
}

async function renderCurrent({ reason = "manual", forceRemote = false } = {}) {
  const token = ++renderToken;
  renderAbort?.abort();
  const controller = new AbortController();
  renderAbort = controller;
  const activePreset = state.mode === "preset" ? PRESETS[state.preset] : null;
  const remotePreset = Boolean(activePreset?.url);
  setRuntime(reason === "initial" ? "正在加载" : "正在渲染", "busy");
  $.renderBtn.disabled = true;
  const network =
    (state.mode === "url" && (!state.urlContent || forceRemote)) ||
    (remotePreset && (forceRemote || !presetCache.has(state.preset)));
  if (network) {
    shell.setLoading(true, remotePreset ? `正在拉取 PCL2 预设「${activePreset.title}」…` : "正在拉取联网主页…");
  } else {
    shell.setLoading(false, "");
  }

  try {
    const content = await resolveCurrentContent({ forceRemote, signal: controller.signal });
    if (token !== renderToken) return false;
    assertSourceWithinLimit(content, sourceLabel());
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
    if (token !== renderToken || error.name === "AbortError") return false;
    setRuntime("渲染失败", "error");
    $.renderStats.textContent = "渲染失败";
    $.renderStats.title = error.message || String(error);
    shell.setLoading(false);
    const message = String(error.message || error);
    const sourceTooLarge = error.code === "SOURCE_TOO_LARGE";
    const networkFailure = (state.mode === "url" || remotePreset) && message.includes("无法拉取联网主页");
    shell.showModal({
      title: sourceTooLarge
        ? "主页内容过大"
        : networkFailure
          ? (remotePreset ? "PCL2 预设加载失败" : "联网主页加载失败")
          : "加载主页失败",
      caption: sourceTooLarge
        ? message
        : networkFailure
          ? message
          : `主页内容编写有误，请根据下列错误信息进行检查：\n\n${message}`,
      buttons: sourceTooLarge ? ["确定"] : ["重试", "取消"],
      warn: true
    }).then(choice => {
      if (!sourceTooLarge && choice === 0) renderCurrent({ forceRemote: true });
    });
    return false;
  } finally {
    if (renderAbort === controller) {
      renderAbort = null;
      shell.setLoading(false);
      $.renderBtn.disabled = false;
    }
  }
}

function renderHelpEntry(entry) {
  if (!entry) return;
  helpRenderer.render(entry.xaml);
  shell.showHelpPage(entry.title);
  if ($.helpScroll) $.helpScroll.scrollTop = 0;
  window.setTimeout(
    () => document.getElementById("pclSubpageBack")?.focus({ preventScroll: true }),
    30
  );
}

async function openRemoteHelp(raw) {
  const address = resolveRemoteUrl(String(raw ?? "").trim());
  const urls = resolveHelpUrls(address);
  if (!urls) {
    throw new Error(
      `这个帮助地址不是可用的 PCL 远程帮助 JSON / XAML 页面。\n\n${address || "（空）"}`
    );
  }

  const token = ++helpToken;
  helpAbort?.abort();
  const controller = new AbortController();
  helpAbort = controller;
  if (!helpHistory.length) helpReturnFocus = document.activeElement;
  shell.setLoading(true, "正在打开帮助…");
  const uaCandidates = getProxyUaCandidates(PCL_FALLBACK_UA);
  try {
    const metadata = fetchRemoteText(urls.jsonUrl, {
      uaCandidates,
      expect: "json",
      label: "帮助信息",
      signal: controller.signal
    })
      .then(source => helpJsonTitle(source, ""))
      .catch(() => "");
    const [xaml, metadataTitle] = await Promise.all([
      fetchRemoteXaml(urls.xamlUrl, {
        uaCandidates,
        label: "帮助页面",
        signal: controller.signal
      }),
      metadata
    ]);
    if (token !== helpToken) return "cancelled";

    const entry = {
      url: urls.xamlUrl,
      title: metadataTitle || helpTitleFromXaml(xaml),
      xaml
    };
    helpHistory.push(entry);
    try {
      renderHelpEntry(entry);
    } catch (error) {
      helpHistory.pop();
      throw error;
    }
    return entry.title;
  } catch (error) {
    if (token !== helpToken || error.name === "AbortError") return "cancelled";
    throw error;
  } finally {
    if (helpAbort === controller) helpAbort = null;
    if (token === helpToken) shell.setLoading(false, "");
  }
}

function goBackHelp() {
  if (helpHistory.length > 1) {
    helpHistory.pop();
    renderHelpEntry(helpHistory[helpHistory.length - 1]);
    return;
  }
  closeHelp();
}

function resetHelpState() {
  helpAbort?.abort();
  helpAbort = null;
  helpToken += 1;
  helpHistory = [];
  $.helpRoot?.replaceChildren();
}

function closeHelp() {
  const focusTarget = helpReturnFocus;
  helpReturnFocus = null;
  resetHelpState();
  shell.closeHelpPage();
  shell.setLoading(false, "");
  focusTarget?.focus?.({ preventScroll: true });
}

function fitStage() {
  const frame = $.stageFrame;
  if (!frame) return;
  if (frame.clientWidth <= 0 || frame.clientHeight <= 0) return;

  // .stage__frame 的 padding 与这里保持一致：左右各 36px、上方 16px、下方 88px
  //（100% 缩放下的阴影扩散量）。阴影随 transform 缩放，所以 padding 也用
  // --pcl-scale 计算，避免窄屏或矮窗口把阴影裁在 frame 边缘。
  const shadowX = 36;
  const shadowTop = 16;
  const shadowBottom = 88;
  const gutter = 4;
  const caption = frame.querySelector(".stage__caption");
  const captionStyle = caption ? window.getComputedStyle(caption) : null;
  const captionBlock =
    caption && captionStyle?.display !== "none"
      ? caption.getBoundingClientRect().height + (parseFloat(captionStyle.marginTop) || 0)
      : 0;
  const mobile = window.innerWidth <= 820;
  const minScale = mobile ? 0.2 : 0.5;
  const maxScale = 1.35;

  let scale = Math.min(
    maxScale,
    Math.max(1, frame.clientWidth - gutter) / (850 + shadowX * 2),
    Math.max(1, frame.clientHeight - captionBlock - gutter) / (500 + shadowTop + shadowBottom)
  );
  if (scale < minScale) scale = minScale;
  scale = Math.max(0.2, Math.floor(scale * 1000) / 1000);
  document.documentElement.style.setProperty("--pcl-scale", String(scale));
  if ($.zoomLabel) $.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
}


async function loadPresetAndRender(id) {
  const preset = PRESETS[id];
  if (!preset) return;
  state.mode = "preset";
  state.preset = id;
  codeDirty = false;
  setPresetActive(id);
  if (preset.url) {
    $.urlInput.value = preset.url;
    setActiveTab("url");
  } else {
    setActiveTab("file");
  }
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
      "2. 渲染时会解析 PCL 的 WPF XAML 方言，支持 MyCard、MyHint、MyButton、MyTextButton、MyIconButton、MyIconTextButton、MyListItem、MyImage，以及 StackPanel、Grid、UniformGrid、GroupBox、Border、TextBlock、Path 等常用 WPF 控件。\n" +
      "3. 自定义事件会进入事件引擎：打开网页、弹出窗口、弹出提示、复制文本、刷新主页、修改变量、切换页面等均可工作。修改设置与变量会保存在 localStorage 中，并参与 {variable:...} 与 {setup:...} 替换；同时支持 PCL 版本、路径、日期、实例和加载器标记。\n\n" +
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
  $.pclPresetSearch?.addEventListener("input", () => renderPclPresets($.pclPresetSearch.value));
  $.pclPresetList?.addEventListener("click", event => {
    const button = event.target.closest?.("[data-preset]");
    if (button) loadPresetAndRender(button.dataset.preset);
  });

  $.renderBtn?.addEventListener("click", () => renderCurrent({ reason: "manual" }));
  $.refreshBtn?.addEventListener("click", () => renderCurrent({ reason: "refresh", forceRemote: true }));
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
    if (event.key === "Escape" && shell.isHelpPageOpen() && shell.modalLayer.hidden) {
      event.preventDefault();
      goBackHelp();
      return;
    }
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
  window.__PCL_RENDERER__ = { renderer, runtime, shell, theme, renderCurrent, state, ready: false };
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
  renderPclPresets();
  setPresetActive(state.mode === "preset" ? state.preset : null);
  updateFileMeta();
  bindUi();

  await renderCurrent({ reason: "initial" });
  window.__PCL_RENDERER__.ready = true;
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

