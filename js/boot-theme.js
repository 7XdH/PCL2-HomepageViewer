// Paint the stored appearance before the first frame.
//
// This lives in <head> so a dark shell never flashes the light workspace while
// the module bundle loads. js/app/appearance.js owns the choice afterwards and
// reads the same key; keep both in sync if the storage key or the variants
// change.
(() => {
  const KEY = "pcl.lab.appearance.v1";
  const META_COLORS = { light: "#1370f3", dark: "#0b1016", amoled: "#05070a" };
  let preference = "light";
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === "dark" || stored === "amoled" || stored === "auto") preference = stored;
  } catch {
    /* storage blocked: keep the light default */
  }
  // `auto` follows the operating system; an explicit choice ignores it.
  let theme = preference;
  if (preference === "auto") {
    const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    theme = dark ? "dark" : "light";
  }
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.appearance = preference;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", META_COLORS[theme]);
})();
