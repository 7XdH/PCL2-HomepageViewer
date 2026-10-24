import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  PclXamlError,
  escapeXml,
  resolveColor,
  resolveCursor,
  sanitizeFontFamily,
  isSafeCssColor,
  parseDouble,
  parseBool,
  parseThickness,
  parseCornerRadius,
  parseFontWeight,
  substitutePlaceholders,
  resolveImageSource
} from "../js/xaml.js";
import { buildPalette, normalizeHue } from "../js/theme.js";
import { BBOX_CACHE_LIMIT, bboxCache, rememberBBox } from "../js/renderer/helpers.js";
import { helpJsonTitle, resolveHelpUrls, resolveHelpXamlUrl } from "../js/help.js";
import { isOpenableExternalUrl, isMinecraftUrl, normalizeExternalUrl, parseRemoteHomeUrl } from "../js/url.js";
import { classifyRenderError, renderErrorCaption } from "../js/app/render-error.js";
import { exportFileName, resolveExportSource, safeFileName } from "../js/app/export-source.js";
import {
  MAX_SOURCE_BYTES,
  assertSourceWithinLimit,
  formatByteSize,
  PRESET_CACHE_LIMIT,
  HELP_HISTORY_LIMIT,
  EVENT_LOG_LIMIT,
  EVENT_DATA_LIMIT
} from "../js/limits.js";
import { LruCache } from "../js/lru-cache.js";
import {
  PROXY_STATUS_HEADER,
  ProxyError,
  assertPublicTarget,
  createPinnedLookup,
  isBlockedAddress,
  isImageContentType,
  isTextContentType,
  normalizeUserAgent,
  parseTarget,
  proxyFailure,
  resolvePublicAddresses,
  resolveRedirect
} from "../api/proxy-core.js";
import { isSvgResponse, svgResponseHeaders } from "../api/proxy-policy.js";
import proxyHandler from "../api/proxy.js";
import netlifyProxy from "../netlify/functions/proxy.mjs";

const proxyError = (status) => (error) => {
  assert.ok(error instanceof ProxyError, `expected ProxyError, got ${error}`);
  assert.equal(error.status, status);
  return true;
};

test("xaml: XML escaping and placeholders", () => {
  assert.equal(escapeXml("<&>\"'\r\n"), "&lt;&amp;&gt;&quot;&apos;&#xA;");
  assert.equal(
    substitutePlaceholders("{variable:NAME:fallback}", {
      getVariable: (name, fallback) => (name === "NAME" ? `<${fallback}>` : fallback)
    }),
    "&lt;fallback&gt;"
  );
  assert.equal(
    substitutePlaceholders(
      "{variable:NAME:fallback}",
      {
        getVariable: (_name, fallback) => fallback
      },
      { escape: false }
    ),
    "fallback"
  );
  assert.equal(
    substitutePlaceholders("{setup:UiLauncherHue}", {
      getSetting: (key) => (key === "UiLauncherHue" ? "30" : "")
    }),
    "30"
  );
  assert.equal(substitutePlaceholders("{unknown}", {}), "{unknown}");
});

test("xaml: numeric and color parsing", () => {
  assert.equal(parseDouble("12px"), 12);
  assert.equal(parseDouble("bad", 7), 7);
  assert.equal(parseBool("YES"), true);
  assert.equal(parseBool("no"), false);
  assert.deepEqual(parseThickness("1,2,3,4"), {
    l: 1,
    t: 2,
    r: 3,
    b: 4,
    css: "2px 3px 4px 1px"
  });
  // Three values used to leave the fourth side as `undefinedpx`. WPF only takes
  // 1, 2 or 4 numbers, so a three-value typo now follows the CSS order.
  assert.deepEqual(parseThickness("1,2,3"), {
    l: 2,
    t: 1,
    r: 2,
    b: 3,
    css: "1px 2px 3px 2px"
  });
  assert.deepEqual(parseThickness("1"), { l: 1, t: 1, r: 1, b: 1, css: "1px 1px 1px 1px" });
  assert.deepEqual(parseThickness("1,2"), { l: 1, t: 2, r: 1, b: 2, css: "2px 1px 2px 1px" });
  assert.deepEqual(parseThickness("1,2,3,4,5"), { l: 1, t: 2, r: 3, b: 4, css: "2px 3px 4px 1px" });
  for (const value of ["1,2,3", "1,2,3,4,5"]) {
    if (/undefined/.test(parseThickness(value).css)) {
      throw new Error(`厚度值 ${value} 产生了 undefined：${parseThickness(value).css}`);
    }
  }
  assert.equal(parseCornerRadius("1,2"), "1px 2px");
  assert.equal(parseFontWeight("semibold"), "600");
  assert.equal(parseFontWeight("750"), "750");
  assert.equal(resolveColor(""), null);
  assert.equal(resolveColor("{StaticResource ColorBrush1}"), "var(--pcl-c1)");
  assert.equal(resolveColor("#80FF0000"), "rgba(255, 0, 0, 0.502)");
});

