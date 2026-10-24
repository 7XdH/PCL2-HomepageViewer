import { isMinecraftUrl, normalizeExternalUrl } from "../url.js";
import {
  VERSIONS,
  ACCOUNTS,
  COMMIT_REFRESH_MS,
  COMMIT_TIMEOUT_MS,
  COMMIT_SOURCE_LABELS,
  COMMIT_ERROR_TITLE,
  formatRelativeTime,
  fetchLatestCommit,
  showRuntimeHint,
  readShellPreferences,
  saveShellPreferences
} from "./helpers.js";

export class PclShellBase {
  constructor({ onLaunch, onAccountChange, onVersionChange } = {}) {
    this.onLaunch = onLaunch;
    this.onAccountChange = onAccountChange;
    this.onVersionChange = onVersionChange;
    const preferences = readShellPreferences();
    this.version = preferences.version;
    this.account = ACCOUNTS[preferences.account] || ACCOUNTS.Steve;
    this.events = [];
    this.modalChain = Promise.resolve();
    this.modalInert = new Map();
    this.currentPage = "Launch";
    this.tooltipTimer = 0;
    this.tooltipTarget = null;
    this.tooltipAnchor = null;
    this.lastPointer = { x: 0, y: 0 };

    this.windowEl = document.getElementById("pclWindow");
    this.scaler = document.getElementById("pclScaler");
    this.titlebar = document.getElementById("pclTitlebar");
    this.nav = document.getElementById("pclNav");
    this.sidebar = document.getElementById("pclSidebar");
    this.avatarButton = document.getElementById("pclAvatarBtn");
    this.accountButton = document.getElementById("pclAccountBtn");
    this.profileName = document.getElementById("pclProfileName");
    this.homePage = document.getElementById("pclHomePage");
    this.stubPage = document.getElementById("pclStubPage");
    this.stubTitle = document.getElementById("pclStubTitle");
    this.helpPage = document.getElementById("pclHelpPage");
    this.titlebarSub = document.getElementById("pclTitlebarSub");
    this.subpageTitle = document.getElementById("pclSubpageTitle");
    this.subpageOpen = false;
    this.subpageBasePage = "Launch";
    this.hintStack = document.getElementById("pclHintStack");
    this.modalLayer = document.getElementById("pclModalLayer");
    this.modalTitle = document.getElementById("pclModalTitle");
    this.modalCaption = document.getElementById("pclModalCaption");
    this.modalButtons = document.getElementById("pclModalButtons");
    this.loadingLayer = document.getElementById("pclLoadingLayer");
    this.loadingText = document.getElementById("pclLoadingText");
    this.versionName = document.getElementById("pclVersionName");
    this.launchVersion = document.getElementById("pclLaunchVersion");
    this.eventText = document.getElementById("eventText");
    this.eventCount = document.getElementById("eventCount");
    this.stageEmpty = document.getElementById("stageEmpty");
    this.tooltip = document.getElementById("pclTooltip");
    this.launchMeta = document.getElementById("pclLaunchMeta");
    this.latestCommit = null;
    this.commitAbort = null;

    this.bindWindowControls();
    this.bindAccountSwitcher();
    this.bindTooltips();
    this.setVersion(this.version);
    this.loadLatestCommit();
    window.setInterval(() => this.loadLatestCommit({ silent: true }), COMMIT_REFRESH_MS);
    window.setInterval(() => this.renderCommitMeta(), 60_000);
  }

  showHint(text, type = "Blue") {
    // Everything about the bar itself lives in helpers.js so the standalone
    // homepage page (js/home.js) raises byte-identical hints.
    return showRuntimeHint(this.hintStack, text, type);
  }

  setBackgroundInert(active) {
    if (!this.modalLayer) return;
    if (active) {
      if (this.modalInert.size) return;
      let node = this.modalLayer;
      while (node && node !== document.body && node.parentElement) {
        const parent = node.parentElement;
        for (const sibling of parent.children) {
          if (sibling === node || sibling.contains(this.modalLayer)) continue;
          this.modalInert.set(sibling, sibling.inert);
          sibling.inert = true;
        }
        node = parent;
      }
      return;
    }

    for (const [element, previous] of this.modalInert) {
      element.inert = previous;
    }
    this.modalInert.clear();
  }

  showModal(options) {
    const run = () => this.openModal(options);
    this.modalChain = this.modalChain.then(run, run);
    return this.modalChain;
  }

