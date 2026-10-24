// Browser assertions for home.html (the standalone homepage page).
//
// Loaded by tools/regression.mjs after it navigates the tab to /home.html.
// index.html exposes window.__PCL_RENDERER__; the standalone page exposes
// window.__PCL_HOME__ with the same renderer and the layout helpers.

const PANEL_WIDTH = 550;
const CONTENT_WIDTH = 500;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const box = (element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const makeCheck = (results, name, fn) =>
  Promise.resolve()
    .then(fn)
    .then((detail) => results.push({ name, ok: true, detail }))
    .catch((error) => results.push({ name, ok: false, error: String(error?.message || error) }));

export async function runHomeCheck() {
  const results = [];

  await makeCheck(results, "独立主页页按 PCL 的 550/500 布局渲染同一主页", async () => {
    const api = window.__PCL_HOME__;
    assert(api, "home.html 必须暴露 window.__PCL_HOME__");
    api.state.mode = "preset";
    api.state.preset = "tutorial";
    await api.renderNow();
    const panel = document.getElementById("homePanel");
    const root = document.getElementById("homeRoot");
    const card = document.querySelector(".pcl-card");
    assert(panel, "缺少 #homePanel");
    assert(root, "缺少 #homeRoot");
    assert(card, "教程预设没有渲染出卡片");
    const panelBox = box(panel);
    const rootBox = box(root);
    const cardBox = box(card);
    // 1:1 is the default: the panel is PCL's 550px right column, the page
    // margin leaves a 525px backdrop, and every card is sized from 500px.
    assert(Math.round(panelBox.w) === PANEL_WIDTH, `面板宽度应为 ${PANEL_WIDTH}，实际 ${panelBox.w}`);
    assert(Math.round(rootBox.w) === PANEL_WIDTH - 25, `内容区宽度应为 525，实际 ${rootBox.w}`);
    assert(Math.round(cardBox.w) === CONTENT_WIDTH, `卡片宽度应为 ${CONTENT_WIDTH}，实际 ${cardBox.w}`);
    assert(document.querySelectorAll(".pcl-unsupported").length === 0, "教程预设不应出现不支持控件");
    return `cards=${document.querySelectorAll(".pcl-card").length} card=${Math.round(cardBox.w)}x${Math.round(cardBox.h)}`;
  });

  await makeCheck(results, "适应宽度只缩放像素尺寸，不改变 500px 内容宽度", async () => {
    const api = window.__PCL_HOME__;
    const card = () => Math.round(box(document.querySelector(".pcl-card")).w);
    const before = card();
    api.setFitWidth(true);
    await sleep(60);
    assert(api.fitWidth === true, "setFitWidth(true) 没有生效");
    assert(api.zoom > 1, `1600px 视口下适应宽度应大于 1，实际 ${api.zoom}`);
    const scaledWidth = box(document.querySelector(".pcl-card")).w;
    // CSS zoom scales the painted width; the layout width stays 500px so line
    // breaks and card heights are identical in both modes.
    const layoutWidth = document.getElementById("homeRoot").getBoundingClientRect().width / api.zoom;
    assert(Math.round(scaledWidth) > before, `适应宽度后卡片应更宽（${before} → ${scaledWidth}）`);
    assert(Math.abs(layoutWidth - 525) < 1.5, `未缩放的布局宽度应保持 525，实际 ${layoutWidth}`);
    assert(document.getElementById("homeFit").getAttribute("aria-pressed") === "true", "按钮的 aria-pressed 未同步");
    api.setFitWidth(false);
    await sleep(60);
    assert(api.zoom === 1, `恢复 1:1 后 zoom 应为 1，实际 ${api.zoom}`);
    assert(Math.round(box(document.querySelector(".pcl-card")).w) === before, "恢复 1:1 后卡片宽度应回到原值");
    return `zoom=${api.zoom}`;
  });

  await makeCheck(results, "独立主页页的主题事件作用于自己的面板", async () => {
    const api = window.__PCL_HOME__;
    const panel = document.getElementById("homePanel");
    const originalHue = getComputedStyle(panel).getPropertyValue("--pcl-hue").trim() || "210";
    api.runtime.raise([{ type: "修改设置", data: "UiLauncherHue|0" }]);
    for (let i = 0; i < 40 && getComputedStyle(panel).getPropertyValue("--pcl-hue").trim() !== "0"; i += 1) {
      await sleep(25);
    }
    const hue = getComputedStyle(panel).getPropertyValue("--pcl-hue").trim();
    assert(hue === "0", `面板色相应随事件变为 0，实际 ${hue}`);
    api.runtime.raise([{ type: "修改设置", data: `UiLauncherHue|${originalHue}` }]);
    for (let i = 0; i < 40 && getComputedStyle(panel).getPropertyValue("--pcl-hue").trim() !== originalHue; i += 1) {
      await sleep(25);
    }
    const restored = getComputedStyle(panel).getPropertyValue("--pcl-hue").trim();
    assert(restored === originalHue, `色相应恢复为 ${originalHue}，实际 ${restored}`);
    return `hue 0 → ${restored}`;
  });

  await makeCheck(results, "独立主页页的 PCL 事件不会因为没有外壳而报错", async () => {
    const api = window.__PCL_HOME__;
    const shown = [];
    const original = api.runtime.shell.showHint.bind(api.runtime.shell);
    api.runtime.shell.showHint = (text, type) => {
      shown.push(`${type || "Blue"}:${text}`);
      original(text, type);
    };
    try {
      await api.runtime.handle("弹出提示", "来自测试的提示");
      await api.runtime.handle("修改设置", "UiLauncherHue|210");
      await api.runtime.handle("复制文本", "home.html");
      const modal = api.runtime.handle("弹出窗口", "测试标题|测试内容");
      await sleep(120);
      const layer = document.querySelector(".home-modal");
      assert(layer, "「弹出窗口」应产生一个真实弹窗");
      assert(layer.querySelector(".pcl-modal__title").textContent === "测试标题", "弹窗标题不对");
      layer.querySelector(".pcl-modal__button").click();
      await modal;
      assert(!document.querySelector(".home-modal"), "关闭后弹窗应被移除");
    } finally {
      api.runtime.shell.showHint = original;
    }
    assert(
      shown.some((line) => line.includes("来自测试的提示")),
      `提示没有走 hint 栈：${shown.join(" | ")}`
    );
    return shown.join(" | ").slice(0, 80);
  });

  await makeCheck(results, "独立主页页复用同一套源代码与代理加载器", async () => {
    const api = window.__PCL_HOME__;
    // A file source must render without the viewer's editor or drop zone.
    api.state.mode = "file";
    api.state.fileName = "Custom.xaml";
    api.state.fileContent =
      '<local:MyCard Title="独立页" Margin="0,0,0,15"><TextBlock Margin="15,38,15,15" Text="只显示主页内容" /></local:MyCard>';
    await api.renderNow();
    await sleep(40);
    const titles = Array.from(document.querySelectorAll(".pcl-card__title")).map((node) => node.textContent.trim());
    assert(titles.includes("独立页"), `文件源没有渲染出来：${titles.join(",")}`);
    assert(document.getElementById("homeSource").textContent.includes("Custom.xaml"), "来源说明未显示文件名");
    return titles.join(",");
  });

  await makeCheck(results, "独立主页页在渲染失败时给出可读提示", async () => {
    const api = window.__PCL_HOME__;
    api.state.mode = "code";
    api.state.code = "<local:MyCard Title='x'><TextBlock Text='未闭合'</local:MyCard>";
    await api.renderNow();
    await sleep(40);
    const message = document.querySelector(".pcl-home-message");
    assert(message, "错误时缺少提示块");
    assert(message.textContent.includes("主页加载失败"), `提示文案不对：${message.textContent}`);
    api.state.code = '<local:MyCard Title="ok"><TextBlock Text="恢复" /></local:MyCard>';
    await api.renderNow();
    await sleep(40);
    assert(!document.querySelector(".pcl-home-message"), "恢复后提示块应被清掉");
    return message.textContent.slice(0, 40);
  });

  return { ok: results.every((item) => item.ok), results };
}
