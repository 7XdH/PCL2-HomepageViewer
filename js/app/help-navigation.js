import { resolveHelpUrls, helpJsonTitle, helpTitleFromXaml } from "../help.js";
import { getProxyUaCandidates, PCL_FALLBACK_UA } from "../ua.js";
import { HELP_HISTORY_LIMIT } from "../limits.js";

export function createHelpNavigation({
  shell,
  helpRenderer,
  helpRoot,
  helpScroll,
  resolveRemoteUrl,
  fetchRemoteText,
  fetchRemoteXaml
}) {
  let helpToken = 0;
  let helpAbort = null;
  let helpHistory = [];
  let helpReturnFocus = null;

  function renderHelpEntry(entry) {
    if (!entry) return;
    // Help pages are fetched from the networks, so their relative images resolve
    // against the page they came from — same rule as the homepage.
    helpRenderer.render(entry.xaml, { baseUrl: entry.baseUrl || "" });
    shell.showHelpPage(entry.title);
    if (helpScroll) helpScroll.scrollTop = 0;
    window.setTimeout(() => document.getElementById("pclSubpageBack")?.focus({ preventScroll: true }), 30);
  }

  async function openRemoteHelp(raw) {
    const address = resolveRemoteUrl(String(raw ?? "").trim());
    const urls = resolveHelpUrls(address);
    if (!urls) {
      throw new Error(`这个帮助地址不是可用的 PCL 远程帮助 JSON / XAML 页面。\n\n${address || "（空）"}`);
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
        .then((source) => helpJsonTitle(source, ""))
        .catch(() => "");
      const helpInfo = {};
      const [xaml, metadataTitle] = await Promise.all([
        fetchRemoteXaml(urls.xamlUrl, {
          uaCandidates,
          label: "帮助页面",
          signal: controller.signal,
          onFinalUrl: (value) => {
            helpInfo.baseUrl = value || urls.xamlUrl;
          }
        }),
        metadata
      ]);
      if (token !== helpToken) return "cancelled";

      const entry = {
        url: urls.xamlUrl,
        baseUrl: helpInfo.baseUrl || urls.xamlUrl,
        title: metadataTitle || helpTitleFromXaml(xaml),
        xaml
      };
      helpHistory.push(entry);
      // Each entry keeps a whole rendered document. Drop the oldest instead of
      // growing for the lifetime of the tab; Back still walks what is left.
      if (helpHistory.length > HELP_HISTORY_LIMIT) {
        helpHistory.splice(0, helpHistory.length - HELP_HISTORY_LIMIT);
      }
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
    helpRoot?.replaceChildren();
  }

  function closeHelp() {
    const focusTarget = helpReturnFocus;
    helpReturnFocus = null;
    resetHelpState();
    shell.closeHelpPage();
    shell.setLoading(false, "");
    focusTarget?.focus?.({ preventScroll: true });
  }

  return { openRemoteHelp, goBackHelp, resetHelpState, closeHelp };
}
