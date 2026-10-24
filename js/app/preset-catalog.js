// The homepage catalog both entry points render from.
//
// index.html and home.html must offer the same sources — the standalone page
// mirrors whatever the full viewer last rendered — so the catalog lives here
// instead of inside js/app.js.

import { PCL2_PRESETS } from "../pcl-presets.js";

export const LOCAL_PRESETS = {
  tutorial: { title: "PCL 原版教程", path: "assets/presets/tutorial.xaml" },
  gallery: { title: "控件画廊", path: "assets/presets/gallery.xaml" },
  events: { title: "事件测试台", path: "assets/presets/events.xaml" },
  hint: { title: "你知道吗", path: "assets/presets/hint.xaml" }
};

export const PRESETS = {
  ...LOCAL_PRESETS,
  ...Object.fromEntries(
    PCL2_PRESETS.map((preset) => [
      `pcl2-${preset.id}`,
      {
        title: preset.name,
        kind: preset.kind || "remote",
        url: preset.url || "",
        xaml: preset.xaml || "",
        expected: preset.expected,
        pclId: preset.id
      }
    ])
  )
};

export const FALLBACK_XAML = `
<local:MyHint Margin="0,0,0,15" Theme="Blue" Text="当前通过 file:// 打开。预设文件与联网代理需要运行 node server.js 后才能加载；本地文件和源码仍可正常渲染。" />
<local:MyCard Title="PCL Homepage Viewer（第三方）" Margin="0,0,0,15" CanSwap="True">
    <StackPanel Margin="25,40,23,15">
        <TextBlock TextWrapping="Wrap" Margin="0,0,0,8"
                   Text="PCL 自定义主页已经成功启动。你可以把 Custom.xaml 拖入页面，或在左侧粘贴源码。" />
        <TextBlock TextWrapping="Wrap" Margin="0,0,0,10" FontSize="11" Foreground="#8C7721"
                   Text="提示：使用 node server.js 启动本地服务器后，预设与联网主页功能将完整可用。" />
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Left">
            <local:MyButton Margin="0,0,10,0" Height="35" Padding="18,0,18,0" ColorType="Highlight"
                            Text="打开 PCL 仓库" EventType="打开网页" EventData="https://github.com/Meloong-Git/PCL" />
            <local:MyButton Height="35" Padding="18,0,18,0"
                            Text="显示一个弹窗" EventType="弹出窗口" EventData="PCL Homepage Viewer|这个弹窗由 PCL 的自定义事件驱动。\n渲染器没有执行任何脚本。" />
        </StackPanel>
    </StackPanel>
</local:MyCard>
`;
