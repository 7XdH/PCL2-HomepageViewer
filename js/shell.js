import { normalizeExternalUrl } from "./url.js?v=20261021q";

const PAGE_LABELS = {
  Launch: "启动",
  Download: "下载",
  Link: "联机",
  Setup: "设置",
  Other: "更多",
  Instance: "版本设置",
  InstanceSetup: "版本设置",
  Select: "版本选择",
  Speed: "下载",
  TaskManager: "任务管理",
  Resource: "资源下载",
  Help: "帮助",
  About: "关于"
};

const NAV_FOR_PAGE = {
  Launch: "Launch",
  Instance: "Launch",
  InstanceSetup: "Launch",
  Select: "Launch",
  Download: "Download",
  Speed: "Download",
  Link: "Link",
  Setup: "Setup",
  Other: "Other",
  Help: "Other",
  About: "Other",
  TaskManager: "Other"
};

const VERSIONS = [
  { name: "1.20.1-Fabric", meta: "Fabric 0.15.11 · 今天 14:32" },
  { name: "1.19.2-Forge", meta: "Forge 43.3.0 · 3 天前" },
  { name: "1.21.4-Vanilla", meta: "原版 1.21.4 · 上周" }
];

const ACCOUNTS = {
  Steve: {
    name: "Steve",
    uuid: "8667ba71-b85a-4004-af54-457a9734eed7",
    login: "离线",
    skin: "Steve"
  },
  Alex: {
    name: "Alex",
    uuid: "ec561538-f3fd-461d-aff5-086b22154bce",
    login: "离线",
    skin: "Alex"
  }
};

const COMMIT_REFRESH_MS = 10 * 60 * 1000;
const COMMIT_TIMEOUT_MS = 8000;
const COMMIT_SOURCE_LABELS = {
  build: "构建时记录的提交",
  local: "本地最近提交"
};
const COMMIT_ERROR_TITLE = "无法读取最近提交信息。请确认 npm run build 已生成 commit.json，或使用 node server.js 本地运行。";

const formatRelativeTime = date => {
  const diff = Math.max(0, Date.now() - date.getTime());
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
};

const normalizeCommit = (data, source) => {
  const commit = data?.commit || data;
  const rawDate = data?.date || commit?.committer?.date || commit?.author?.date;
  const date = rawDate ? new Date(rawDate) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return {
    date,
    sha: data?.sha || commit?.sha || "",
    source: data?.source || source
  };
};

const fetchLatestCommit = async signal => {
  const cacheBust = Date.now();
  const isLocalHost = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const endpoints = [
    { url: `commit.json?t=${cacheBust}`, source: "build" },
    ...(isLocalHost ? [{ url: `api/latest-commit?t=${cacheBust}`, source: "local" }] : [])
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        signal,
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) continue;
      const data = await response.json();
      const item = Array.isArray(data) ? data[0] : data;
      const commit = normalizeCommit(item, endpoint.source);
      if (commit) return commit;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
    }
  }
  return null;
};

const hintColors = {
  Blue: ["rgba(37, 155, 252, 0.843)", "rgba(10, 142, 252, 0.843)"],
  Green: ["rgba(33, 177, 33, 0.843)", "rgba(29, 160, 29, 0.843)"],
  Red: ["rgba(255, 53, 11, 0.843)", "rgba(255, 43, 0, 0.843)"],
  Yellow: ["rgba(245, 122, 0, 0.843)", "rgba(216, 108, 0, 0.843)"]
};

const timeString = date => {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString("zh-CN", { hour12: false });
};

