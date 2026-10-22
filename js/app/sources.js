import { substitutePlaceholders } from "../xaml.js";
import { getProxyUaCandidates, PCL_FALLBACK_UA } from "../ua.js";
import { MAX_SOURCE_BYTES, assertSourceWithinLimit, sourceLimitError } from "../limits.js";
import { assertRemoteResponse, fetchDirect, fetchViaProxy, readResponseTextLimited } from "./remote.js";

export function createSourceLoader({ state, PRESETS, presetCache, FALLBACK_XAML, getCode, getRuntimeContext }) {
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

  async function readFileAsXaml(file) {
    const label = `文件“${file.name || "Custom.xaml"}”`;
    if (file.size > MAX_SOURCE_BYTES) throw sourceLimitError(file.size, label);
    const text = await file.text();
    return assertSourceWithinLimit(text.replace(/^\uFEFF/, ""), label);
  }

  async function fetchRemoteText(
    url,
    { uaCandidates = getProxyUaCandidates(state.ua), expect = "xaml", label = "联网主页", signal } = {}
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
        throw new Error(`无法拉取${label}：${proxyError.message}\n\n` + "请确认地址有效，或检查代理设置是否可用。");
      }

      let directContent;
      try {
        directContent = await fetchDirect(url, controller.signal, label);
      } catch (error) {
        if (error.name === "AbortError") throw error;
        const proxyMissing =
          !proxyError || proxyError.status === 404 || proxyError.status === 405 || proxyError.code === "PROXY_HTML";
        const proxyHint = proxyError
          ? proxyMissing
            ? `未找到可用的 /api/proxy（${proxyError.message}）。当前部署可能是纯静态站点。`
            : `代理请求失败（${proxyError.message}）。`
          : "未找到可用的 /api/proxy。";
        throw new Error(
          `无法拉取${label}：${error.message}\n\n` +
            proxyHint +
            "\n" +
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
    return substitutePlaceholders(url, getRuntimeContext(), { escape: false });
  }

  async function resolveCurrentContent({ forceRemote = false, signal } = {}) {
    if (state.mode === "file") {
      if (!state.fileContent.trim()) throw new Error("尚未选择本地 XAML 文件。");
      return state.fileContent;
    }
    if (state.mode === "code") {
      const code = getCode();
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

  return {
    loadPreset,
    readFileAsXaml,
    fetchRemoteText,
    fetchRemoteXaml,
    resolveRemoteUrl,
    resolveCurrentContent,
    sourceLabel
  };
}
