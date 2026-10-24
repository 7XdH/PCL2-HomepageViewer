import { PclShellBase } from "./base.js";
import { PAGE_LABELS, NAV_FOR_PAGE, VERSIONS, ACCOUNTS, timeString, saveShellPreferences } from "./helpers.js";
import { EVENT_LOG_LIMIT, EVENT_DATA_LIMIT } from "../limits.js";

export class PclShellNavigation extends PclShellBase {
  bindWindowControls() {
    document.getElementById("winMinBtn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleMinimized();
    });
    document.getElementById("winCloseBtn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.closeWindow();
    });
    document.getElementById("reopenBtn")?.addEventListener("click", () => this.reopenWindow());
    document.getElementById("pclStubBack")?.addEventListener("click", () => this.switchPage("Launch"));
    document.getElementById("pclSubpageBack")?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.onSubpageBack?.();
    });

    this.titlebar?.addEventListener("click", (event) => {
      if (!this.windowEl.classList.contains("is-minimized")) return;
      if (event.target.closest("button")) return;
      this.toggleMinimized(false);
    });

    this.nav?.addEventListener("click", (event) => {
      const button = event.target.closest(".pcl-nav__item");
      if (!button) return;
      event.stopPropagation();
      this.switchPage(button.dataset.page || "Launch");
    });

    document.getElementById("pclLaunchButton")?.addEventListener("click", () => {
      if (this.onLaunch) {
        this.onLaunch(this.version);
      } else {
        this.showModal({
          title: "启动游戏",
          caption: "网页渲染器无法真正启动 Minecraft。",
          buttons: ["确定"]
        });
      }
    });

    document.getElementById("pclAccountBtn")?.addEventListener("click", () => {
      this.showModal({
        title: "账户",
        caption: `当前演示账户：${this.account.name}（离线登录）\n\n点击左侧头像可在 Steve / Alex 之间切换。\n\n网页渲染器不会连接 Mojang 或微软登录服务。`,
        buttons: ["好"]
      });
    });

    document.getElementById("pclVersionCard")?.addEventListener("click", async () => {
      const currentIndex = VERSIONS.findIndex((version) => version.name === this.version);
      const choice = await this.showModal({
        title: "选择版本",
        caption: "网页渲染器只使用演示版本列表。选择后，左侧启动按钮会同步更新。",
        buttons: [...VERSIONS.map((version) => version.name), "取消"],
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
    this.avatarButton?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.toggleAccount();
    });
    this.updateAccountUi();
  }

  toggleAccount() {
    const previous = this.account;
    this.account = previous.name === "Steve" ? ACCOUNTS.Alex : ACCOUNTS.Steve;
    saveShellPreferences({ version: this.version, account: this.account.name });
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
    // A single event can carry a whole command line or URL. Cap it before it is
    // stored, so the 100-entry log has a bounded size instead of only a bounded
    // entry count.
    if (entry.data && entry.data.length > EVENT_DATA_LIMIT) {
      entry = { ...entry, data: `${entry.data.slice(0, EVENT_DATA_LIMIT)}…` };
    }
    if (entry.status === "run") {
      this.eventText.textContent = `${timeString(entry.time)} · ${entry.type}${entry.data ? ` → ${entry.data}` : ""} …`;
      this.eventText.dataset.status = "run";
      return;
    }
    this.events.push(entry);
    if (this.events.length > EVENT_LOG_LIMIT) this.events.splice(0, this.events.length - EVENT_LOG_LIMIT);
    if (this.eventCount) this.eventCount.textContent = String(this.events.length);
    const detail = entry.data ? ` → ${entry.data}` : "";
    const message = entry.status === "error" ? ` × ${entry.message}` : entry.message ? ` · ${entry.message}` : "";
    this.eventText.textContent = `${timeString(entry.time)} · ${entry.type}${detail}${message}`;
    this.eventText.dataset.status = entry.status;
  }

  formatEventLog() {
    if (!this.events.length) return "暂无可显示的事件。";
    return this.events
      .slice()
      .reverse()
      .map((entry) => {
        const mark = entry.status === "error" ? "×" : "✓";
        const data = entry.data ? ` → ${entry.data}` : "";
        const message =
          entry.status === "error"
            ? `\n    ${entry.message}`
            : entry.duration != null
              ? `  (${entry.duration} ms)`
              : "";
        return `[${timeString(entry.time)}] ${mark} ${entry.type}${data}${message}`;
      })
      .join("\n");
  }

  bindTooltips() {
    document.addEventListener(
      "pointermove",
      (event) => {
        this.lastPointer = { x: event.clientX, y: event.clientY };
        if (!this.tooltip.hidden && this.tooltip.classList.contains("is-visible")) this.positionTooltip();
      },
      { passive: true }
    );

    document.addEventListener("pointerover", (event) => {
      const target = event.target.closest?.("[data-tooltip]");
      if (!target || target === this.tooltipTarget) return;
      this.tooltipTarget = target;
      window.clearTimeout(this.tooltipTimer);
      this.tooltipTimer = window.setTimeout(() => this.showTooltip(target), 340);
    });

    document.addEventListener("pointerout", (event) => {
      const target = event.target.closest?.("[data-tooltip]");
      if (!target || target !== this.tooltipTarget) return;
      if (event.relatedTarget && target.contains(event.relatedTarget)) return;
      this.hideTooltip();
    });

    document.addEventListener("focusin", (event) => {
      const target = event.target.closest?.("[data-tooltip]");
      if (!target) return;
      this.tooltipTarget = target;
      window.clearTimeout(this.tooltipTimer);
      this.showTooltip(target, { anchor: target });
    });

    document.addEventListener("focusout", (event) => {
      const target = event.target.closest?.("[data-tooltip]");
      if (!target || target !== this.tooltipTarget) return;
      if (event.relatedTarget && target.contains(event.relatedTarget)) return;
      this.hideTooltip();
    });

    document.addEventListener("scroll", () => this.hideTooltip(), true);
    document.addEventListener("click", () => this.hideTooltip(), true);
  }

  showTooltip(target, { anchor = null } = {}) {
    const text = target?.dataset?.tooltip;
    if (!text) return;
    this.tooltipAnchor = anchor;
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
    if (this.tooltipAnchor?.isConnected) {
      const anchor = this.tooltipAnchor.getBoundingClientRect();
      let left = anchor.left + anchor.width / 2 - rect.width / 2;
      let top = anchor.top - rect.height - 8;
      if (top < padding) top = anchor.bottom + 8;
      left = Math.max(padding, Math.min(left, window.innerWidth - rect.width - padding));
      top = Math.max(padding, Math.min(top, window.innerHeight - rect.height - padding));
      this.tooltip.style.left = `${left}px`;
      this.tooltip.style.top = `${top}px`;
      return;
    }
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
    this.tooltipAnchor = null;
    this.tooltip.classList.remove("is-visible");
    window.setTimeout(() => {
      if (!this.tooltip.classList.contains("is-visible")) this.tooltip.hidden = true;
    }, 130);
  }
}
