# Plain Craft Launcher (PCL) Homepage Viewer（第三方）

> 第三方独立作品，与 PCL 官方无关。
>
> 原作者：**龙腾猫跃** · 赞助链接：<https://meloong.com/afd/a/LTCat>
>
> PCL 仓库：<https://github.com/Meloong-Git/PCL> · 分发许可：<https://github.com/Meloong-Git/PCL/blob/main/LICENCE>

这是一个在浏览器里预览 PCL（Plain Craft Launcher 2）自定义主页 `Custom.xaml` 的工具。它按 PCL 的 850 × 500 窗口、300px 左侧栏、25px 页面边距、PCL 字体与主题色阶重绘画布，并实现 PCL 自定义事件在 Web 环境中的对应行为。

> 状态：可运行 · Node.js 18+ · 无需构建步骤 · 原创代码采用 MIT 许可（PCL 素材除外）

## 快速开始

需要 Node.js 18 或更高版本。

```powershell
cd HomepageViewer
node server.js
# 或 npm start
```

然后访问 <http://localhost:3000>。

不要直接双击 `index.html`：项目使用 ES Module、同源 `fetch` 与 `/api/proxy`，通过 `file://` 打开时浏览器会阻止这些请求。

## 功能

- **三种来源**：本地 `.xaml` 文件（拖拽或 Ctrl+O）、联网 URL、直接编辑 XAML 源码。
- **四个预设**：PCL 原版教程、控件画廊、事件测试台、替换标记示例。
- **1:1 PCL 外观**：850 × 500 窗口、48px 标题栏、300px 侧栏、8px 滚动条、500px 主页内容宽度、PCL English 字体、`ColorBrush1–8` 主题色阶、卡片/提示条/按钮/列表项的 PCL 尺寸与动画。
- **资源与样式**：支持 `StackPanel.Resources` 中的 `sys:String`、`Style` 与 `{StaticResource}` / `{DynamicResource}` 字符串引用，包含隐式样式、显式 `Style`、`BasedOn` 和 `Setter`。
- **FlowDocument**：支持 PCL 新闻主页使用的 `FlowDocumentScrollViewer` / `FlowDocument` / `Paragraph` / `List` / `ListItem` / `Section`，以及段落内的 `Run`、`Bold`、`Underline`、`TextBox` 行内代码和 `ContentControl` 分隔线。
- **PCL 自定义事件**：按钮、卡片、列表项、提示条和 `CustomEventCollection` 都会进入同一个顺序事件队列；支持变量与设置替换标记。
- **安全渲染**：XAML 通过 `DOMParser` 解析，只创建受控 DOM；不执行脚本、不加载 `x:Code`、不打开 `WebBrowser`，并过滤常见危险类型与成员。
- **联网代理**：`/api/proxy` 会附带 PCL 风格的 User-Agent / Referer，支持重定向、gzip / br / deflate，限制 4 MB 且只接受文本 / XAML 内容。
- **调试面板**：显示控件数量、渲染耗时、警告、事件日志、自定义变量；支持 Ctrl+Enter 渲染、全屏预览、导出当前 XAML。

## 支持的 XAML

### PCL 控件

`local:MyCard`、`local:MyHint`、`local:MyButton`、`local:MyTextButton`、`local:MyIconButton`、`local:MyIconTextButton`、`local:MyListItem`、`local:MyImage`、`local:MyLoading`，以及 `MyCheckBox` / `MyRadioBox` / `MyRadioButton` 的基础外观。

常用的 PCL 属性包括：`Title`、`Text`、`Info`、`Theme`、`ColorType`、`Logo`、`LogoScale`、`CanSwap`、`IsSwapped` / `IsSwaped`、`SwapLogoRight`、`UseAnimation`、`HasMouseAnimation`、`CanClose`、`RelativeSetup`、`IsWarn`、`Source`、`FallbackSource`、`LoadingSource`、`Stretch`、`Type`、`EventType`、`EventData`、`ToolTip`、`PaddingLeft`、`MinPaddingRight` 等。

### WPF 布局与绘图

`StackPanel`、`Grid`（含行列定义、`Grid.Row` / `Grid.Column` / Span）、`WrapPanel`、`Canvas`、`Border`、`ScrollViewer`、`Viewbox`、`TextBlock`（含 `Run` / `Bold` / `Italic` / `Underline` / `Span` / `Hyperlink` / `LineBreak`）、`Image`、`Path`、`Rectangle`、`Ellipse`、`Line`、`Polygon`、`Polyline`。

文档流控件：`FlowDocumentScrollViewer`、`FlowDocument`、`Paragraph`、`Section`、`List`、`ListItem`、`ContentControl`（分隔线模板）与行内代码 `TextBox`。

