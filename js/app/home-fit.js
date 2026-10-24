// Geometry for the standalone homepage view (home.html).
//
// PCL's right panel is 550px wide: a 25px page margin, the 500px content
// column every card is sized from, and another 25px margin that the 8px
// scrollbar sits inside. `1:1` renders that panel untouched — it is what the
// viewer's pixel comparisons are measured against — and only shrinks when the
// window is narrower than the panel. Fit-to-width scales the whole panel with
// CSS `zoom`, so line breaks, card heights and image crops stay identical and
// only the pixel size changes. `zoom` (not a transform) keeps the scroll height
// honest and the text vector-sharp.
export const HOME_PANEL_WIDTH = 550;
export const HOME_CONTENT_WIDTH = 500;
// Beyond 3x a 500px column would be a poster and glyph hinting gets coarse; the
// cap also keeps an ultra-wide window from turning into a wall of text.
export const HOME_MAX_ZOOM = 3;

export function normalizeFit(value) {
  return value === true || value === "1" || value === "true";
}

export function computeHomeZoom({
  viewportWidth,
  fit = false,
  panelWidth = HOME_PANEL_WIDTH,
  maxZoom = HOME_MAX_ZOOM
} = {}) {
  const width = Number(viewportWidth);
  const panel = Number(panelWidth);
  if (!Number.isFinite(width) || width <= 0) return 1;
  if (!Number.isFinite(panel) || panel <= 0) return 1;
  const available = width / panel;
  if (!Number.isFinite(available) || available <= 0) return 1;
  // 1:1 keeps PCL's real pixel size and only shrinks to avoid clipping; the fit
  // mode grows to fill the window, up to the cap.
  const zoom = normalizeFit(fit) ? Math.min(available, maxZoom) : Math.min(available, 1);
  // Round so the CSS value stays short; the leftover sub-pixel is invisible.
  return Math.round(zoom * 1e4) / 1e4;
}