test("xaml: colour, cursor and font values cannot smuggle CSS", () => {
  // Legitimate WPF colours keep resolving.
  assert.equal(resolveColor("Black"), "Black");
  assert.equal(resolveColor("transparent"), "transparent");
  assert.equal(resolveColor("#D9FFFFFF"), "rgba(255, 255, 255, 0.851)");
  assert.equal(resolveColor("rgba(255, 0, 0, 0.5)"), "rgba(255, 0, 0, 0.5)");
  assert.equal(resolveColor("hsl(210, 85%, 48%)"), "hsl(210, 85%, 48%)");
  assert.equal(resolveColor("{DynamicResource ColorBrush3}"), "var(--pcl-c3)");

  // Everything that would let a remote XAML pull in a resource or end the
  // declaration is refused rather than pasted into the style attribute.
  for (const hostile of [
    "url(https://tracker.invalid/x)",
    "url(#a)",
    "red; background-image: url(https://tracker.invalid/y)",
    "expression(alert(1))",
    "@import url(https://tracker.invalid/z)",
    "red\\",
    "#12",
    "#12345",
    "not-a-colour",
    "var(--anything)"
  ]) {
    assert.equal(resolveColor(hostile), null, `expected ${hostile} to be refused`);
  }
  assert.equal(isSafeCssColor("rgb(1,2,3)"), true);
  assert.equal(isSafeCssColor("url(1)"), false);

  // Cursors: keywords map onto CSS, url() payloads do not.
  assert.equal(resolveCursor("Hand"), "pointer");
  assert.equal(resolveCursor("IBeam"), "ibeam");
  assert.equal(resolveCursor("SizeAll"), "sizeall");
  assert.equal(resolveCursor("url(https://tracker.invalid/c.cur), auto"), null);
  assert.equal(resolveCursor("url(https://tracker.invalid/c.cur), auto; color: red"), null);
  assert.equal(resolveCursor("{DynamicResource X}"), null);
  assert.equal(resolveCursor(""), null);

  // Font families: quotes and escapes are stripped of their power.
  assert.equal(sanitizeFontFamily("微软雅黑"), "微软雅黑");
  assert.equal(sanitizeFontFamily("Ink Free"), "Ink Free");
  assert.equal(sanitizeFontFamily('"Segoe UI", sans-serif'), null);
  assert.equal(sanitizeFontFamily("Arial; background: url(https://tracker.invalid/f)"), null);
  assert.equal(sanitizeFontFamily("Arial\\"), null);
  assert.equal(sanitizeFontFamily("{DynamicResource Font}"), null);
});

test("xaml: null input fails as a PclXamlError", () => {
  assert.ok(new PclXamlError("x") instanceof Error);
});

test("xaml: relative image sources resolve against the document base URL", () => {
  // PCL loads Custom.xaml through XamlReader.Load(Stream), so a relative source
  // is resolved against the stream's base URI — the folder the XAML came from.
  const base = "https://example.com/home/v2/Custom.xaml";
  assert.equal(resolveImageSource("images/a.png", base), "https://example.com/home/v2/images/a.png");
  assert.equal(resolveImageSource("../b.png", base), "https://example.com/home/b.png");
  assert.equal(resolveImageSource("c.png?v=2", base), "https://example.com/home/v2/c.png?v=2");
  assert.equal(resolveImageSource("/root.png", base), "https://example.com/root.png");
  // Absolute and data sources are already resolvable.
  assert.equal(resolveImageSource("https://cdn.example/x.png", base), "https://cdn.example/x.png");
  // PCL's own bundled bitmaps keep winning, whatever the base URL is, so
  // pack:// and `Heads/x.png` references never become remote requests.
  assert.equal(resolveImageSource("Blocks/Grass.png", base), "assets/pcl/images/Blocks/Grass.png");
  assert.equal(
    resolveImageSource("pack://application:,,,/images/Blocks/Grass.png", base),
    "assets/pcl/images/Blocks/Grass.png"
  );
  // Viewer-relative and non-image values stay as they were.
  assert.equal(resolveImageSource("assets/pcl/images/Icons/NoIcon.png", base), "assets/pcl/images/Icons/NoIcon.png");
  assert.equal(resolveImageSource("images/a.png"), null);
  assert.equal(resolveImageSource(""), null);
});

test("renderer: path bounding-box cache is bounded", () => {
  bboxCache.clear();
  for (let index = 0; index <= BBOX_CACHE_LIMIT; index += 1) {
    rememberBBox(`path-${index}`, { x: 0, y: 0, width: index + 1, height: 1 });
  }
  assert.equal(bboxCache.size, BBOX_CACHE_LIMIT);
  assert.equal(bboxCache.has("path-0"), false);
  assert.equal(bboxCache.has(`path-${BBOX_CACHE_LIMIT}`), true);
  bboxCache.clear();
});

test("theme: hue boundary normalization", () => {
  assert.equal(normalizeHue(0), 0);
  assert.equal(normalizeHue(360), 0);
  assert.equal(normalizeHue(390), 30);
  assert.equal(normalizeHue(-30), 330);
  assert.equal(normalizeHue(Number.NaN), 210);
  assert.equal(buildPalette(210).hue, 210);
  assert.equal(buildPalette(0).hue, 0);
  assert.equal(buildPalette(359).hue, 359);
  for (const hue of [0, 30, 210, 359]) {
    const palette = buildPalette(hue);
    for (const key of ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "bg0"]) {
      assert.match(palette[key], /^#[0-9a-f]{6}$/i, `${hue}/${key}`);
    }
  }
});

test("theme: palette matches PCL's runtime FromHSL2 ramp", () => {
  // Values come from Modules/ModSecret.vb: ColorHue 210, ColorSat 85, the
  // Color1–8 lightness ramp and the two gradient definitions.
  const palette = buildPalette(210);
  assert.deepEqual(
    {
      c1: palette.c1,
      c2: palette.c2,
      c3: palette.c3,
      c4: palette.c4,
      c5: palette.c5,
      c6: palette.c6,
      c7: palette.c7,
      c8: palette.c8
    },
    {
      c1: "#333e48",
      c2: "#0f64b8",
      c3: "#127ae1",
      c4: "#3c96ef",
      c5: "#90c3f6",
      c6: "#cde4fb",
      c7: "#e3f0fd",
      c8: "#eef6fe"
    }
  );
  assert.ok(palette.title.includes("#106ac4"), palette.title);
  assert.ok(palette.title.includes("#1277dd"), palette.title);
  assert.ok(palette.page.includes("#caeaf5"), palette.page);
  assert.ok(palette.page.includes("#d3e5f7"), palette.page);
  assert.ok(palette.page.includes("#dbe2f8"), palette.page);
  assert.ok(palette.page.startsWith("linear-gradient(233.67deg"), palette.page);
  assert.ok(
    /^rgba\(227, 240, 253, 0\.74\d?\)$/.test(palette.bg1),
    `ColorBg1 由 Color7 的 190/255 透明度得到：${palette.bg1}`
  );
});