  openModal({ title = "提示", caption = "", buttons = ["确定"], warn = false, activeIndex = 0 } = {}) {
    const buttonList = (Array.isArray(buttons) ? buttons : [buttons]).map((button) =>
      typeof button === "string" ? { label: button } : button
    );
    if (!buttonList.length) buttonList.push({ label: "确定" });
    const highlightIndex =
      Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < buttonList.length ? activeIndex : 0;

    const previousFocus = document.activeElement;
    this.modalTitle.textContent = title;
    this.modalCaption.textContent = String(caption ?? "");
    this.modalButtons.replaceChildren();
    this.modalLayer.classList.toggle("is-warn", Boolean(warn));
    this.modalLayer.classList.remove("is-leaving");
    this.modalLayer.hidden = false;
    this.setBackgroundInert(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (index) => {
        if (settled) return;
        settled = true;
        this.modalLayer.classList.add("is-leaving");
        this.modalLayer.querySelector(".pcl-modal")?.classList.add("is-leaving");
        document.removeEventListener("keydown", onKeyDown);
        window.setTimeout(() => {
          this.modalLayer.hidden = true;
          this.modalLayer.classList.remove("is-leaving", "is-warn");
          this.modalLayer.querySelector(".pcl-modal")?.classList.remove("is-leaving");
          this.setBackgroundInert(false);
          previousFocus?.focus?.({ preventScroll: true });
          resolve(index);
        }, 170);
      };

      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(buttonList.length > 1 ? buttonList.length - 1 : 0);
        } else if (event.key === "Tab") {
          const focusable = Array.from(
            this.modalLayer.querySelectorAll(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          ).filter((element) => !element.inert && element.getClientRects().length > 0);
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!this.modalLayer.contains(document.activeElement)) {
            event.preventDefault();
            first.focus();
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      };

      buttonList.forEach((button, index) => {
        const node = document.createElement("button");
        node.type = "button";
        node.className = "pcl-modal__button";
        if (buttonList.length > 1 && index === highlightIndex) {
          node.classList.add("pcl-modal__button--highlight");
          node.setAttribute("aria-current", "true");
        }
        if (warn && index === 0) node.classList.add("pcl-modal__button--red");
        node.textContent = button.label ?? "确定";
        node.addEventListener("click", () => finish(index));
        this.modalButtons.append(node);
      });

      document.addEventListener("keydown", onKeyDown);
      window.setTimeout(() => {
        const activeButton = this.modalButtons.children[highlightIndex] || this.modalButtons.querySelector("button");
        activeButton?.focus();
      }, 40);
    });
  }

  setLoading(visible, text = "正在加载主页…") {
    this.loadingText.textContent = text;
    this.loadingLayer.hidden = !visible;
  }

  async loadLatestCommit({ silent = false } = {}) {
    if (!this.launchMeta) return;
    if (document.visibilityState === "hidden" && silent) return;

    this.commitAbort?.abort();
    const controller = new AbortController();
    this.commitAbort = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, COMMIT_TIMEOUT_MS);

    if (!this.latestCommit && !silent) {
      this.launchMeta.textContent = "最近提交：正在获取…";
      this.launchMeta.title = "正在获取最近提交…";
    }

    try {
      const commit = await fetchLatestCommit(controller.signal);
      if (this.commitAbort !== controller) return;
      if (commit) {
        this.latestCommit = commit;
        this.renderCommitMeta();
      } else if (!this.latestCommit) {
        this.launchMeta.textContent = "最近提交：获取失败";
        this.launchMeta.title = COMMIT_ERROR_TITLE;
      }
    } catch {
      if (this.commitAbort !== controller) return;
      if (!this.latestCommit) {
        this.launchMeta.textContent = timedOut ? "最近提交：获取超时" : "最近提交：获取失败";
        this.launchMeta.title = timedOut ? "获取最近提交超时，请稍后刷新重试。" : COMMIT_ERROR_TITLE;
      }
    } finally {
      window.clearTimeout(timeout);
      if (this.commitAbort === controller) this.commitAbort = null;
    }
  }

  renderCommitMeta() {
    if (!this.launchMeta || !this.latestCommit) return;
    const relative = formatRelativeTime(this.latestCommit.date);
    const shortSha = this.latestCommit.sha.slice(0, 7);
    this.launchMeta.textContent = `最近提交：${relative}${shortSha ? ` · ${shortSha}` : ""}`;
    const full = this.latestCommit.date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    const source = COMMIT_SOURCE_LABELS[this.latestCommit.source] || COMMIT_SOURCE_LABELS.build;
    this.launchMeta.title = `${source}：${full}${shortSha ? ` · ${shortSha}` : ""}`;
  }

  getVersion() {
    return this.version;
  }

  getVersionInfo() {
    return VERSIONS.find((version) => version.name === this.version) || VERSIONS[0];
  }

  setVersion(name) {
    const version =
      VERSIONS.find((item) => item.name === name) || VERSIONS.find((item) => item.name === this.version) || VERSIONS[0];
    const changed = version.name !== this.version;
    this.version = version.name;
    if (this.versionName) this.versionName.textContent = version.name;
    if (this.launchVersion) this.launchVersion.textContent = version.name;
    const meta = this.versionName?.parentElement?.querySelector(".pcl-version-card__meta");
    if (meta) meta.textContent = version.meta;
    saveShellPreferences({ version: this.version, account: this.account.name });
    // PCL's version picker is its own page, and coming back re-parents
    // PageLaunchRight, which fires Loaded again and re-runs RefreshReal with the
    // cached content. Placeholders such as {version} are expanded at load time,
    // so that round trip is what makes them reflect the new instance. Report the
    // change here and let the caller replay the cached source.
    if (changed) this.onVersionChange?.({ name: this.version, meta: version.meta });
  }

  openUrl(url) {
    const target = normalizeExternalUrl(url);
    if (!target) return false;
    if (isMinecraftUrl(target)) {
      // Custom protocols are handled by the OS. An anchor click is less likely
      // to be blocked than window.open() when the launcher is registered.
      const link = document.createElement("a");
      link.href = target;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.append(link);
      link.click();
      link.remove();
      return true;
    }
    let win;
    try {
      win = window.open(target, "_blank");
    } catch {
      return false;
    }
    if (!win) return false;
    try {
      win.opener = null;
    } catch {
      /* cross-origin windows can reject the opener assignment */
    }
    return true;
  }

  async copyText(text) {
    const value = String(text ?? "");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const area = document.createElement("textarea");
      area.value = value;
      area.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
      document.body.append(area);
      area.focus();
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  download(url, fileName) {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName || "";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.append(link);
    link.click();
    link.remove();
  }

  pickFile(accept = "") {
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
  }
}
