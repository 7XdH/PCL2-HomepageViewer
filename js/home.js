// Standalone homepage view — the PCL right-hand panel on its own page.
//
// It reuses the renderer, runtime, source loader and preset catalogue, but not
// js/app.js: that module owns the lab workspace (source panel, event log, modal
// layer) and throws when its nodes are missing. What is left here is the
// minimum wiring needed to render the last-used source into PCL's 550px panel,
// so the page shows the same pixels as the viewer's preview.

import { PclTheme } from "./theme.js";
import { PclRenderer } from "./renderer.js";
import { PclRuntime } from "./runtime.js";
import { createSourceLoader } from "./app/sources.js";
import { PRESETS, FALLBACK_XAML } from "./app/preset-catalog.js";
import { readStoredSourceState } from "./app/source-state.js";
import { HOME_CONTENT_WIDTH, computeHomeZoom } from "./app/home-fit.js";
import { createAppearance } from "./app/appearance.js";
import { getProxyUaCandidates } from "./ua.js";
import { isMinecraftUrl, normalizeExternalUrl } from "./url.js";
import { hintColors } from "./shell/helpers.js";

const ZOOM_KEY = "pcl.lab.home.zoom.v1";

const dom = {
  stage: document.querySelector("#homeStage"),
  panel: document.querySelector("#homePanel"),
  viewport: document.querySelector("#homeViewport"),
  root: document.querySelector("#homeRoot"),
  source: document.querySelector("#homeSource"),
  fit: document.querySelector("#homeFit"),
  hintStack: document.querySelector("#pclHintStack")
};

const state = {
  mode: "preset",
  preset: "tutorial",
  fileName: "Custom.xaml",
  url: "",
  ua: "",
  fileContent: "",
  urlContent: "",
  code: ""
};

let fitWidth = false;
let zoom = 1;
let renderToken = 0;
let renderAbort = null;
const presetCache = new Map();

// ---------------------------------------------------------------------------
// Shell: the standalone page has no chrome, so PCL events degrade to a runtime
// hint instead of a modal. Nothing is silent — the hint stack sits at the panel
// bottom exactly like PCL's own hint band.
// ---------------------------------------------------------------------------

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const shell = {
  showHint(text, type = "Blue") {
    if (!dom.hintStack) return;
    const message = String(text ?? "")
      .replace(/\r?\n/g, " ")
      .trim();
    if (!message) return;
    // Same palette, dedupe and lifespan as PclShell.showHint (js/shell/base.js)
    // so a hint raised here looks and behaves like one raised in the viewer.
    const normalized = String(type || "Blue").toLowerCase();
    const key = Object.keys(hintColors).find((name) => name.toLowerCase() === normalized) || "Blue";
    const colors = hintColors[key];
    const duplicate = Array.from(dom.hintStack.children).find((child) => child.dataset.text === message);
    if (duplicate) {
      duplicate.animate(
        [
          { transform: "translateX(0)" },
          { transform: "translateX(-8px)" },
          { transform: "translateX(8px)" },
          { transform: "translateX(-6px)" },
          { transform: "translateX(0)" }
        ],
        { duration: 260, easing: "ease-out" }
      );
      return;
    }
    const node = document.createElement("div");
    node.className = "pcl-runtime-hint";
    node.dataset.text = message;
    node.style.setProperty("--hint-a", colors[0]);
    node.style.setProperty("--hint-b", colors[1]);
    node.textContent = message;
    dom.hintStack.append(node);
    while (dom.hintStack.children.length > 20) dom.hintStack.firstElementChild?.remove();
    const lifespan = 800 + Math.min(23, Math.max(5, message.length)) * 180;
    window.setTimeout(() => {
      node.classList.add("is-leaving");
      window.setTimeout(() => node.remove(), 230);
    }, lifespan);
  },
  showModal({ title = "提示", caption = "", buttons = ["确定"], warn = false, activeIndex = 0 } = {}) {
    // A modal is how PCL reports anything the user must acknowledge, so this
    // page keeps a real one instead of collapsing it into a hint: the same
    // class names as the viewer mean css/pcl-theme.css already styles it.
    const buttonList = (Array.isArray(buttons) ? buttons : [buttons]).map((button) =>
      typeof button === "string" ? { label: button } : button
    );
    if (!buttonList.length) buttonList.push({ label: "确定" });
    const highlight =
      Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < buttonList.length ? activeIndex : 0;
    return new Promise((resolve) => {
      const layer = document.createElement("div");
      layer.className = "pcl-modal-layer home-modal";
      const modal = document.createElement("div");
      modal.className = "pcl-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      const inner = document.createElement("div");
      inner.className = "pcl-modal__inner";
      const heading = document.createElement("h2");
      heading.className = "pcl-modal__title";
      heading.textContent = title;
      const rule = document.createElement("div");
      rule.className = "pcl-modal__rule";
      rule.setAttribute("aria-hidden", "true");
      const body = document.createElement("div");
      body.className = "pcl-modal__caption";
      body.textContent = String(caption ?? "");
      const row = document.createElement("div");
      row.className = "pcl-modal__buttons";
      if (warn) layer.classList.add("is-warn");
      modal.setAttribute("aria-labelledby", "homeModalTitle");
      heading.id = "homeModalTitle";
      const finish = (index) => {
        layer.classList.add("is-leaving");
        modal.classList.add("is-leaving");
        document.removeEventListener("keydown", onKeyDown);
        window.setTimeout(() => {
          layer.remove();
          resolve(index);
        }, 170);
      };
      const onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        finish(buttonList.length > 1 ? buttonList.length - 1 : 0);
      };
      buttonList.forEach((button, index) => {
        const node = document.createElement("button");
        node.type = "button";
        node.className = "pcl-modal__button";
        if (buttonList.length > 1 && index === highlight) {
          node.classList.add("pcl-modal__button--highlight");
          node.setAttribute("aria-current", "true");
        }
        if (warn && index === 0) node.classList.add("pcl-modal__button--red");
        node.textContent = button.label ?? "确定";
        node.addEventListener("click", () => finish(index));
        row.append(node);
      });
      inner.append(heading, rule, body, row);
      modal.append(inner);
      layer.append(modal);
      dom.panel?.append(layer);
      document.addEventListener("keydown", onKeyDown);
      window.setTimeout(() => {
        const active = row.children[highlight] || row.querySelector("button");
        active?.focus();
      }, 40);
    });
  },
  // The runtime records every event through the shell; the viewer shows them in
  // a log, and here the only place they can surface is the hint band. Errors are
  // already reported by the runtime's own modal, so this stays quiet.
  pushEvent() {},
  openUrl(url) {
    const target = normalizeExternalUrl(url);
    if (!target) return false;
    try {
      const opened = window.open(target, "_blank", "noopener");
      return Boolean(opened) || isMinecraftUrl(target);
    } catch {
      return false;
    }
  },
  async copyText(text) {
    const value = String(text ?? "");
    try {
      await navigator.clipboard?.writeText(value);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
    try {
      const area = document.createElement("textarea");
      area.value = value;
      area.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  },
  download(url, fileName) {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName || "";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.append(link);
    link.click();
    link.remove();
  },
  pickFile(accept = "") {
    // Mirrors PclShellBase.pickFile: resolve with the chosen File, or null when
    // the picker is dismissed.
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
      let settled = false;
      const finish = (file) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(file || null);
      };
      input.addEventListener("change", () => finish(input.files?.[0]));
      input.addEventListener("cancel", () => finish(null));
      document.body.append(input);
      input.click();
      window.addEventListener("focus", () => window.setTimeout(() => finish(input.files?.[0]), 500), { once: true });
    });
  },
  switchPage() {
    // There is only one page here; a navigation request has nowhere to go.
    shell.showHint("此页面只显示主页内容，无法切换 PCL 页面。", "Blue");
  },
  confirm() {
    return Promise.resolve(true);
  },
  getVersion: () => "1.20.1-Fabric",
  getVersionInfo: () => ({
    name: "1.20.1-Fabric",
    meta: "Fabric 0.15.11",
    isLoading: false
  })
};