test("help: URL conversion and metadata", () => {
  const urls = resolveHelpUrls("https://mcnews.meloong.com/VersionArchiveList.json");
  assert.equal(urls.jsonUrl, "https://mcnews.meloong.com/VersionArchiveList.json");
  assert.equal(urls.xamlUrl, "https://mcnews.meloong.com/VersionArchiveList.xaml");
  assert.equal(resolveHelpXamlUrl("https://example.com/docs/help"), "https://example.com/docs/help.xaml");
  assert.equal(resolveHelpUrls("file:///tmp/help.json"), null);
  assert.equal(resolveHelpUrls("C:\\tmp\\help.json"), null);
  assert.equal(resolveHelpUrls("javascript:alert(1)"), null);
  assert.equal(helpJsonTitle('{"Title":"  PCL Help  "}'), "PCL Help");
  assert.equal(helpJsonTitle("not json", "fallback"), "fallback");
});

test("url: external protocol whitelist", () => {
  assert.equal(normalizeExternalUrl("https://example.com"), "https://example.com/");
  assert.equal(isOpenableExternalUrl("mailto:test@example.com"), true);
  assert.equal(isOpenableExternalUrl("minecraft://"), true);
  assert.equal(isOpenableExternalUrl("minecraft-preview://"), true);
  assert.equal(isOpenableExternalUrl("minecraft:"), false);
  assert.equal(isOpenableExternalUrl("javascript:alert(1)"), false);
  assert.equal(isOpenableExternalUrl("file:///tmp/a.xaml"), false);
  assert.equal(isOpenableExternalUrl("steam://run/730"), false);
  assert.equal(isMinecraftUrl("minecraft://"), true);
  assert.equal(isMinecraftUrl("https://example.com"), false);
});

test("url: remote homepage addresses are validated before fetching", () => {
  assert.deepEqual(parseRemoteHomeUrl("https://example.com/Custom.xaml"), {
    ok: true,
    url: "https://example.com/Custom.xaml"
  });
  assert.equal(parseRemoteHomeUrl("http://example.com").ok, true);
  assert.equal(parseRemoteHomeUrl("  https://example.com  ").ok, true);

  const reasons = (input) => {
    const result = parseRemoteHomeUrl(input);
    assert.equal(result.ok, false, `${input} 不应通过`);
    return result.reason;
  };
  assert.match(reasons(""), /请填写/);
  assert.match(reasons("   "), /请填写/);
  assert.match(reasons("http://"), /完整的 URL/);
  assert.match(reasons("example.com"), /完整的 URL/);
  assert.match(reasons("ftp://example.com/"), /http/);
  assert.match(reasons("file:///C:/a.xaml"), /http/);
  assert.match(reasons("https://user:pass@example.com/Custom.xaml"), /用户名或密码/);
  assert.match(reasons("https://user@example.com/Custom.xaml"), /用户名或密码/);
  assert.match(reasons("https://example.com:8080/Custom.xaml"), /80 与 443/);
  assert.equal(parseRemoteHomeUrl("https://example.com:443/Custom.xaml").ok, true);
  assert.equal(parseRemoteHomeUrl("http://example.com:80/Custom.xaml").ok, true);
});

test("render errors: a timed-out preset is not reported as broken xaml", () => {
  // fetchRemoteText() replaces the message with a bare timeout notice, so the
  // old `message.includes("无法拉取联网主页")` test could not fire here.
  const timeout = new Error("请求超时（22 秒）。");
  timeout.code = "PRESET_FETCH_FAILED";
  const timedOut = classifyRenderError(timeout, { mode: "preset" });
  assert.equal(timedOut.title, "PCL2 预设加载失败");
  assert.equal(timedOut.detail, "own");
  assert.equal(timedOut.retryable, true);
  assert.equal(renderErrorCaption(timeout, timedOut), "请求超时（22 秒）。");

  const tooLarge = Object.assign(new Error("太大了"), { code: "SOURCE_TOO_LARGE" });
  assert.deepEqual(classifyRenderError(tooLarge, { mode: "preset" }), {
    title: "主页内容过大",
    detail: "own",
    retryable: false
  });

  const badUrl = Object.assign(new Error("主机名缺失"), { code: "REMOTE_URL_INVALID" });
  assert.deepEqual(classifyRenderError(badUrl, { mode: "url" }), {
    title: "网址无效",
    detail: "own",
    retryable: false
  });

  // A shipped preset that 404s is a deployment problem, not broken XAML either.
  const missingAsset = Object.assign(new Error("无法加载预设「控件画廊」：HTTP 404"), {
    code: "PRESET_ASSET_FAILED"
  });
  const asset = classifyRenderError(missingAsset, { mode: "preset" });
  assert.equal(asset.title, "预设文件加载失败");
  assert.equal(asset.detail, "own");
  assert.equal(asset.retryable, true);

  // A homepage URL that never arrived keeps its own heading without a code.
  const urlFailure = classifyRenderError(new Error("无法拉取联网主页：代理请求失败"), { mode: "url" });
  assert.equal(urlFailure.title, "联网主页加载失败");
  assert.equal(urlFailure.detail, "own");

  // Anything else is still a content problem and keeps the PCL preamble.
  const brokenXaml = new Error("XAML 格式有误：第 3 行");
  const xaml = classifyRenderError(brokenXaml, { mode: "code" });
  assert.equal(xaml.title, "加载主页失败");
  assert.equal(xaml.detail, "xaml");
  assert.equal(xaml.retryable, true);
  assert.match(renderErrorCaption(brokenXaml, xaml), /主页内容编写有误/);
});