export class PclShell {
  constructor({ onLaunch, onAccountChange } = {}) {
    this.onLaunch = onLaunch;
    this.onAccountChange = onAccountChange;
    this.version = VERSIONS[0].name;
    this.account = ACCOUNTS.Steve;
    this.events = [];
    this.modalChain = Promise.resolve();
    this.currentPage = "Launch";
    this.tooltipTimer = 0;
    this.tooltipTarget = null;
    this.lastPointer = { x: 0, y: 0 };

    this.windowEl = document.getElementById("pclWindow");
    this.scaler = document.getElementById("pclScaler");
    this.titlebar = document.getElementById("pclTitlebar");
    this.nav = document.getElementById("pclNav");
    this.sidebar = document.getElementById("pclSidebar");
    this.avatarButton = document.getElementById("pclAvatarBtn");
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
    this.loadLatestCommit();
    window.setInterval(() => this.loadLatestCommit({ silent: true }), COMMIT_REFRESH_MS);
    window.setInterval(() => this.renderCommitMeta(), 60_000);
  }

  showHint(text, type = "Blue") {
    const message = String(text ?? "").replace(/\r?\n/g, " ").trim();
    if (!message) return;
    const normalized = String(type || "Blue").toLowerCase();
    const key = Object.keys(hintColors).find(name => name.toLowerCase() === normalized) || "Blue";
    const colors = hintColors[key];

    const duplicate = Array.from(this.hintStack.children).find(child => child.dataset.text === message);
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
    this.hintStack.append(node);

    while (this.hintStack.children.length > 20) this.hintStack.firstElementChild?.remove();

    const lifespan = 800 + Math.min(23, Math.max(5, message.length)) * 180;
    window.setTimeout(() => {
      node.classList.add("is-leaving");
      window.setTimeout(() => node.remove(), 230);
    }, lifespan);
  }

  showModal(options) {
    const run = () => this.openModal(options);
    this.modalChain = this.modalChain.then(run, run);
    return this.modalChain;
  }