通用属性：`Width`、`Height`、`Min/MaxWidth`、`Min/MaxHeight`、`Margin`、`Padding`、`HorizontalAlignment`、`VerticalAlignment`、`Background`、`Foreground`、`Opacity`、`Visibility`、`IsEnabled`、`IsHitTestVisible`、`Cursor`、`FontSize`、`FontWeight`、`FontStyle`、`LineHeight`、`TextWrapping`、`TextTrimming`、`TextAlignment`、`CornerRadius`、`BorderThickness`、`BorderBrush`、`Panel.ZIndex` 等。

### 资源、样式与图片

- `{DynamicResource ColorBrush1}` … `{DynamicResource ColorBrush8}`、`ColorBrushGray1–8`、`ColorBrushRed*`、`ColorBrushWhite` 等映射到 CSS 变量。
- `StackPanel.Resources` / `*.Resources` 中带 `x:Key` 的 `sys:String`、`sys:Double`、`sys:Int32` 等值可被 `{StaticResource Key}` / `{DynamicResource Key}` 引用；`Logo="{StaticResource LaunchIcon}"` 这类路径数据也会正常解析。
- 支持 `Style` 的隐式样式（无 `x:Key`，按 `TargetType` 匹配）、显式 `Style="{StaticResource Key}"`、`BasedOn` 与普通 `Setter`。页面级样式会参与布局、字体、颜色、边距和按钮 `EventType` 等属性。
- `pack://application:,,,/images/...` 会映射到 `assets/pcl/images/`，且大小写不敏感（例如 `Cobblestone.png` 可匹配 `CobbleStone.png`）。
- 支持 `http(s)`、`data:`、`blob:` 与本地相对路径图片；远程图片使用 `no-referrer` 请求，减少防盗链导致的 403。

## 替换标记

| 标记 | 含义 |
| --- | --- |
| `{variable:Name}` | 自定义变量；不存在时为空 |
| `{variable:Name:Default}` | 自定义变量；不存在时使用默认值 |
| `{setup:Key}` | PCL 设置；内置默认值包括 `UiLauncherHue`、`UiLauncherTheme` 等 |
| `{hint}` | 随机“你知道吗”提示 |
| `{cave}` | 随机回响洞文本 |
| `{user}` / `{uuid}` / `{login}` | 当前演示用户信息 |

替换在 XML 解析之前完成，插入的值会做 XML 转义，因此也可以安全地放进属性（例如 `Visibility="{variable:Flag:Visible}"`）。

## 自定义事件

事件通过 `EventType` / `EventData` 属性，或嵌套的 `local:CustomEventService.Events` 声明。多个事件会按声明顺序执行。

| 事件 | 网页版行为 |
| --- | --- |
| `打开网页` | 新标签页打开 `http(s)` 地址；被弹窗拦截时提供复制地址 |
| `弹出窗口` | 显示 PCL 风格弹窗（标题 / 内容 / 按钮） |
| `弹出提示` | 显示 PCL 底部渐变色提示条，支持 Blue / Green / Red / Yellow |
| `复制文本` | 写入剪贴板；需要浏览器允许剪贴板权限 |
| `刷新主页` / `刷新页面` | 重新解析并渲染当前主页 |
| `修改变量` / `写入变量` | 写入 `localStorage`，刷新后参与替换标记 |
| `修改设置` / `写入设置` | 写入设置；`UiLauncherHue` 会按 PCL 色阶重绘预览画布 |
| `切换页面` | 切换到对应的 PCL 占位页（下载、联机、设置等） |
| `今日人品` | 按日期与用户名生成确定性的模拟结果 |
| `内存优化` / `清理垃圾` | 显示“已模拟执行”提示 |
| `启动游戏` | 显示浏览器限制说明（不会真正启动 Minecraft） |
| `打开文件` / `执行命令` | 显示限制说明，可复制路径（不会执行程序） |
| `导入整合包` / `安装整合包` | 选择文件后显示限制说明 |
| `下载文件` | 先显示确认弹窗，再交给浏览器下载 |
| `打开帮助` | 显示说明，可选择打开 PCL 帮助文档库 |
| `加入房间` | 显示限制说明，可复制房间信息 |
| `检查更新` | 显示说明，可选择打开 PCL 下载页 |
| `刷新帮助` | 显示“已刷新”提示 |

浏览器无法真正启动进程、写剪贴板（无权限时）、启动游戏或调用 PCL 内部页面；这些操作会给出与 PCL 风格一致的说明，而不是静默失败。

## 主题色说明