test("export: writes the current source, not the last render", () => {
  // Editing the code pane without pressing「渲染」must still export the edit.
  const edited = resolveExportSource(
    { mode: "code", code: "第二次编辑" },
    { editorText: "第二次编辑", lastRendered: "第一次渲染", fallback: "<fallback />" }
  );
  assert.equal(edited.content, "第二次编辑");
  assert.equal(edited.dirty, true);
  assert.equal(edited.fileName, "Custom.xaml");

  // After a render the two agree and the hint stays quiet.
  const rendered = resolveExportSource(
    { mode: "code", code: "同一份" },
    { editorText: "同一份", lastRendered: "同一份" }
  );
  assert.equal(rendered.content, "同一份");
  assert.equal(rendered.dirty, false);

  const fromFile = resolveExportSource(
    { mode: "file", fileName: "我的主页.xaml", fileContent: "<A />" },
    { lastRendered: "旧的" }
  );
  assert.deepEqual(fromFile, { content: "<A />", fileName: "我的主页.xaml", dirty: false });

  const fromUrl = resolveExportSource(
    { mode: "url", url: "https://example.com/home/Custom.xaml", urlContent: "<B />" },
    { lastRendered: "旧的" }
  );
  assert.equal(fromUrl.content, "<B />");
  assert.equal(fromUrl.fileName, "Custom.xaml");

  const fromPreset = resolveExportSource(
    { mode: "preset", preset: "pcl2-4" },
    { lastRendered: "<C />", presetTitle: "每日整合包推荐" }
  );
  assert.equal(fromPreset.content, "<C />");
  assert.equal(fromPreset.fileName, "每日整合包推荐.xaml");
});

test("export: file names stay valid on every platform", () => {
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(safeFileName("   "), "Custom.xaml");
  assert.equal(safeFileName("", "备用.xaml"), "备用.xaml");
  assert.equal(safeFileName("标题\n换行"), "标题_换行");
  assert.equal(safeFileName("normal.xaml"), "normal.xaml");

  assert.equal(exportFileName({ mode: "file", fileName: "a:b.xaml" }), "a_b.xaml", "本地文件名也要清洗");
  assert.equal(exportFileName({ mode: "preset" }, ""), "Custom.xaml");
  assert.equal(exportFileName({ mode: "url", url: "https://example.com/a/我的主页.xaml" }), "我的主页.xaml");
  // 目录 URL 与裸主机都要回落到默认文件名。
  assert.equal(exportFileName({ mode: "url", url: "https://example.com/dir/" }), "Custom.xaml");
  assert.equal(exportFileName({ mode: "url", url: "https://example.com" }), "Custom.xaml");
  assert.equal(exportFileName({ mode: "url", url: "不是 URL" }), "Custom.xaml");
});

test("limits: source size rejection", () => {
  assert.equal(MAX_SOURCE_BYTES, 4 * 1024 * 1024);
  assert.equal(formatByteSize(1024), "1.0 KiB");
  assert.equal(formatByteSize(MAX_SOURCE_BYTES), "4.0 MiB");
  assert.throws(
    () => assertSourceWithinLimit("x".repeat(MAX_SOURCE_BYTES + 1), "test"),
    (error) => error.code === "SOURCE_TOO_LARGE"
  );
});

test("limits: the preset cache, help history and event log are bounded", () => {
  // Each cached preset source can be 4 MiB, so the cache must evict by count
  // (LRU) instead of growing for the tab's lifetime.
  const cache = new LruCache(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), 1); // touch a, so b is now the oldest
  cache.set("d", 4);
  assert.equal(cache.size, 3);
  assert.equal(cache.has("b"), false, "最久未使用的条目应先被淘汰");
  assert.equal(cache.has("a") && cache.has("c") && cache.has("d"), true);
  cache.set("c", 30); // re-set moves it to the tail
  cache.set("e", 5);
  assert.equal(cache.has("a"), false, "重新 set 后旧键应改变淘汰顺序");
  assert.equal(cache.get("c"), 30);

  // `has()` must not count as a use, otherwise the "网络" decision in app.js
  // (which calls has() to decide whether to refetch) would keep entries alive.
  const second = new LruCache(2);
  second.set("x", 1);
  second.set("y", 2);
  assert.equal(second.has("x"), true);
  second.set("z", 3);
  assert.equal(second.has("x"), false, "has() 不应刷新 LRU 顺序");

  assert.ok(PRESET_CACHE_LIMIT >= 8 && PRESET_CACHE_LIMIT <= 12, "预取缓存容量应在 8~12");
  assert.equal(HELP_HISTORY_LIMIT, 20);
  assert.equal(EVENT_LOG_LIMIT, 100);
  assert.ok(EVENT_DATA_LIMIT > 0 && EVENT_DATA_LIMIT <= 1000);

  // The three long-lived collections must actually read the shared limits.
  const nav = fs.readFileSync(new URL("../js/shell/navigation.js", import.meta.url), "utf8");
  assert.match(nav, /EVENT_LOG_LIMIT/, "事件日志应使用共享上限");
  assert.match(nav, /EVENT_DATA_LIMIT/, "事件 data 应限长");
  const help = fs.readFileSync(new URL("../js/app/help-navigation.js", import.meta.url), "utf8");
  assert.match(help, /HELP_HISTORY_LIMIT/, "帮助历史应限层数");
  for (const entry of ["../js/app.js", "../js/home.js"]) {
    const app = fs.readFileSync(new URL(entry, import.meta.url), "utf8");
    assert.match(app, /new LruCache\(PRESET_CACHE_LIMIT\)/, `${entry} 的预设缓存应改为 LRU`);
    assert.doesNotMatch(app, /const presetCache = new Map\(\)/, `${entry} 不应再使用无上限 Map`);
  }
});