const runtime = new PclRuntime({
  shell,
  onRefresh: () => void renderNow(),
  onSettingChange: (key, value) => {
    if (key === "UiLauncherHue") {
      theme.setHue(Number(value));
      return;
    }
    // The viewer lists variables in a side panel; here they only affect
    // placeholders, and the next render picks them up.
    if (key === "__variables") return;
    shell.showHint(`已写入设置：${key} → ${value}`, "Green");
  },
  onOpenHelp: () => shell.showHint("此页面不提供帮助页；请在完整预览器中打开。", "Blue")
});

const theme = new PclTheme({ target: dom.panel });
const renderer = new PclRenderer({
  root: dom.root,
  runtime,
  getProxyUa: () => state.ua,
  getProxyUas: () => getProxyUaCandidates(state.ua)
});

const sources = createSourceLoader({
  state,
  PRESETS,
  presetCache,
  FALLBACK_XAML,
  getCode: () => state.code,
  getRuntimeContext: () => runtime.context
});

// ---------------------------------------------------------------------------
// Source resolution — identical rules to the viewer, so the same source can
// never render differently on the two pages.
// ---------------------------------------------------------------------------

function sourceLabel() {
  if (state.mode === "preset") {
    const preset = PRESETS[state.preset] || PRESETS.tutorial;
    return preset.pclId == null ? preset.title : `PCL2 预设 · ${preset.title}`;
  }
  if (state.mode === "file") return `本地文件 · ${state.fileName || "Custom.xaml"}`;
  if (state.mode === "url") return `联网主页 · ${state.url.replace(/^https?:\/\//, "")}`;
  return "自定义代码";
}

function showMessage(title, body) {
  dom.root.replaceChildren();
  const box = document.createElement("div");
  box.className = "pcl-home-message";
  const heading = document.createElement("p");
  heading.className = "pcl-home-message__title";
  heading.textContent = title;
  const text = document.createElement("p");
  text.className = "pcl-home-message__body";
  text.textContent = body;
  box.append(heading, text);
  dom.root.append(box);
}

