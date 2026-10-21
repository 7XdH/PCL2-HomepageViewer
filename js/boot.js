// Keep the startup fallback outside index.html so the page can use a strict
// CSP without inline script exceptions.
(() => {
  let attempts = 0;
  const timer = window.setInterval(() => {
    const ready = Boolean(window.__PCL_RENDERER__);
    const fallback = document.getElementById("bootFallback");
    if (ready) {
      if (fallback) fallback.hidden = true;
      window.clearInterval(timer);
      return;
    }
    attempts += 1;
    if (attempts >= 20) {
      if (fallback) fallback.hidden = false;
      window.clearInterval(timer);
    }
  }, 500);
})();
