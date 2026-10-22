import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  PclXamlError,
  escapeXml,
  resolveColor,
  parseDouble,
  parseBool,
  parseThickness,
  parseCornerRadius,
  parseFontWeight,
  substitutePlaceholders
} from "../js/xaml.js";
import { buildPalette, normalizeHue } from "../js/theme.js";
import { BBOX_CACHE_LIMIT, bboxCache, rememberBBox } from "../js/renderer/helpers.js";
import { helpJsonTitle, resolveHelpUrls, resolveHelpXamlUrl } from "../js/help.js";
import { isOpenableExternalUrl, isMinecraftUrl, normalizeExternalUrl } from "../js/url.js";
import { MAX_SOURCE_BYTES, assertSourceWithinLimit, formatByteSize } from "../js/limits.js";
import {
  ProxyError,
  assertPublicTarget,
  isImageContentType,
  isTextContentType,
  normalizeUserAgent,
  parseTarget,
  resolveRedirect
} from "../api/proxy-core.js";
import { isSvgResponse, svgResponseHeaders } from "../api/proxy-policy.js";
import proxyHandler from "../api/proxy.js";

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
  assert.equal(parseCornerRadius("1,2"), "1px 2px");
  assert.equal(parseFontWeight("semibold"), "600");
  assert.equal(parseFontWeight("750"), "750");
  assert.equal(resolveColor(""), null);
  assert.equal(resolveColor("{StaticResource ColorBrush1}"), "var(--pcl-c1)");
  assert.equal(resolveColor("#80FF0000"), "rgba(255, 0, 0, 0.502)");
});

test("xaml: null input fails as a PclXamlError", () => {
  assert.ok(new PclXamlError("x") instanceof Error);
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

test("limits: source size rejection", () => {
  assert.equal(MAX_SOURCE_BYTES, 4 * 1024 * 1024);
  assert.equal(formatByteSize(1024), "1.0 KiB");
  assert.equal(formatByteSize(MAX_SOURCE_BYTES), "4.0 MiB");
  assert.throws(
    () => assertSourceWithinLimit("x".repeat(MAX_SOURCE_BYTES + 1), "test"),
    (error) => error.code === "SOURCE_TOO_LARGE"
  );
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
