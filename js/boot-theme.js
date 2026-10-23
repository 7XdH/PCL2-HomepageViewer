// Paint the stored appearance before the first frame.
//
// This lives in <head> so a dark shell never flashes the light workspace while
// the module bundle loads. js/app/appearance.js owns the choice afterwards and
// reads the same key; keep both in sync if the storage key changes.
(() => {
  const KEY = "pcl.lab.appearance.v1";
  const META_COLORS = { light: "#1370f3", dark: "#0b1016", amoled: "#05070a" };
  let theme = "light";
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === "dark" || stored === "amoled") theme = stored;
  } catch {
    /* storage blocked: keep the light default */
  }
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", META_COLORS[theme]);
})();