test("assets: favicon and logo are optimized", () => {
  const icon = fs.readFileSync(new URL("../assets/pcl/images/icon.ico", import.meta.url));
  assert.ok(icon.length < 20_000, `icon.ico is ${icon.length} bytes`);
  const frameCount = icon.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < frameCount; index += 1) {
    const entry = 6 + index * 16;
    sizes.push(icon[entry] || 256);
    assert.equal(icon.readUInt16LE(entry + 6), 32, "favicon frame must be 32bpp");
  }
  assert.deepEqual(sizes, [16, 32, 48]);

  const logo = fs.readFileSync(new URL("../assets/pcl/images/LogoHex.png", import.meta.url));
  assert.ok(logo.length < 15_000, `LogoHex.png is ${logo.length} bytes`);
  assert.equal(logo.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(logo.readUInt32BE(16), 64);
  assert.equal(logo.readUInt32BE(20), 72);
});

test("styles: Firefox scrollbar fallbacks", () => {
  const css = fs.readFileSync(new URL("../css/pcl-theme.css", import.meta.url), "utf8");
  assert.match(css, /\.pcl-scroll\s*\{[^}]*scrollbar-width:\s*thin;[^}]*scrollbar-color:[^;]+;/s);
  assert.match(css, /\.pcl-modal__caption\s*\{[^}]*scrollbar-width:\s*thin;[^}]*scrollbar-color:[^;]+;/s);
});

test("boot: the fallback waits for ready, not just for the module", async () => {
  // js/boot.js must stay a classic script (it runs over file:// where ES modules
  // are blocked), so pull the decision table off the global it installs.
  const vm = await import("node:vm");
  const source = fs.readFileSync(new URL("../js/boot.js", import.meta.url), "utf8");
  const sandbox = {
    window: { setInterval: () => 0, clearInterval: () => {} },
    document: { getElementById: () => null }
  };
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(source, { ...sandbox, ...sandbox.window, window: sandbox.window });
  const bootStatus = sandbox.window.__PCL_BOOT_STATUS__;
  assert.equal(typeof bootStatus, "function", "js/boot.js 应当暴露 __PCL_BOOT_STATUS__");

  const at = (overrides) => bootStatus({ hasApi: false, ready: false, attempts: 1, ...overrides });

  // A parsed-but-not-ready renderer must NOT hide the fallback: __PCL_RENDERER__
  // is assigned at the top of init(), before anything renders.
  assert.equal(at({ hasApi: true, ready: false, attempts: 1 }).state, "waiting");
  assert.equal(at({ hasApi: true, ready: false, attempts: 19 }).state, "waiting");
  assert.equal(at({ hasApi: true, ready: false, attempts: 20 }).state, "timeout");
  assert.equal(at({ hasApi: true, ready: true, attempts: 1 }).state, "ok");
  assert.equal(at({ hasApi: true, ready: true, attempts: 99 }).state, "ok");

  // An init() rejection wins immediately, whatever the poll count.
  const failed = at({ hasApi: true, ready: false, bootError: "数据库不可用", attempts: 1 });
  assert.equal(failed.state, "failed");
  assert.equal(failed.title, "界面初始化失败");

  // Nothing ever registered: the original file:// explanation stays.
  assert.equal(at({ hasApi: false, attempts: 20 }).state, "module");
});

test("boot: index.html still loads boot.js as a classic script", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<script src="js\/boot\.js"><\/script>/, "boot.js 必须保持非 module");
  assert.doesNotMatch(html, /<script[^>]+type="module"[^>]+src="js\/boot\.js"/);
  const app = fs.readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /window\.__PCL_BOOT_ERROR__\s*=/, "init() 失败时要记录原因给 boot.js");
});

test("appearance: the stored theme is restored before the first frame", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  assert.match(head, /<script src="js\/boot-theme\.js"><\/script>/, "<head> must load js/boot-theme.js");

  const bootTheme = fs.readFileSync(new URL("../js/boot-theme.js", import.meta.url), "utf8");
  const appearance = fs.readFileSync(new URL("../js/app/appearance.js", import.meta.url), "utf8");
  const key = (source) => source.match(/"(pcl\.lab\.appearance\.v1)"/)?.[1];
  assert.equal(key(bootTheme), "pcl.lab.appearance.v1");
  assert.equal(key(appearance), key(bootTheme), "both scripts must share the storage key");
  // The head script may only read; the module owns persistence.
  assert.ok(!bootTheme.includes("setItem"), "js/boot-theme.js must not write storage");

  const css = fs.readFileSync(new URL("../css/appearance.css", import.meta.url), "utf8");
  for (const theme of ["light", "dark", "amoled"]) {
    assert.match(css, new RegExp(`data-theme="${theme}"|:root`), `missing ${theme} rules`);
  }
  assert.match(css, /--appearance-dim:\s*0\.9;/);
});

test("appearance: auto follows the system and keeps the preference separate", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /data-appearance="auto"/, "index.html must offer the auto option");
  assert.match(html, /data-appearance="light"/);
  assert.match(html, /data-appearance="dark"/);
  assert.match(html, /data-appearance="amoled"/);

  const appearance = fs.readFileSync(new URL("../js/app/appearance.js", import.meta.url), "utf8");
  // The preference is stored as-is; only the resolved workspace is written to
  // <html>, so a later OS switch still applies while on auto.
  assert.match(appearance, /prefers-color-scheme: dark/);
  assert.match(appearance, /dataset\.appearance\s*=/, "preference must be exposed on <html>");
  assert.match(appearance, /dataset\.theme\s*=/, "resolved workspace must be exposed on <html>");
  assert.match(appearance, /function resolveAppearance\(value\)[\s\S]*?preference !== "auto"/);
  assert.match(appearance, /systemPrefersDark\(\) \? "dark" : "light"/);

  const bootTheme = fs.readFileSync(new URL("../js/boot-theme.js", import.meta.url), "utf8");
  assert.match(bootTheme, /prefers-color-scheme: dark/, "boot script must resolve auto before paint");
  assert.ok(bootTheme.includes('stored === "auto"'), "boot script must accept the auto preference");
});