工具外壳（左侧控制面板、标题、背景）始终保持 PCL 蓝色，不提供外壳主题解锁。主页源码中的 `{setup:UiLauncherHue}` 与 `修改设置 UiLauncherHue|<数值>` 只会重绘 850 × 500 的 PCL 预览画布，用来检查自定义主页在 PCL 不同色相下的外观。色阶按 PCL 的 `MyColor.FromHSL2` 亮度补偿公式计算；210° 使用 PCL 公布的 `ColorBrush` 表。

## 安全边界

- 不执行 JavaScript、VBScript、`x:Code`、`x:Static`、`ObjectDataProvider`、`XamlReader`、`WebBrowser`、`Frame` 等。
- 链接只允许 `http` / `https` / `mailto`；`打开网页` 与 `下载文件` 会校验协议。
- `/api/proxy` 是本地开发代理，**没有 SSRF 防护**；不要把它暴露到公网，也不要在不可信网络中长期运行。
- 远程图片由浏览器直接加载，可能受目标站点的证书、CORS 或防盗链策略影响。

## 已知限制

- 样式只实现 `Setter` 与 `BasedOn`；`Trigger`、`DataTemplate`、`ItemsControl`、`ControlTemplate`（`ContentControl` 分隔线除外）尚未实现。
- 不支持脚本、WPF 动画时间线、3D、媒体与自定义控件。
- 不支持 PCL 内部的完整页面（下载、联机、设置等），只提供占位页。
- `修改设置` 目前只应用 `UiLauncherHue`；透明度、背景模糊等设置会保存并参与 `{setup:...}`，但不会改变渲染外观。
- 文本换行、字体度量与 WPF 不是逐像素完全相同；已对齐主要尺寸、边距、颜色与字号。
- 远程主页中的相对图片路径不会自动按远程 URL 解析。

## 项目结构

```text
index.html                 工具外壳 + 850 × 500 PCL 预览
css/pcl-theme.css          PCL 窗口、标题栏、侧栏、滚动条、提示、弹窗
css/xaml.css               XAML 控件样式
css/app.css                工具外壳与响应式布局
js/app.js                  来源管理、预设、渲染流程、快捷键
js/xaml.js                 XAML 解析、替换标记、安全过滤
js/renderer.js             WPF / PCL 控件到 DOM 的渲染器
js/runtime.js              自定义事件引擎
js/shell.js                窗口控制、导航、弹窗队列、提示、事件日志
js/theme.js                PCL HSL 色阶计算
js/assets.js               由脚本生成的 pack:// 图片映射
assets/pcl/                PCL 图片、图标与字体
assets/presets/            教程 / 画廊 / 事件 / 提示预设
server.js                  静态服务器 + 文本代理
tools/generate-assets.mjs  重新生成 js/assets.js
```

重新生成图片映射：

```powershell
node tools/generate-assets.mjs
```

## 致谢

- **龙腾猫跃**：PCL / Plain Craft Launcher 2 的作者，本项目使用了 PCL 的界面素材、字体与视觉规范。
- **Light-Beacon/PCL2-NewsHomepage**：新闻主页的兼容性测试参考；本项目未内置该主页源码。
- 所有为 PCL 与相关生态做出贡献的开发者。

## 贡献

欢迎提交 Issue 或 Pull Request。提交前请：

1. 运行 `npm start`，确认四个预设均可正常渲染；
2. 检查浏览器控制台无新增错误；
3. 不要提交 PCL 官方未公开素材、账号凭据或本地缓存；
4. 保持 PCL 风格的尺寸、颜色与事件语义。

## 许可证与署名

本项目是第三方基于 PCL 独立进行的二次创作，与 PCL 官方无关，也未获得 PCL 官方背书。

### 原创代码

本项目中由 WorldHim 编写的源代码与文档采用 **MIT License**，详见 [LICENSE](LICENSE)。

### PCL 素材与衍生内容

项目复制了 PCL 仓库中的界面图片与字体用于视觉预览。这些素材、PCL 名称与相关衍生内容不适用 MIT 许可，仍遵循 PCL 的分发有限许可，详见 [LICENCE-PCL.md](LICENCE-PCL.md)。

使用、分发或修改前请阅读 `LICENCE-PCL.md`，并保留对**龙腾猫跃**的署名与赞助链接。若 `LICENSE` 与 `LICENCE-PCL.md` 在 PCL 相关素材上存在冲突，以 `LICENCE-PCL.md` 为准。

### 第三方名称

Plain Craft Launcher、PCL 及相关名称、图标的权利归其各自权利人所有。本项目名称中的 “PCL” 仅用于说明兼容目标，不代表官方关联。
