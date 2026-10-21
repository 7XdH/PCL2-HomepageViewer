import { PclRenderer } from "../js/renderer.js";
import { PclRuntime } from "../js/runtime.js";
import { substitutePlaceholders } from "../js/xaml.js";
import { getProxyUaCandidates, PCL_FALLBACK_UA } from "../js/ua.js";
import { PCL_PRESETS, PCL_TEST_UA } from "./pcl-presets.mjs";

const LOCAL_PRESETS = [
  { name: "PCL 原版教程", path: "/assets/presets/tutorial.xaml" },
  { name: "控件画廊", path: "/assets/presets/gallery.xaml" },
  { name: "事件测试台", path: "/assets/presets/events.xaml" },
  { name: "你知道吗", path: "/assets/presets/hint.xaml" }
];

const createHarness = () => {
  const root = document.createElement("div");
  root.id = "pclRegressionRoot";
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
  const renderer = new PclRenderer({ root, runtime, getProxyUas: () => getProxyUaCandidates("") });
  return { root, runtime, renderer };
};

const textOf = node => String(node?.textContent || "").replace(/\s+/g, " ").trim();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const waitForImages = async (root, timeout = 8000) => {
  const started = Date.now();
  let lastSignature = "";
  let stableTicks = 0;

  while (Date.now() - started < timeout) {
    const images = [...root.querySelectorAll("img")];
    const pending = images.some(
      image => !image.getAttribute("src") || !image.complete || image.parentElement?.classList.contains("is-loading")
    );
    const signature = images
      .map(image => `${image.src}|${image.complete}|${image.naturalWidth}|${image.naturalHeight}`)
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
    unsupported: root.querySelectorAll(".pcl-unsupported").length,
    cards: root.querySelectorAll(".pcl-card").length,
    images: images.length,
    brokenImages: images.filter(image => image.naturalWidth === 0).length,
    textLength: textOf(root).length
  };
};

const fetchText = async url => {
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.trim().slice(0, 180)}`);
  return text;
};

const fetchRemoteXaml = async (url, runtime) => {
  const proxy = new URL("/api/proxy", location.origin);
  proxy.searchParams.set("url", substitutePlaceholders(url, runtime.context, { escape: false }));
  proxy.searchParams.set("ua", PCL_TEST_UA);
  const response = await fetch(proxy, { cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(`proxy HTTP ${response.status}: ${text.trim().slice(0, 180)}`);
  if (!/^\s*</.test(text)) throw new Error(`proxy 返回的不是 XAML：${text.trim().slice(0, 100)}`);
  return text;
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
    .then(detail => {
      results.push({ name, ok: true, detail });
    })
    .catch(error => {
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
    if (!grid) throw new Error("UniformGrid 未渲染");
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean);
    if (columns.length !== 2) throw new Error(`UniformGrid 没有形成两列：${columns.join(" ")}`);
    if (metrics.unsupported || metrics.warnings.length) throw new Error("组件渲染出现警告");
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
    const values = Object.fromEntries(Object.keys(expected).map(key => [key, harness.runtime.getPlaceholder(key)]));
    for (const [key, value] of Object.entries(expected)) {
      if (values[key] !== value) throw new Error(`${key} 期望 ${value}，实际 ${values[key]}`);
    }

    harness.runtime.variables.TestXml = "<&";
    const escaped = substitutePlaceholders("{variable:TestXml}", harness.runtime.context);
    if (escaped !== "&lt;&amp;") throw new Error(`变量没有正确转义：${escaped}`);
    const rawUrl = substitutePlaceholders(
      "https://example.com/{version}/{name}?a=1&b=2",
      harness.runtime.context,
      { escape: false }
    );
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
      throw new Error(`舞台出现溢出：${frame.scrollWidth}×${frame.scrollHeight} > ${frame.clientWidth}×${frame.clientHeight}`);
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
    return { scale, inset, radius };
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

  const ok = results.every(item => item.ok);
  window.__PCL_TEST_RESULT__ = { suite: "regression", ok, results };
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
  const harness = createHarness();
  const results = [];

  for (const preset of PCL_PRESETS) {
    const started = performance.now();
    const record = {
      id: preset.id,
      name: preset.name,
      expected: preset.expected,
      status: "pending",
      pass: false,
      duration: 0,
      stage: "start",
      error: "",
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
      record.stage = "render";
      record.metrics = await renderSource(harness, source, true);
      record.stage = "done";
    } catch (error) {
      record.error = String(error?.message || error);
    }

    record.duration = Math.round(performance.now() - started);
    const classification = classifyPreset(preset, record);
    record.status = classification.status;
    record.pass = classification.pass;
    results.push(record);
  }

  const counts = results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const ok = results.every(item => item.pass);
  window.__PCL_TEST_RESULT__ = { suite: "presets", ok, counts, results };
  return window.__PCL_TEST_RESULT__;
}