test("appearance: the switch order matches the keyboard walk order", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const appearance = fs.readFileSync(new URL("../js/app/appearance.js", import.meta.url), "utf8");
  const group = html.match(/<div class="theme-switch"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  const domOrder = [...group.matchAll(/data-appearance="(\w+)"/g)].map((match) => match[1]);
  // Auto is the option most people want, so it leads; arrow keys walk the same
  // list, which only stays predictable if both orders are literally equal.
  assert.deepEqual(domOrder, ["auto", "light", "dark", "amoled"]);
  const declared = appearance.match(/const VARIANTS = \[([^\]]+)\]/)?.[1] ?? "";
  const listOrder = [...declared.matchAll(/"(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(listOrder, domOrder, "VARIANTS must mirror the markup order");
  // A first visit has no stored choice and follows the system, which is also
  // what the head script must do before paint.
  assert.match(appearance, /const DEFAULT_VARIANT = "auto"/);
  assert.match(appearance, /return DEFAULT_VARIANT;/);
  const boot = fs.readFileSync(new URL("../js/boot-theme.js", import.meta.url), "utf8");
  assert.match(boot, /let preference = "auto"/, "boot script must default to following the system");
  const bootDefault = boot.match(/let preference = "(\w+)"/)?.[1];
  const moduleDefault = appearance.match(/const DEFAULT_VARIANT = "(\w+)"/)?.[1];
  assert.equal(moduleDefault, bootDefault, "both entry points must agree on the default");
});

test("proxy core: URL, UA and redirect policy", () => {
  assert.throws(() => parseTarget("javascript:alert(1)"), proxyError(400));
  assert.throws(() => parseTarget("http://localhost/"), proxyError(403));
  assert.throws(() => parseTarget("http://example.com:8080/"), proxyError(403));
  assert.throws(() => parseTarget("https://user:pass@example.com/"), proxyError(403));
  assert.equal(parseTarget("https://example.com/a").toString(), "https://example.com/a");
  assert.equal(parseTarget("http://127.0.0.1:8080/", { allowLocal: true }).port, "8080");
  assert.throws(() => normalizeUserAgent("bad\nua"), proxyError(400));
  assert.throws(() => resolveRedirect(parseTarget("https://example.com/"), "http://localhost/", 302), proxyError(403));
});

test("proxy: the local server shares one deadline and checks the type early", () => {
  // These two are ordering/plumbing facts inside the request handler, so assert
  // them on the source rather than duplicating the handler in a test.
  const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const requestOnce = source.slice(source.indexOf("async function requestOnce"));

  // A redirect must carry the first hop's deadline forward, not restart it.
  assert.match(requestOnce, /deadline = 0/, "requestOnce 应接受绝对 deadline");
  assert.match(requestOnce, /const expiresAt = deadline \|\| Date\.now\(\) \+ TIMEOUT_MS/);
  assert.match(requestOnce, /timeout: Math\.max\(1, expiresAt - Date\.now\(\)\)/, "连接超时应取剩余预算");
  assert.match(
    requestOnce,
    /requestOnce\(next, redirectsLeft - 1, userAgent, imageMode, allowLocal, expiresAt\)/,
    "重定向应传递同一个 expiresAt"
  );

  // The content-type guard has to run before the body is buffered.
  const guardAt = requestOnce.indexOf("!isTextContentType(contentType");
  const bufferAt = requestOnce.indexOf('stream.on("data"');
  assert.ok(guardAt > 0 && bufferAt > 0 && guardAt < bufferAt, "类型校验必须在读取 body 之前");
  assert.match(requestOnce, /response\.resume\(\);\s*reject\(/, "拒绝类型时应丢弃响应体");
  assert.doesNotMatch(requestOnce, /timeout: TIMEOUT_MS,/, "不应再按每跳重新计时");
});

test("proxy core: public address and content-type guards", async () => {
  await assert.rejects(assertPublicTarget(parseTarget("http://127.0.0.1/")), proxyError(403));
  await assert.rejects(assertPublicTarget(parseTarget("http://[::1]/")), proxyError(403));
  await assert.doesNotReject(assertPublicTarget(parseTarget("http://127.0.0.1/"), { allowLocal: true }));
  assert.equal(isTextContentType("application/xml"), true);
  assert.equal(isTextContentType("text/html"), false);
  assert.equal(isTextContentType("application/octet-stream", "https://example.com/a.txt"), true);
  assert.equal(isImageContentType("image/png"), true);
  assert.equal(isImageContentType("text/plain"), false);
});

test("proxy core: the validated address list is what the socket connects to", async () => {
  // resolvePublicAddresses hands back the addresses it cleared so the caller can
  // pin them; a second DNS answer can therefore never reach the socket.
  assert.deepEqual(await resolvePublicAddresses(parseTarget("http://93.184.216.34/")), ["93.184.216.34"]);
  await assert.rejects(resolvePublicAddresses(parseTarget("http://10.0.0.5/")), proxyError(403));

  const lookup = createPinnedLookup(["93.184.216.34"]);
  const single = await new Promise((resolve, reject) =>
    lookup("rebind.example", {}, (error, address, family) => (error ? reject(error) : resolve({ address, family })))
  );
  assert.deepEqual(single, { address: "93.184.216.34", family: 4 });

  // dns.lookup({ all: true }) shape, which node:http asks for on some paths.
  const all = await new Promise((resolve, reject) =>
    lookup("rebind.example", { all: true }, (error, records) => (error ? reject(error) : resolve(records)))
  );
  assert.deepEqual(all, [{ address: "93.184.216.34", family: 4 }]);

  // A family filter that no pinned address satisfies still falls back to one we
  // validated rather than letting the resolver pick something new.
  const ipv6Only = await new Promise((resolve, reject) =>
    lookup("rebind.example", { family: 6 }, (error, address) => (error ? reject(error) : resolve(address)))
  );
  assert.equal(ipv6Only, "93.184.216.34");

  // Normalised IPv4-mapped IPv6 still counts as the same public address.
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedAddress("::ffff:93.184.216.34"), false);
});

test("proxy policy: SVG sandbox headers", () => {
  assert.equal(isSvgResponse("image/svg+xml; charset=utf-8", ""), true);
  assert.equal(isSvgResponse("application/octet-stream", "https://example.com/icon.svg"), true);
  assert.equal(isSvgResponse("image/png", "https://example.com/icon.png"), false);
  const csp = svgResponseHeaders()["Content-Security-Policy"];
  for (const directive of ["default-src 'none'", "script-src 'none'", "sandbox"]) {
    assert.ok(csp.includes(directive), directive);
  }
});

test("Vercel proxy handler: rejects private targets and invalid requests", async () => {
  const invoke = async (method, url, headers = {}) => {
    let body = "";
    const response = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(chunk) {
        body = chunk ? String(chunk) : "";
      }
    };
    await proxyHandler({ method, url, headers: { host: "example.test", ...headers } }, response);
    return { status: response.statusCode, body, headers: response.headers };
  };

  assert.equal((await invoke("POST", "/api/proxy")).status, 405);
  assert.equal((await invoke("GET", "/api/proxy?url=http%3A%2F%2F127.0.0.1%2F")).status, 403);
  assert.equal((await invoke("GET", "/api/proxy?url=http%3A%2F%2Fexample.com%3A8080%2F")).status, 403);
  assert.equal((await invoke("GET", "/api/proxy?url=https%3A%2F%2Fexample.com%2F&ua=bad%0Aua")).status, 400);
});