async function renderNow() {
  const token = ++renderToken;
  renderAbort?.abort();
  const controller = new AbortController();
  renderAbort = controller;
  dom.source.textContent = sourceLabel();
  try {
    const content = await sources.resolveCurrentContent({ signal: controller.signal });
    if (token !== renderToken) return;
    renderer.render(content);
    if (token !== renderToken) return;
    if (renderer.issues.length) {
      // The viewer lists these under the render stats; here one hint is enough
      // to say the page would not load in PCL as written.
      const fatal = renderer.issues.filter((issue) => issue.severity === "error");
      shell.showHint(
        fatal.length
          ? `有 ${fatal.length} 处属性在 PCL 中会导致加载失败。`
          : `有 ${renderer.issues.length} 处属性可能不被 PCL 识别。`,
        fatal.length ? "Red" : "Yellow"
      );
    }
  } catch (error) {
    if (token !== renderToken) return;
    if (error?.name === "AbortError") return;
    showMessage("主页加载失败", String(error?.message || error));
  } finally {
    if (renderAbort === controller) renderAbort = null;
  }
}

// ---------------------------------------------------------------------------
// 1:1 vs fit-to-width
// ---------------------------------------------------------------------------

function readFitPreference() {
  try {
    return window.localStorage.getItem(ZOOM_KEY) === "fit";
  } catch {
    return false;
  }
}

function saveFitPreference() {
  try {
    window.localStorage.setItem(ZOOM_KEY, fitWidth ? "fit" : "ratio");
  } catch {
    /* ignore quota errors */
  }
}

function layout() {
  const width = dom.viewport?.clientWidth || window.innerWidth;
  const height = dom.viewport?.clientHeight || window.innerHeight;
  zoom = computeHomeZoom({ viewportWidth: width, fit: fitWidth });
  dom.stage.style.zoom = String(zoom);
  // The stage keeps PCL's real 550px width — `zoom` scales it and the 500px
  // content column inside it stays 500px, so line breaks never move. Only the
  // height is divided by the factor so the panel fills the viewport exactly.
  dom.stage.style.height = `${(height / zoom).toFixed(2)}px`;
  dom.fit?.setAttribute("aria-pressed", String(fitWidth));
  if (dom.fit) {
    dom.fit.title = fitWidth
      ? `适应宽度 ${Math.round(zoom * 100)}%，点击恢复 1:1`
      : `1:1 实际尺寸（内容宽 ${HOME_CONTENT_WIDTH}px），点击适应宽度`;
  }
}

function setFitWidth(value) {
  fitWidth = Boolean(value);
  saveFitPreference();
  layout();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function bindControls() {
  // The button starts hidden in the markup so a failed script never leaves a
  // dead control behind; the module is running, so reveal it now.
  dom.fit?.removeAttribute("hidden");
  dom.fit?.addEventListener("click", () => setFitWidth(!fitWidth));
  // The viewer and this page share localStorage; react when the other tab
  // changes the source so the standalone view never shows a stale homepage.
  window.addEventListener("storage", (event) => {
    if (event.key !== "pcl.lab.source.v1") return;
    restoreSource();
    void renderNow();
  });
  let frame = 0;
  window.addEventListener("resize", () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      layout();
    });
  });
}

function restoreSource() {
  const saved = readStoredSourceState(PRESETS, safeStorage());
  if (!saved) return false;
  state.mode = saved.mode;
  state.ua = saved.ua;
  if (saved.mode === "preset") {
    state.preset = saved.preset;
    return true;
  }
  state.fileName = saved.fileName;
  state.url = saved.url;
  state.fileContent = saved.mode === "file" ? saved.content : "";
  state.urlContent = saved.mode === "url" ? saved.content : "";
  state.code = saved.mode === "code" ? saved.content : "";
  return true;
}

async function boot() {
  // No switch on this page: it only mirrors the appearance choice stored by the
  // full viewer (js/app/appearance.js resolves `auto` against the OS).
  createAppearance();
  restoreSource();
  fitWidth = readFitPreference();
  bindControls();
  layout();
  // Two reasons to wait for the load event: webfonts (PCL English) are declared
  // in css/pcl-theme.css and would otherwise shift the first measurement, and
  // the scrollbar width changes once the panel has content.
  if (document.readyState === "complete") draw();
  else window.addEventListener("load", () => draw(), { once: true });
}

function draw() {
  document.documentElement.classList.add("home-ready");
  layout();
  if (window.__PCL_HOME__) window.__PCL_HOME__.ready = true;
  void renderNow();
}

// Exposed for the regression suite, mirroring window.__PCL_RENDERER__. Defined
// before boot() runs so the first draw can flip `ready`.
window.__PCL_HOME__ = {
  renderer,
  runtime,
  sources,
  state,
  renderNow,
  layout,
  setFitWidth,
  get fitWidth() {
    return fitWidth;
  },
  get zoom() {
    return zoom;
  },
  ready: false
};

void boot();
