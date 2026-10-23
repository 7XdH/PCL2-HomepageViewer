// Appearance: the shell around the PCL canvas.
//
// The canvas always renders exactly what PCL renders; this module only picks
// which workspace surrounds it. `light` is the original bright workspace,
// `dark` keeps the canvas lit as the subject, and `amoled` drops the page to
// near black so the canvas is the only bright thing on screen. Both dark
// appearances dim the canvas to 90% (see --appearance-dim in appearance.css).

const STORAGE_KEY = "pcl.lab.appearance.v1";
const VARIANTS = ["light", "dark", "amoled"];
const META_COLORS = { light: "#1370f3", dark: "#0b1016", amoled: "#05070a" };

function normalize(value) {
  return VARIANTS.includes(value) ? value : "light";
}

export function readStoredAppearance() {
  try {
    return normalize(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return "light";
  }
}

export function applyAppearance(value) {
  const next = normalize(value);
  const root = document.documentElement;
  root.dataset.theme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", META_COLORS[next]);
  return next;
}

export function createAppearance({ group, onChange } = {}) {
  let current = applyAppearance(readStoredAppearance());
  const buttons = group ? Array.from(group.querySelectorAll("[data-appearance]")) : [];

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

  for (const button of buttons) {
    button.addEventListener("click", () => set(button.dataset.appearance));
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
    set,
    variants: VARIANTS.slice()
  };
}
