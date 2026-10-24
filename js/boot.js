// Keep the startup fallback outside index.html so the page can use a strict
// CSP without inline script exceptions. The stored appearance is restored
// earlier, by js/boot-theme.js in <head>.
//
// This file must stay a classic script: it is the one piece that still runs
// when index.html is opened over file://, where ES modules are blocked. That is
// also why the decision table is a plain function hanging off the global
// instead of an import - tools/unit-tests.mjs reads it via `vm` so the "is the
// app usable" logic can be tested without a browser.
(() => {
  const ATTEMPT_MS = 500;
  const MAX_ATTEMPTS = 20; // ~10s, same budget as before

  // `ready` matters because js/app.js assigns window.__PCL_RENDERER__ at the
  // very top of init(); its presence only proves the module parsed. Only
  // `.ready === true` proves the first render finished.
  function bootStatus({ hasApi, ready, bootError = "", attempts, maxAttempts = MAX_ATTEMPTS }) {
    if (ready) return { state: "ok" };
    if (bootError) return { state: "failed", title: "界面初始化失败" };
    if (attempts < maxAttempts) return { state: "waiting" };
    // Something registered but never became ready: the module loaded and then
    // stalled. Nothing registered at all is the file:// case, which keeps the
    // markup's original wording.
    return hasApi ? { state: "timeout", title: "界面启动超时" } : { state: "module" };
  }

  window.__PCL_BOOT_STATUS__ = bootStatus;

  function escapeHtml(text) {
    return String(text).replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
    );
  }

  function show(title, body) {
    const fallback = document.getElementById("bootFallback");
    if (!fallback) return;
    // Only replace the markup's static text when a concrete reason exists, so
    // the file:// explanation survives a plain double-click open.
    if (title) {
      const titleEl = fallback.querySelector("strong");
      if (titleEl) titleEl.textContent = title;
    }
    if (body) {
      const bodyEl = fallback.querySelector("span");
      if (bodyEl) bodyEl.innerHTML = body;
    }
    fallback.hidden = false;
  }

  function hide() {
    const fallback = document.getElementById("bootFallback");
    if (fallback) fallback.hidden = true;
  }

  let attempts = 0;
  const timer = window.setInterval(() => {
    const api = window.__PCL_RENDERER__;
    attempts += 1;
    const status = bootStatus({
      hasApi: Boolean(api),
      ready: api?.ready === true,
      bootError: window.__PCL_BOOT_ERROR__ || "",
      attempts
    });

    if (status.state === "waiting") return;
    window.clearInterval(timer);

    if (status.state === "ok") {
      hide();
      return;
    }
    if (status.state === "failed") {
      show(
        status.title,
        "页面脚本已加载，但初始化时出错，预览区无法使用。" +
          `错误信息：<code>${escapeHtml(window.__PCL_BOOT_ERROR__)}</code>。` +
          "详细堆栈见浏览器控制台；如果只是本地双击打开，请改为运行 <code>node server.js</code> 后访问 <code>http://localhost:3000</code>。"
      );
      return;
    }
    if (status.state === "timeout") {
      show(
        status.title,
        "脚本已加载，但 10 秒内没有完成首次渲染。请打开浏览器控制台查看是否有报错，" +
          "并确认 <code>js/</code> 下的模块都能正常访问。"
      );
      return;
    }
    // state === "module": nothing registered at all, almost always a file://
    // ES module block, so keep the markup's original explanation.
    show(null, null);
  }, ATTEMPT_MS);
})();
