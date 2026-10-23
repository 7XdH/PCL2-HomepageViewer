// Appearance: the shell around the PCL canvas.
//
// The canvas always renders exactly what PCL renders; this module only picks
// which workspace surrounds it. `auto` follows the operating system and comes
// first because it is the choice most people want; `light` is the original
// bright workspace, `dark` keeps the canvas lit as the subject, and `amoled`
// drops the page to near black so the canvas is the only bright thing on
// screen. The two dark workspaces dim the canvas to 90% (see
// --appearance-dim in appearance.css).

const STORAGE_KEY = "pcl.lab.appearance.v1";
const SYSTEM_QUERY = "(prefers-color-scheme: dark)";
// Declared order is the order the switch shows and the order arrow keys walk,
// so keep it aligned with index.html.
const VARIANTS = ["auto", "light", "dark", "amoled"];
const META_COLORS = { light: "#1370f3", dark: "#0b1016", amoled: "#05070a" };
// A first visit has no stored choice and starts on `auto`, so the workspace
// matches whatever the operating system is already doing. Storage that is
// blocked or holds an unknown value resolves to the same default.
const DEFAULT_VARIANT = "auto";

function normalize(value) {
  return VARIANTS.includes(value) ? value : DEFAULT_VARIANT;
}

export function systemPrefersDark() {
  return Boolean(window.matchMedia?.(SYSTEM_QUERY).matches);
}

// `auto` resolves to the dark workspace when the system asks for dark and to
// the light one otherwise. The canvas dim only applies to the dark result, so
// a light-system user never sees a dimmed canvas.
export function resolveAppearance(value) {
  const preference = normalize(value);
  if (preference !== "auto") return preference;
  return systemPrefersDark() ? "dark" : "light";
}

export function readStoredAppearance() {
  try {
    return normalize(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_VARIANT;
  }
}

// Writes the preference and the workspace it resolves to. Returns the
// preference, which is what the switch and storage track.
export function applyAppearance(value) {
  const preference = normalize(value);
  const theme = resolveAppearance(preference);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.appearance = preference;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", META_COLORS[theme]);
  return preference;
}

export function createAppearance({ group, onChange } = {}) {
  let current = applyAppearance(readStoredAppearance());
  const buttons = group ? Array.from(group.querySelectorAll("[data-appearance]")) : [];
  const media = window.matchMedia?.(SYSTEM_QUERY) ?? null;

  function paint() {
    for (const button of buttons) {
      const active = button.dataset.appearance === current;
      button.setAttribute("aria-checked", String(active));
      button.tabIndex = active ? 0 : -1;
      const label = button.getAttribute("aria-label");
      if (label) button.title = label;
    }
  }

  function set(value, { persist = true, silent = false } = {}) {
    const next = normalize(value);
    const changed = next !== current;
    current = applyAppearance(next);
    try {
      // Persist even when the appearance did not change, so clicking the
      // active option still records an explicit choice.
      if (persist) window.localStorage.setItem(STORAGE_KEY, current);
    } catch {
      /* private mode: the choice simply does not survive a reload */
    }
    paint();
    if (changed && !silent) onChange?.(current);
    return current;
  }

  // Only the `auto` preference tracks the system; an explicit choice stays put
  // when the OS flips at sunset.
  function followSystem() {
    if (current !== "auto") return;
    applyAppearance(current);
    onChange?.(current);
  }

  for (const button of buttons) {
    button.addEventListener("click", () => set(button.dataset.appearance));
  }

  if (media) {
    if (media.addEventListener) media.addEventListener("change", followSystem);
    else media.addListener?.(followSystem);
  }

  group?.addEventListener("keydown", (event) => {
    const index = VARIANTS.indexOf(current);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    let next = null;
    if (step) next = VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length];
    else if (event.key === "Home") next = VARIANTS[0];
    else if (event.key === "End") next = VARIANTS[VARIANTS.length - 1];
    if (!next) return;
    event.preventDefault();
    set(next);
    buttons.find((button) => button.dataset.appearance === current)?.focus();
  });

  paint();

  return {
    get current() {
      return current;
    },
    get resolved() {
      return resolveAppearance(current);
    },
    followsSystem: Boolean(media),
    set,
    variants: VARIANTS.slice()
  };
}
