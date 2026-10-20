const DEFAULT_HUE = 210;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeHue(value) {
  const hue = Number(value);
  if (!Number.isFinite(hue)) return DEFAULT_HUE;
  return ((Math.round(hue) % 360) + 360) % 360;
}

export function hslToRgb(h, s, l) {
  const hue = ((Number(h) % 360) + 360) % 360;
  const sat = clamp(Number(s), 0, 100) / 100;
  const light = clamp(Number(l), 0, 100) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let rgb;
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map(channel => Math.round((channel + m) * 255));
}

export function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map(value => clamp(value, 0, 255).toString(16).padStart(2, "0")).join("");
}

export function mixRgb(stops) {
  const total = stops.reduce((sum, stop) => sum + stop.weight, 0) || 1;
  const result = [0, 0, 0];
  for (const stop of stops) {
    for (let i = 0; i < 3; i += 1) result[i] += stop.rgb[i] * stop.weight;
  }
  return result.map(value => Math.round(value / total));
}

/**
 * PCL's MyColor.FromHSL2: a per-hue brightness compensation applied before HSL.
 * Reproducing it keeps ColorBrush1–8 identical to PCL instead of a naive HSL ramp.
 */
export function fromHsl2(hue, saturation, lightness) {
  let h = ((Number(hue) + 3600000) % 360 + 360) % 360;
  const s = clamp(Number(saturation), 0, 100);
  const l = clamp(Number(lightness), 0, 100);
  if (s === 0) {
    const gray = Math.round(l * 2.55);
    return [gray, gray, gray];
  }
  const cent = [
    0.1, -0.06, -0.3,
    -0.19, -0.15, -0.24,
    -0.32, -0.09, 0.18,
    0.05, -0.12, -0.02,
    0.1, -0.06
  ];
  const centerRaw = h / 30;
  const index = Math.floor(centerRaw);
  const center = 50 - (
    (1 - centerRaw + index) * cent[index] + (centerRaw - index) * cent[index + 1]
  ) * s;
  const adjustedLight = (l < center ? l / center : 1 + (l - center) / (100 - center)) * 50;
  return hslToRgb(h, s, adjustedLight);
}

const DEFAULT_PALETTE = {
  c1: "#343d4a",
  c2: "#0b5bcb",
  c3: "#1370f3",
  c4: "#4890f5",
  c5: "#96c0f9",
  c6: "#d5e6fd",
  c7: "#e0eafd",
  c8: "#eaf2fe",
  bg0: "#96c0f9"
};

export function buildPalette(hue) {
  const h = normalizeHue(hue);
  if (h === 210) {
    const title0 = fromHsl2(215, 90, 48);
    const title1 = fromHsl2(215, 90, 54);
    const page0 = fromHsl2(200, 68, 91);
    const page1 = fromHsl2(215, 68, 91);
    const page2 = fromHsl2(230, 68, 91);
    return {
      hue: h,
      ...DEFAULT_PALETTE,
      bg1: "rgba(224, 234, 253, 0.745)",
      title: `linear-gradient(90deg, ${rgbToHex(title0)}, ${rgbToHex(title1)}, ${rgbToHex(title0)})`,
      page: `linear-gradient(225deg, ${rgbToHex(page0)} 0%, ${rgbToHex(page1)} 42%, ${rgbToHex(page2)} 100%)`
    };
  }

  // PCL’s runtime theme uses FromHSL2. The blue preset above mirrors PCL’s
  // published ColorBrush table; custom hues follow the same compensated ramp.
  const c1 = fromHsl2(h + 5, 18, 25);
  const c2 = fromHsl2(h + 5, 90, 45);
  const c3 = fromHsl2(h + 5, 90, 55);
  const c4 = fromHsl2(h + 5, 90, 65);
  const c5 = fromHsl2(h + 5, 90, 80);
  const c6 = fromHsl2(h + 5, 90, 91);
  const c7 = fromHsl2(h + 5, 90, 95);
  const c8 = fromHsl2(h + 5, 90, 97);
  const bg0 = mixRgb([
    { rgb: c4, weight: 0.4 },
    { rgb: c5, weight: 0.4 },
    { rgb: [166, 166, 166], weight: 0.2 }
  ]);
  const title0 = fromHsl2(h + 5, 90, 48);
  const title1 = fromHsl2(h + 5, 90, 54);
  const page0 = fromHsl2(h - 10, 68, 91);
  const page1 = fromHsl2(h + 5, 68, 91);
  const page2 = fromHsl2(h + 20, 68, 91);
  return {
    hue: h,
    c1: rgbToHex(c1),
    c2: rgbToHex(c2),
    c3: rgbToHex(c3),
    c4: rgbToHex(c4),
    c5: rgbToHex(c5),
    c6: rgbToHex(c6),
    c7: rgbToHex(c7),
    c8: rgbToHex(c8),
    bg0: rgbToHex(bg0),
    bg1: `rgba(${c7.join(", ")}, 0.745)`,
    title: `linear-gradient(90deg, ${rgbToHex(title0)}, ${rgbToHex(title1)}, ${rgbToHex(title0)})`,
    page: `linear-gradient(225deg, ${rgbToHex(page0)} 0%, ${rgbToHex(page1)} 42%, ${rgbToHex(page2)} 100%)`
  };
}

export class PclTheme {
  constructor({ onChange } = {}) {
    this.onChange = onChange;
    this.hue = DEFAULT_HUE;
    this.apply();
  }

  setHue(value) {
    const hue = normalizeHue(value);
    if (hue === this.hue) {
      this.apply();
      return this.hue;
    }
    this.hue = hue;
    this.apply();
    this.onChange?.(hue, this.palette);
    return hue;
  }

  reset() {
    return this.setHue(DEFAULT_HUE);
  }

  /**
   * The viewer chrome always stays PCL blue. Theme events only re-color the
   * 850 × 500 preview surface, exactly as a homepage's {setup:UiLauncherHue}
   * would re-color PCL itself.
   */
  apply() {
    const palette = buildPalette(this.hue);
    this.palette = palette;
    const target = document.getElementById("pclWindow");
    if (!target) return;
    target.style.setProperty("--pcl-hue", String(palette.hue));
    target.style.setProperty("--pcl-c1", palette.c1);
    target.style.setProperty("--pcl-c2", palette.c2);
    target.style.setProperty("--pcl-c3", palette.c3);
    target.style.setProperty("--pcl-c4", palette.c4);
    target.style.setProperty("--pcl-c5", palette.c5);
    target.style.setProperty("--pcl-c6", palette.c6);
    target.style.setProperty("--pcl-c7", palette.c7);
    target.style.setProperty("--pcl-c8", palette.c8);
    target.style.setProperty("--pcl-bg0", palette.bg0);
    target.style.setProperty("--pcl-bg1", palette.bg1);
    target.style.setProperty("--pcl-title-gradient", palette.title);
    target.style.setProperty("--pcl-page-gradient", palette.page);
  }
}