  openModal({ title = "提示", caption = "", buttons = ["确定"], warn = false, activeIndex = 0 } = {}) {
    const buttonList = (Array.isArray(buttons) ? buttons : [buttons]).map(button =>
      typeof button === "string" ? { label: button } : button
    );
    if (!buttonList.length) buttonList.push({ label: "确定" });
    const highlightIndex =
      Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < buttonList.length
        ? activeIndex
        : 0;

    const previousFocus = document.activeElement;
    this.modalTitle.textContent = title;
    this.modalCaption.textContent = String(caption ?? "");
    this.modalButtons.replaceChildren();
    this.modalLayer.classList.toggle("is-warn", Boolean(warn));
    this.modalLayer.classList.remove("is-leaving");
    this.modalLayer.hidden = false;

    return new Promise(resolve => {
      let settled = false;
      const finish = index => {
        if (settled) return;
        settled = true;
        this.modalLayer.classList.add("is-leaving");
        this.modalLayer.querySelector(".pcl-modal")?.classList.add("is-leaving");
        document.removeEventListener("keydown", onKeyDown);
        window.setTimeout(() => {
          this.modalLayer.hidden = true;
          this.modalLayer.classList.remove("is-leaving", "is-warn");
          this.modalLayer.querySelector(".pcl-modal")?.classList.remove("is-leaving");
          previousFocus?.focus?.({ preventScroll: true });
          resolve(index);
        }, 170);
      };

      const onKeyDown = event => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(buttonList.length > 1 ? buttonList.length - 1 : 0);
        } else if (event.key === "Tab") {
          const focusable = Array.from(this.modalButtons.querySelectorAll("button"));
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
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
        const activeButton =
          this.modalButtons.children[highlightIndex] || this.modalButtons.querySelector("button");
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
    const timeout = window.setTimeout(() => controller.abort(), COMMIT_TIMEOUT_MS);

    if (!this.latestCommit && !silent) {
      this.launchMeta.textContent = "最近提交：正在获取…";
      this.launchMeta.title = "正在获取最近提交…";
    }

    try {
      const commit = await fetchLatestCommit(controller.signal);
      if (commit) {
        this.latestCommit = commit;
        this.renderCommitMeta();
      } else if (!this.latestCommit) {
        this.launchMeta.textContent = "最近提交：获取失败";
        this.launchMeta.title = COMMIT_ERROR_TITLE;
      }
    } catch (error) {
      if (!this.latestCommit) {
        const timeoutFailure = error?.name === "AbortError";
        this.launchMeta.textContent = timeoutFailure ? "最近提交：获取超时" : "最近提交：获取失败";
        this.launchMeta.title = timeoutFailure
          ? "获取最近提交超时，请稍后刷新重试。"
          : COMMIT_ERROR_TITLE;
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
    return VERSIONS.find(version => version.name === this.version) || VERSIONS[0];
  }

  setVersion(name) {
    const version = VERSIONS.find(item => item.name === name) || VERSIONS.find(item => item.name === this.version) || VERSIONS[0];
    this.version = version.name;
    if (this.versionName) this.versionName.textContent = version.name;
    if (this.launchVersion) this.launchVersion.textContent = version.name;
    const meta = this.versionName?.parentElement?.querySelector(".pcl-version-card__meta");
    if (meta) meta.textContent = version.meta;
  }

  openUrl(url) {
    const target = normalizeExternalUrl(url);
    if (!target) return false;
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
    return new Promise(resolve => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
      let settled = false;
      const finish = file => {
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


  bindWindowControls() {
    document.getElementById("winMinBtn")?.addEventListener("click", event => {
      event.stopPropagation();
      this.toggleMinimized();
    });
    document.getElementById("winCloseBtn")?.addEventListener("click", event => {
      event.stopPropagation();
      this.closeWindow();
    });
    document.getElementById("reopenBtn")?.addEventListener("click", () => this.reopenWindow());
    document.getElementById("pclStubBack")?.addEventListener("click", () => this.switchPage("Launch"));
    document.getElementById("pclSubpageBack")?.addEventListener("click", event => {
      event.stopPropagation();
      this.onSubpageBack?.();
    });

    this.titlebar?.addEventListener("click", event => {
      if (!this.windowEl.classList.contains("is-minimized")) return;
      if (event.target.closest("button")) return;
      this.toggleMinimized(false);
    });

    this.nav?.addEventListener("click", event => {
      const button = event.target.closest(".pcl-nav__item");
      if (!button) return;
      event.stopPropagation();
      this.switchPage(button.dataset.page || "Launch");
    });

    document.getElementById("pclLaunchButton")?.addEventListener("click", () => {
      if (this.onLaunch) this.onLaunch(this.version);
      else this.showModal({
        title: "启动游戏",
        caption: "网页渲染器无法真正启动 Minecraft。",
        buttons: ["确定"]
      });
    });

    document.getElementById("pclAccountBtn")?.addEventListener("click", () => {
      this.showModal({
        title: "账户",
        caption: `当前演示账户：${this.account.name}（离线登录）\n\n点击左侧头像可在 Steve / Alex 之间切换。\n\n网页渲染器不会连接 Mojang 或微软登录服务。`,
        buttons: ["好"]
      });
    });

    document.getElementById("pclVersionCard")?.addEventListener("click", async () => {
      const currentIndex = VERSIONS.findIndex(version => version.name === this.version);
      const choice = await this.showModal({
        title: "选择版本",
        caption: "网页渲染器只使用演示版本列表。选择后，左侧启动按钮会同步更新。",
        buttons: [...VERSIONS.map(version => version.name), "取消"],
        activeIndex: currentIndex >= 0 ? currentIndex : 0
      });
      if (choice < VERSIONS.length) {
        this.setVersion(VERSIONS[choice].name);
        this.showHint(`已选择版本：${this.version}`, "Green");
      }
    });
  }

  bindAccountSwitcher() {
    this.avatarButton?.addEventListener("click", () => this.toggleAccount());
    this.avatarButton?.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.toggleAccount();
    });
    this.updateAccountUi();
  }

  toggleAccount() {
    const previous = this.account;
    this.account = previous.name === "Steve" ? ACCOUNTS.Alex : ACCOUNTS.Steve;
    this.updateAccountUi();
    this.pushEvent({
      type: "切换账户",
      data: `${previous.name} -> ${this.account.name}`,
      status: "ok",
      message: `当前账户：${this.account.name}`,
      time: Date.now()
    });
    this.onAccountChange?.({ ...this.account });
  }

  updateAccountUi() {
    const nextName = this.account.name === "Steve" ? "Alex" : "Steve";
    this.sidebar?.setAttribute("data-skin", this.account.skin);
    if (this.profileName) this.profileName.textContent = this.account.name;
    if (this.avatarButton) {
      this.avatarButton.title = `切换为 ${nextName} 头像`;
      this.avatarButton.setAttribute("aria-label", `切换头像，当前 ${this.account.name}`);
    }
  }

  toggleMinimized(force) {
    if (this.windowEl.classList.contains("is-closed")) return;
    const minimize = force == null ? !this.windowEl.classList.contains("is-minimized") : force;
    this.windowEl.classList.toggle("is-minimized", minimize);
    this.scaler.classList.toggle("is-minimized", minimize);
  }

  async closeWindow() {
    if (this.windowEl.classList.contains("is-closed")) return;
    const choice = await this.showModal({
      title: "关闭 PCL 预览",
      caption: "关闭后，主页仍会保留在内存中。可以点击“重新打开”继续预览。",
      buttons: ["关闭", "取消"]
    });
    if (choice !== 0) return;
    this.windowEl.classList.add("is-closed");
    window.setTimeout(() => {
      this.scaler.style.display = "none";
      this.stageEmpty.hidden = false;
    }, 180);
  }

  reopenWindow() {
    this.stageEmpty.hidden = true;
    this.scaler.style.display = "";
    this.windowEl.classList.remove("is-closed", "is-minimized");
    this.scaler.classList.remove("is-minimized");
    this.showHint("已重新打开启动器", "Green");
    this.onReopen?.();
  }

  restartPageAnimation(node) {
    if (!node) return;
    node.style.animation = "none";
    void node.offsetWidth;
    node.style.animation = "";
  }

  showHelpPage(title = "帮助") {
    if (!this.subpageOpen) this.subpageBasePage = this.currentPage;
    this.subpageOpen = true;
    this.windowEl.classList.add("is-subpage");
    this.homePage.hidden = true;
    this.stubPage.hidden = true;
    if (this.helpPage) {
      this.helpPage.hidden = false;
      this.restartPageAnimation(this.helpPage);
    }
    if (this.titlebarSub) {
      this.titlebarSub.hidden = false;
      this.restartPageAnimation(this.titlebarSub);
    }
    if (this.subpageTitle) this.subpageTitle.textContent = String(title || "帮助");
  }

  dismissSubpage({ notify = true } = {}) {
    const wasOpen = this.subpageOpen;
    this.subpageOpen = false;
    this.windowEl.classList.remove("is-subpage");
    if (this.helpPage) this.helpPage.hidden = true;
    if (this.titlebarSub) this.titlebarSub.hidden = true;
    if (this.subpageTitle) this.subpageTitle.textContent = "";
    if (wasOpen && notify) this.onSubpageDismiss?.();
  }

  closeHelpPage() {
    const page = this.subpageBasePage;
    this.dismissSubpage({ notify: false });
    this.subpageBasePage = "Launch";
    this.switchPage(page);
  }

  isHelpPageOpen() {
    return this.subpageOpen;
  }

  switchPage(page, subType = "") {
    if (this.subpageOpen) this.dismissSubpage({ notify: true });
    const key = PAGE_LABELS[page] ? page : "Launch";
    this.currentPage = key;
    const navPage = NAV_FOR_PAGE[key] || "Launch";
    for (const button of this.nav?.querySelectorAll(".pcl-nav__item") || []) {
      const active = button.dataset.page === navPage;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }

    const isLaunch = key === "Launch";
    this.homePage.hidden = !isLaunch;
    this.stubPage.hidden = isLaunch;
    if (this.helpPage) this.helpPage.hidden = true;
    if (!isLaunch) {
      this.stubTitle.textContent = PAGE_LABELS[key] || key;
      this.restartPageAnimation(this.stubPage);
    }
    if (key === "InstanceSetup") {
      this.showHint("版本设置页尚未在网页版中实现。", "Blue");
    }
    return { page: key, subType };
  }


  pushEvent(entry) {
    if (entry.status === "run") {
      this.eventText.textContent = `${timeString(entry.time)} · ${entry.type}${entry.data ? ` → ${entry.data.slice(0, 42)}` : ""} …`;
      this.eventText.dataset.status = "run";
      return;
    }
    this.events.push(entry);
    if (this.events.length > 100) this.events.splice(0, this.events.length - 100);
    if (this.eventCount) this.eventCount.textContent = String(this.events.length);
    const detail = entry.data ? ` → ${entry.data.slice(0, 48)}` : "";
    const message = entry.status === "error" ? ` × ${entry.message}` : entry.message ? ` · ${entry.message}` : "";
    this.eventText.textContent = `${timeString(entry.time)} · ${entry.type}${detail}${message}`;
    this.eventText.dataset.status = entry.status;
  }

  formatEventLog() {
    if (!this.events.length) return "暂无可显示的事件。";
    return this.events
      .slice()
      .reverse()
      .map(entry => {
        const mark = entry.status === "error" ? "×" : "✓";
        const data = entry.data ? ` → ${entry.data}` : "";
        const message = entry.status === "error" ? `\n    ${entry.message}` : entry.duration != null ? `  (${entry.duration} ms)` : "";
        return `[${timeString(entry.time)}] ${mark} ${entry.type}${data}${message}`;
      })
      .join("\n");
  }

  bindTooltips() {
    document.addEventListener("pointermove", event => {
      this.lastPointer = { x: event.clientX, y: event.clientY };
      if (!this.tooltip.hidden && this.tooltip.classList.contains("is-visible")) this.positionTooltip();
    }, { passive: true });

    document.addEventListener("pointerover", event => {
      const target = event.target.closest?.("[data-tooltip]");
      if (!target || target === this.tooltipTarget) return;
      this.tooltipTarget = target;
      window.clearTimeout(this.tooltipTimer);
      this.tooltipTimer = window.setTimeout(() => this.showTooltip(target), 340);
    });

    document.addEventListener("pointerout", event => {
      const target = event.target.closest?.("[data-tooltip]");
      if (!target || target !== this.tooltipTarget) return;
      if (event.relatedTarget && target.contains(event.relatedTarget)) return;
      this.hideTooltip();
    });

    document.addEventListener("scroll", () => this.hideTooltip(), true);
    document.addEventListener("click", () => this.hideTooltip(), true);
  }

  showTooltip(target) {
    const text = target?.dataset?.tooltip;
    if (!text) return;
    this.tooltip.textContent = text;
    this.tooltip.hidden = false;
    this.tooltip.classList.remove("is-visible");
    this.positionTooltip();
    requestAnimationFrame(() => this.tooltip.classList.add("is-visible"));
  }

  positionTooltip() {
    if (this.tooltip.hidden) return;
    const rect = this.tooltip.getBoundingClientRect();
    const padding = 10;
    let left = this.lastPointer.x + 14;
    let top = this.lastPointer.y + 18;
    if (left + rect.width > window.innerWidth - padding) left = this.lastPointer.x - rect.width - 12;
    if (top + rect.height > window.innerHeight - padding) top = this.lastPointer.y - rect.height - 12;
    this.tooltip.style.left = `${Math.max(padding, left)}px`;
    this.tooltip.style.top = `${Math.max(padding, top)}px`;
  }

  hideTooltip() {
    window.clearTimeout(this.tooltipTimer);
    this.tooltipTarget = null;
    this.tooltip.classList.remove("is-visible");
    window.setTimeout(() => {
      if (!this.tooltip.classList.contains("is-visible")) this.tooltip.hidden = true;
    }, 130);
  }
}

