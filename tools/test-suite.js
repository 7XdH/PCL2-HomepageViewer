import { PclRenderer } from "../js/renderer.js";
import { PclRuntime } from "../js/runtime.js";
import { substitutePlaceholders } from "../js/xaml.js";
import { getProxyUaCandidates, PCL_FALLBACK_UA } from "../js/ua.js";
import {
  resolveHelpUrls,
  resolveHelpXamlUrl,
  helpJsonTitle,
  helpTitleFromXaml
} from "../js/help.js";
import { isOpenableExternalUrl, normalizeExternalUrl } from "../js/url.js";
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
      throw new Error(`搜索结果不正确：${filtered.map(item => item.textContent.trim()).join(" | ")}`);
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
    let highlighted = buttons.find(button => button.classList.contains("pcl-modal__button--highlight"));
    if (!highlighted || highlighted.textContent !== initial) {
      throw new Error(`初始高亮错误：期望 ${initial}，实际 ${highlighted?.textContent || "无"}`);
    }

    const target = buttons.find(button => button.textContent !== initial && button.textContent !== "取消");
    if (!target) throw new Error("找不到另一个可切换版本");
    target.click();
    await sleep(280);
    if (versionName.textContent !== target.textContent) {
      throw new Error(`版本没有切换：期望 ${target.textContent}，实际 ${versionName.textContent}`);
    }

    card.click();
    await sleep(140);
    buttons = [...document.querySelectorAll("#pclModalButtons button")];
    highlighted = buttons.find(button => button.classList.contains("pcl-modal__button--highlight"));
    if (!highlighted || highlighted.textContent !== target.textContent) {
      throw new Error(`切换后高亮错误：期望 ${target.textContent}，实际 ${highlighted?.textContent || "无"}`);
    }
    buttons.find(button => button.textContent === "取消")?.click();
    await sleep(280);
    shell.setVersion(initial);
    return { from: initial, to: target.textContent };
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
      .find(button => button.textContent === "知道了")
      ?.click();
    await sleep(280);
    return { captionTop, captionHeight: caption.clientHeight };
  });

  await makeCheck(results, "外部链接协议白名单", async () => {
    const cases = [
      ["https://example.com", true],
      ["http://example.com", true],
      ["mailto:test@example.com", true],
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

    const modalTitles = [];
    let opened = 0;
    const originalModal = harness.runtime.shell.showModal;
    const originalOpenUrl = harness.runtime.shell.openUrl;
    harness.runtime.shell.showModal = async options => {
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
      if (invalidResult !== "invalid-url") throw new Error(`非法协议返回值错误：${invalidResult}`);
      if (validResult !== "https://example.com") throw new Error(`合法协议返回值错误：${validResult}`);
    } finally {
      harness.runtime.shell.showModal = originalModal;
      harness.runtime.shell.openUrl = originalOpenUrl;
    }
    if (opened !== 1) throw new Error(`非法协议不应打开窗口：实际打开 ${opened} 次`);
    if (!modalTitles.includes("事件执行失败")) throw new Error("非法协议没有显示错误弹窗");
    return { cases: cases.length, opened };
  });

  await makeCheck(results, "PCL 帮助页地址与标题", async () => {
    const jsonUrl = "https://mcnews.meloong.com/VersionArchiveList.json";
    const urls = resolveHelpUrls(jsonUrl);
    if (urls?.xamlUrl !== "https://mcnews.meloong.com/VersionArchiveList.xaml") {
      throw new Error(`JSON 帮助地址没有转换为 XAML：${urls?.xamlUrl || "（空）"}`);
    }
    if (urls?.jsonUrl !== jsonUrl) throw new Error(`帮助 JSON 地址被错误改写：${urls?.jsonUrl}`);
    if (resolveHelpXamlUrl(jsonUrl) !== urls.xamlUrl) throw new Error("resolveHelpXamlUrl 与解析结果不一致");

    const direct = resolveHelpUrls(
      "https://mcnews.meloong.com/versions/list/wilderness_bound.xaml?x=1"
    );
    if (direct?.xamlUrl !== "https://mcnews.meloong.com/versions/list/wilderness_bound.xaml?x=1") {
      throw new Error(`XAML 帮助地址被错误改写：${direct?.xamlUrl}`);
    }
    if (direct?.jsonUrl !== "https://mcnews.meloong.com/versions/list/wilderness_bound.json?x=1") {
      throw new Error(`XAML 对应 JSON 地址错误：${direct?.jsonUrl}`);
    }
    if (resolveHelpXamlUrl("https://mcnews.meloong.com/versions/list/latest") !== "https://mcnews.meloong.com/versions/list/latest.xaml") {
      throw new Error("无扩展名帮助地址没有补全 .xaml");
    }
    if (resolveHelpUrls("帮助/自定义帮助.json") !== null) throw new Error("相对帮助路径不应被当作远程地址");

    const xamlTitle = helpTitleFromXaml('<StackPanel><local:MyCard Title="版本列表">内容</local:MyCard></StackPanel>');
    if (xamlTitle !== "版本列表") throw new Error(`XAML 帮助标题解析错误：${xamlTitle}`);
    const jsonTitle = helpJsonTitle('{"Title":"版本历史记录 | 奔赴荒野 | 26.3"}');
    if (jsonTitle !== "版本历史记录 | 奔赴荒野 | 26.3") throw new Error(`JSON 帮助标题解析错误：${jsonTitle}`);

    const calls = [];
    harness.runtime.onOpenHelp = async url => calls.push(url);
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

  await makeCheck(results, "WPF MaxHeight 行高", async () => {
    const text = "这段文字用于验证换行后的行距不会重叠。WPF 默认 LineStackingStrategy 是 MaxHeight，因此 LineHeight 小于字体行高时应取字体行高。";
    const xaml = `<FlowDocument FontSize="14"><Paragraph Width="180" LineHeight="12">${text}</Paragraph></FlowDocument>`;
    const metrics = await renderSource(harness, xaml);
    const paragraph = harness.root.querySelector('[data-pcl-type="Paragraph"]');
    if (!paragraph) throw new Error("Paragraph 未渲染");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 1 && rect.height > 1);
    const lines = [];
    for (const rect of rects.sort((a, b) => a.top - b.top)) {
      const line = lines.find(item => Math.abs(item.top - rect.top) < 2);
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
        .filter(rect => rect.width > 1 && rect.height > 1)
        .map(rect => Math.round(rect.top))
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