test("proxy failure: 5xx reasons survive CDNs that rewrite error pages", () => {
  const serverSide = proxyFailure(502, "远程服务器返回 HTTP 404");
  assert.equal(serverSide.status, 200, "5xx must not reach Cloudflare as a 5xx");
  assert.equal(serverSide.body, "远程服务器返回 HTTP 404");
  assert.equal(serverSide.headers[PROXY_STATUS_HEADER], "502");
  assert.equal(serverSide.headers["Cache-Control"], "no-store");

  // 4xx pass through untouched so callers keep using the normal error path.
  const forbidden = proxyFailure(403, "只允许 80 与 443 端口");
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers[PROXY_STATUS_HEADER], "403");

  // Images keep the real status: a 200 text body would decode as a broken image.
  const image = proxyFailure(504, "请求超时（25 秒）", { imageMode: true });
  assert.equal(image.status, 504);
  assert.equal(image.headers[PROXY_STATUS_HEADER], "504");

  // Nonsense statuses fall back to 502 rather than emitting an invalid code.
  assert.equal(proxyFailure(undefined, "x").headers[PROXY_STATUS_HEADER], "502");
  assert.equal(proxyFailure(200, "x").headers[PROXY_STATUS_HEADER], "502");
});

test("Vercel proxy handler: upstream failures are not sent as 5xx", async () => {
  const invoke = async (url) => {
    let body = "";
    const response = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(chunk) {
        body = chunk ? String(chunk) : "";
      }
    };
    await proxyHandler({ method: "GET", url, headers: { host: "example.test" } }, response);
    return { status: response.statusCode, body, headers: response.headers };
  };

  // Force the upstream request to fail without waiting on a real DNS timeout.
  // example.com resolves quickly, so only the fetch itself needs stubbing.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    const failure = await invoke("/api/proxy?url=https%3A%2F%2Fexample.com%2Fx.xaml");
    assert.equal(failure.status, 200, "5xx must not reach a CDN as a 5xx");
    assert.equal(failure.headers[PROXY_STATUS_HEADER.toLowerCase()], "502");
    assert.ok(failure.body.length > 0);

    // Image mode must keep its real status so <img> onerror fires.
    const imageFailure = await invoke("/api/proxy?url=https%3A%2F%2Fexample.com%2Fx.png&image=1");
    assert.equal(imageFailure.status, 502);
  } finally {
    globalThis.fetch = realFetch;
  }

  // 4xx still travel with their own status.
  const blocked = await invoke("/api/proxy?url=https%3A%2F%2Fexample.com%3A8080%2F");
  assert.equal(blocked.status, 403);
});
test("Netlify function: speaks the same proxy contract as the Vercel handler", async () => {
  const call = async (url, init = {}) => {
    const response = await netlifyProxy(new Request(url, init));
    const body = await response.text();
    return { status: response.status, headers: response.headers, body };
  };

  const blocked = await call("https://example.test/api/proxy?url=https%3A%2F%2Fexample.com%3A8080%2F");
  assert.equal(blocked.status, 403);

  const wrongMethod = await call("https://example.test/api/proxy?url=https%3A%2F%2Fexample.com%2F", {
    method: "POST"
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");

  const realFetch = globalThis.fetch;
  try {
    // An IP literal keeps assertPublicTarget offline-safe while still exercising
    // the full read/validate path.
    globalThis.fetch = async () =>
      new Response("<PCLRoot><local:MyCard /></PCLRoot>", {
        status: 200,
        headers: { "content-type": "application/xml" }
      });
    const ok = await call("https://example.test/api/proxy?url=https%3A%2F%2F93.184.216.34%2Fx.xaml");
    assert.equal(ok.status, 200);
    assert.match(ok.body, /MyCard/);
    assert.equal(ok.headers.get("x-pcl-proxy"), "netlify");
    assert.equal(ok.headers.get("content-type"), "text/plain; charset=utf-8");

    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const failure = await call("https://example.test/api/proxy?url=https%3A%2F%2F93.184.216.34%2Fx.xaml");
    assert.equal(failure.status, 200, "5xx must not reach a CDN as a 5xx");
    assert.equal(failure.headers.get("x-pcl-proxy-status"), "502");
    assert.equal(failure.headers.get("x-pcl-proxy"), "netlify");

    const imageFailure = await call("https://example.test/api/proxy?url=https%3A%2F%2F93.184.216.34%2Fx.png&image=1");
    assert.equal(imageFailure.status, 502, "image mode keeps its real status");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Netlify function: also accepts the Lambda-style event used by Functions 1.0", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("<PCLRoot><local:MyCard /></PCLRoot>", {
        status: 200,
        headers: { "content-type": "application/xml" }
      });

    // rawQuery is the only place the query string survives in a v1 event.
    const byRawQuery = await netlifyProxy({
      httpMethod: "GET",
      path: "/.netlify/functions/proxy",
      rawQuery: "url=https%3A%2F%2F93.184.216.34%2Fx.xaml",
      headers: { host: "example.test" }
    });
    assert.equal(byRawQuery.statusCode, 200);
    assert.match(byRawQuery.body, /MyCard/);
    assert.equal(byRawQuery.isBase64Encoded, false);
    assert.equal(byRawQuery.headers["x-pcl-proxy"], "netlify");

    const byMultiValue = await netlifyProxy({
      httpMethod: "GET",
      path: "/api/proxy",
      multiValueQueryStringParameters: { url: ["https://93.184.216.34/x.xaml"] },
      headers: { host: "example.test" }
    });
    assert.equal(byMultiValue.statusCode, 200);
    assert.match(byMultiValue.body, /MyCard/);

    const blocked = await netlifyProxy({
      httpMethod: "GET",
      path: "/api/proxy",
      rawQuery: `url=${encodeURIComponent("http://example.com:8080/x")}`,
      headers: {}
    });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.headers["x-pcl-proxy-status"], "403");
    assert.equal(blocked.body, "只允许 80 与 443 端口");

    // Binary replies have to be base64-encoded for the Lambda contract.
    globalThis.fetch = async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    const image = await netlifyProxy({
      httpMethod: "GET",
      path: "/api/proxy",
      rawQuery: `url=${encodeURIComponent("https://93.184.216.34/x.png")}&image=1`,
      headers: { host: "example.test" }
    });
    assert.equal(image.statusCode, 200);
    assert.equal(image.isBase64Encoded, true);
    assert.deepEqual([...Buffer.from(image.body, "base64")], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Netlify config: routes /api/proxy to the function bundle", () => {
  const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.match(toml, /^\[functions\]$/m, "netlify.toml must declare [functions]");
  assert.match(toml, /^\s*directory\s*=\s*"netlify\/functions"$/m);
  assert.match(toml, /^\s*node_bundler\s*=\s*"esbuild"$/m);
  // A rewrite (200 + force) keeps the /api/proxy URL the viewer already uses.
  assert.match(
    toml,
    /\[\[redirects\]\][\s\S]*?from\s*=\s*"\/api\/proxy"[\s\S]*?to\s*=\s*"\/\.netlify\/functions\/proxy"[\s\S]*?status\s*=\s*200[\s\S]*?force\s*=\s*true/
  );

  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(!readme.includes("Netlify 不包含"), "README still claims Netlify ships no proxy");
  assert.match(readme, /netlify\/functions\/proxy\.mjs/);

  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(
    !html.includes("GitHub Pages、Netlify 等纯静态部署没有代理"),
    "index.html still claims Netlify has no proxy"
  );
});

test("Static build: ships home.html and stamps its bundle urls", () => {
  const build = fs.readFileSync(new URL("./build-static.mjs", import.meta.url), "utf8");
  const entries = build.match(/const ENTRIES = \[([^\]]*)\]/);
  assert.ok(entries, "build-static.mjs must declare ENTRIES");
  assert.match(entries[1], /"home\.html"/, "home.html must be copied into dist");
  assert.match(build, /addCacheVersion\("home\.html"\)/, "home.html needs the build stamp too");

  // A CSP that only covers / and /index.html would be ignored by the other
  // document, so index.html's own meta tag is the shared reference. Meta tags
  // cannot express frame-ancestors, the one directive only the header carries.
  const meta = fs
    .readFileSync(new URL("../index.html", import.meta.url), "utf8")
    .match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(meta, "index.html must declare a CSP meta tag");
  const headers = fs.readFileSync(new URL("../api/security-headers.js", import.meta.url), "utf8");
  const serverCsp = headers.match(/const DOCUMENT_CSP = \[([\s\S]*?)\]\.join\("; "\)/);
  assert.ok(serverCsp, "security-headers.js must build DOCUMENT_CSP from a list");
  const directives = [...serverCsp[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).join("; ");
  assert.equal(
    meta[1],
    directives.replace("frame-ancestors 'none'; ", ""),
    "index.html CSP meta must match the header"
  );

  const home = fs.readFileSync(new URL("../home.html", import.meta.url), "utf8");
  assert.equal(
    home.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1],
    meta[1],
    "home.html CSP meta must match the server's document policy"
  );

  const vercel = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const homeRule = vercel.headers.find((entry) => entry.source === "/home.html");
  assert.ok(homeRule, "vercel.json must send the document CSP for /home.html");
  assert.equal(
    homeRule.headers.find((header) => header.key === "Content-Security-Policy")?.value,
    directives,
    "vercel.json /home.html CSP must match the shared policy"
  );

  const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.match(toml, /\[\[headers\]\]\s*\n\s*for = "\/home\.html"/, "netlify.toml must cover /home.html");
});
