import { PCL2_PRESETS } from "../pcl-presets.js";

export const PCL2_OK_COUNT = PCL2_PRESETS.filter((preset) => preset.expected === "ok").length;

export const PCL_PRESET_STATES = {
  ok: { label: "通常可用", className: "ok", hint: "按 PCL2 UA 拉取，已知可以正常渲染。" },
  unavailable: { label: "上游可能不可用", className: "warn", hint: "上游站点可能已下线；点击后仍会尝试拉取。" },
  blocked: { label: "会被安全阻止", className: "blocked", hint: "上游主页包含 x:Static 或 x:Code，渲染器会拒绝执行。" }
};

function pclPresetHost(preset) {
  if (!preset.url) return "内置 XAML";
  return preset.url.replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
}

export function renderPresetList({ list, count, empty, filter = "" } = {}) {
  if (!list) return;
  const query = filter.trim().toLowerCase();
  const items = PCL2_PRESETS.filter((preset) => {
    const info =
      preset.kind === "inline"
        ? { label: "内置内容" }
        : PCL_PRESET_STATES[preset.expected] || PCL_PRESET_STATES.unavailable;
    const haystack = `${preset.name} ${preset.url || ""} ${info.label}`.toLowerCase();
    return !query || haystack.includes(query);
  });

  list.replaceChildren();
  for (const preset of items) {
    const key = `pcl2-${preset.id}`;
    const info =
      preset.kind === "inline"
        ? { label: "内置内容", className: "inline", hint: "直接使用内置 XAML，无需联网。" }
        : PCL_PRESET_STATES[preset.expected] || PCL_PRESET_STATES.unavailable;
    const host = pclPresetHost(preset);

    const button = document.createElement("button");
    button.type = "button";
    button.className = `preset-item preset-item--pcl preset-item--${info.className}`;
    button.dataset.preset = key;
    button.title = `${preset.name}\n${preset.url || "内置 XAML"}\n${info.hint}`;
    button.setAttribute("aria-label", `${preset.name}，${info.label}`);

    const glyph = document.createElement("span");
    glyph.className = "preset-item__glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = String(preset.id).padStart(2, "0");

    const body = document.createElement("span");
    body.className = "preset-item__body";
    const strong = document.createElement("strong");
    strong.textContent = preset.name;
    const small = document.createElement("small");
    const hostSpan = document.createElement("span");
    hostSpan.className = "preset-host";
    hostSpan.textContent = host;
    const stateSpan = document.createElement("span");
    stateSpan.className = `preset-state preset-state--${info.className}`;
    stateSpan.textContent = info.label;
    small.append(hostSpan, stateSpan);
    body.append(strong, small);

    const arrow = document.createElement("span");
    arrow.className = "preset-item__arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";

    button.append(glyph, body, arrow);
    list.append(button);
  }

  if (empty) empty.hidden = items.length > 0;
  if (count) {
    count.textContent = query
      ? `${items.length}/${PCL2_PRESETS.length} 个`
      : `${PCL2_PRESETS.length} 个 · ${PCL2_OK_COUNT} 可渲染`;
  }
  return items.length;
}
