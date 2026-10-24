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

然后访问 <http://localhost:3000>。服务器默认只监听 `127.0.0.1`；需要从局域网访问时，显式监听所有网卡：

```powershell
$env:HOST = "0.0.0.0"; node server.js
```

请只在可信网络中使用 `HOST=0.0.0.0`。

不要直接双击 `index.html`：项目使用 ES Module、同源 `fetch` 与 `/api/proxy`，通过 `file://` 打开时浏览器会阻止这些请求。

## 自动化测试

测试使用本地 `server.js` 和已安装的 Edge / Chrome，通过 CDP pipe 运行，不需要额外 npm 依赖。浏览器回归除了工具外壳，还会导航到 `home.html` 单独检查独立主页页（1:1 几何、适应宽度不改布局、事件与弹窗、来源复用、失败提示）。

```powershell
npm test              # Node 单元测试 + 浏览器回归
npm run test:unit     # 仅运行 Node 单元测试（xaml / theme / help / URL / 代理策略）
npm run test:presets  # PCL 25 个预设批量验收（需要联网，4 路并发）
npm run test:all      # 单元测试 + 浏览器回归 + 预设验收
npm run lint          # ESLint 静态检查
npm run format:check  # Prettier 格式检查
```

如果浏览器不在常见路径，可设置：

```powershell
$env:PCL_TEST_BROWSER = "C:\Program Files\Google\Chrome\Application\chrome.exe"
npm test
```

批量验收会把结果写入 `test-results/preset-audit.json`。已知上游不可用或按安全规则拦截的预设不会导致失败；其他渲染错误、未支持控件或意外状态变化会返回非零退出码。

## 部署到静态托管

可以以前端静态方式部署到 GitHub Pages、Netlify、Vercel。核心渲染、四个内置预设、本地文件与源码编辑都不依赖后端；PCL2 在线预设与“联网 URL”一样，需要可用的 `/api/proxy`。Vercel 与 Netlify 都会自动提供这个同源代理，GitHub Pages 是纯静态托管，只能访问允许 CORS 的源。

```powershell
npm run build
# 输出目录：dist/
# 构建会基于源文件内容生成统一 build id，并自动写入 dist 中的 HTML/JS/CSS 引用
```

| 平台             | 配置                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **GitHub Pages** | 仓库 **Settings → Pages → Source → GitHub Actions**。推送到 `main` 后由 `.github/workflows/deploy-pages.yml` 自动构建 `dist/` 并部署。项目使用相对路径，支持 `https://<user>.github.io/<repo>/` 子路径。                       |
| **Netlify**      | 导入仓库即可；`netlify.toml` 已配置 `npm run build`、发布目录 `dist/`、函数目录 `netlify/functions` 与 `/api/proxy` 重写。                                                                                                     |
| **Vercel**       | 导入仓库即可；`vercel.json` 已配置 `framework: null`（避免把本地 `server.js` 误识别为 Node/Express 应用）、构建命令、`dist/` 输出目录和 `api/proxy.js` 的 30 秒执行时间。Vercel 会自动把 `api/proxy.js` 部署为 Node Function。 |

静态部署的限制：

- 没有服务端函数时，联网标签页会改为浏览器直接 `fetch`，目标站点必须返回允许跨域的响应头（如 `Access-Control-Allow-Origin: *`），例如 `raw.githubusercontent.com`。
- 像 `https://news.bugjump.net/` 这类没有开放 CORS 的地址，在 GitHub Pages 纯静态站点中无法加载；请运行 `node server.js`，或使用带代理的部署。
- **Vercel 与 Netlify**：仓库已包含代理实现（`api/proxy.js` 与 `netlify/functions/proxy.mjs`），部署后会自动生成同源 `/api/proxy`，因此可以加载未开放 CORS 的新闻主页。前端会优先使用它。
- GitHub Pages 若仓库为私有，需要对应账号计划支持 Pages；公开仓库通常可直接使用。

### Vercel 导入配置

导入仓库后，Vercel 可能把根目录的 `server.js` 自动识别为 Express / Node 应用。请在 **Configure Project** 或 **Settings → Build & Development Settings** 中手动填写：

| 配置项                           | 填写值           | 说明                                                                                         |
| -------------------------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| **Framework Preset**（框架预设） | `Other`          | 不要选择 Express、Node.js 或自动识别结果；否则 `server.js` 会被当成 Function，静态页面会 404 |
| **Root Directory**（根目录）     | 留空 / `./`      | 必须是包含 `package.json`、`index.html` 和 `api/` 的仓库根目录                               |
| **Build Command**（构建命令）    | `npm run build`  | 执行 `tools/build-static.mjs`，生成 `dist/`                                                  |
| **Output Directory**（输出目录） | `dist`           | 不要填 `public`、`.` 或留空                                                                  |
| **Install Command**（安装命令）  | `npm install`    | 保持默认即可；项目没有运行时依赖                                                             |
| **Node.js Version**              | `20.x` 或 `22.x` | 项目要求 Node.js 18+；20 / 22 均可                                                           |
| **Functions**                    | 不需要手动添加   | `api/proxy.js` 会被自动识别为 `/api/proxy`                                                   |

常见错填：

- **Framework Preset** 选成 `Express` / `Node.js`，或保留自动识别结果
- **Build Command** 填成 `npm start` / `node server.js`
- **Output Directory** 填成 `public`、`.` 或留空
- **Root Directory** 填成 `api` 或 `dist`

`vercel.json` 已经包含同样的配置：

```json
{
  "framework": null,
  "buildCommand": "npm run build",
  "outputDirectory": "dist"
}
```

Vercel 面板中的值会覆盖 `vercel.json`，所以两边最好保持一致。修改后必须点击 **Redeploy**，只刷新页面不会应用新的构建配置。

构建日志中应能看到：

```text
Static site built to dist
```

部署完成后检查：

```text
/                         → 200
/index.html               → 200
/assets/presets/...       → 200
/api/proxy?url=...        → 200
/api/health               → 404（正常，旧 server.js 路由不再部署）
```

如果仍然出现 `NOT_FOUND`，请按下面的“Vercel 显示 NOT_FOUND”一节排查。

### Netlify 配置

Netlify 导入仓库后填写：

| 配置项                  | 填写值                                                 |
| ----------------------- | ------------------------------------------------------ |
| **Base directory**      | 留空                                                   |
| **Build command**       | `npm run build`                                        |
| **Publish directory**   | `dist`                                                 |
| **Functions directory** | `netlify/functions`（`netlify.toml` 已声明，留空即可） |

Netlify 现在也包含 `/api/proxy`：`netlify/functions/proxy.mjs` 把 Netlify 的函数入口适配到与 Vercel 相同的 `api/proxy.js`（Functions 2.0 的 `Request`/`Response` 与 Functions 1.0 的 event → `{statusCode, body}` 两种形态都支持，二进制响应自动转 base64），`netlify.toml` 再用一条 `force` 重写把 `/api/proxy` 指过去。因此联网主页、PCL2 在线预设和远程图片在 Netlify 上与 Vercel 行为一致，同样受 `PCL_PROXY_ALLOWLIST` / `PCL_PROXY_UA` 环境变量约束（在 **Site configuration → Environment variables** 中设置）。

Netlify 的函数默认在 `cmh`（美国俄亥俄）；如果你的读者主要在亚洲，可以在 **Project configuration → Functions → Region** 改成 `sin`、`nrt` 等更近的区域后重新部署。

### Netlify 环境变量

与 Vercel 相同的两个变量，在 **Site configuration → Environment variables** 中添加：

| 变量                  | 是否必填 | 示例                                         |
| --------------------- | -------- | -------------------------------------------- |
| `PCL_PROXY_ALLOWLIST` | 建议     | `news.bugjump.net,raw.githubusercontent.com` |
| `PCL_PROXY_UA`        | 可选     | `PCL2-Homepage-Viewer`                       |

### Vercel 环境变量

在 **Settings → Environment Variables** 中添加（Production 和 Preview 都建议设置）：

| 变量                  | 是否必填 | 示例                                         |
| --------------------- | -------- | -------------------------------------------- |
| `PCL_PROXY_ALLOWLIST` | 建议     | `news.bugjump.net,raw.githubusercontent.com` |
| `PCL_PROXY_UA`        | 可选     | `PCL2-Homepage-Viewer`                       |

设置白名单后，只有列表中的域名（及其子域名）能通过 `/api/proxy`；如果只填 `news.bugjump.net`，示例 GitHub 地址会被拒绝。修改变量后需要重新部署。

### 最近提交时间

启动页底部显示的是**构建时的最近提交**，不再是固定的演示时间。数据来源按顺序尝试：

1. 构建时生成的 `commit.json`（`npm run build` 自动写入 `dist/`）
   - Vercel、Netlify、GitHub Pages 都优先读取这个文件
   - 显示的是当次部署对应的 commit，重新部署后更新
2. 仅本地 `node server.js` 且没有 `commit.json` 时，调用同源 `/api/latest-commit` 读取当前目录的 `git log -1`

Vercel 线上不会请求 GitHub API，也不需要配置 GitHub Token。页面每 10 分钟刷新一次提交信息，并每分钟更新“几分钟前”等相对时间；悬停可以看到完整时间与短 SHA。

如果构建环境没有可用的 git 历史，构建会跳过 `commit.json`，页面会显示“获取失败”。Vercel 的正常 Git 构建会自动生成该文件。

### Vercel 代理（`api/proxy`）

`api/proxy.js` 是一个无依赖的 Node Function，和前端同源，前端无需配置额外地址：

```text
GET /api/proxy?url=https%3A%2F%2Fnews.bugjump.net%2F&ua=PCL2-Homepage-Viewer
```

默认 UA 是 `PCL2-Homepage-Viewer`，可以在联网面板中修改，也可以直接通过 `ua` 查询参数指定。它会：

- 使用指定的 User-Agent（最多 512 个可打印 ASCII 字符），默认 `PCL2-Homepage-Viewer`；
- 附带 PCL 风格的 Referer；
- 跟随最多 5 次重定向；
- 限制 25 秒超时、4 MB 响应体；
- 只接受文本 / XML / XAML，拒绝 HTML；
- 拒绝本机、内网、保留地址和非 80 / 443 端口，降低 SSRF 风险。

公开部署时建议设置环境变量限制目标域名：

```text
PCL_PROXY_ALLOWLIST=news.bugjump.net,raw.githubusercontent.com
PCL_PROXY_UA=PCL2-Homepage-Viewer
```

`ua` 参数为空或未提供时，代理会使用 `PCL_PROXY_UA`；该环境变量未设置时使用默认值 `PCL2-Homepage-Viewer`。查询参数优先于环境变量。

不设置白名单时允许访问任意公网 HTTP(S) 文本地址。它仍然是一个出站代理，公开运行时请按需增加平台限流；不要把代理用作通用开放代理。

Vercel 会在 `vercel.json` 的 `functions` 中读取 `api/proxy.js` 的 `maxDuration`；Netlify 通过 `netlify/functions/proxy.mjs` 复用同一份代码。GitHub Pages 是纯静态托管，不包含这个函数。

#### 失败状态为什么放在响应头里

Cloudflare 之类的 CDN 会把源站返回的任何 5xx 换成自己的通用错误页，`api/proxy` 给出的真实原因（上游 404、DNS 失败、超时……）就丢失了，前端还会误判成“没有可用的 `/api/proxy`”。所以文本代理失败时：

- HTTP 状态固定为 **200**，真实状态放在 **`X-PCL-Proxy-Status`**（例如 `502`、`504`）；
- 响应体仍是可读的失败原因；
- 4xx（缺参数、端口不允许、UA 非法）保持原状态码；
- `image=1` 图片模式**保留真实 4xx/5xx**，否则 `<img>` 会把文本当成图片解码。

前端在 `js/app/remote.js` 里先读这个响应头，再回退到 `response.ok`，因此本地 `node server.js`、Vercel、以及任何经过 CDN 的部署行为一致。仓库外的 `server.js` 使用同一个 `proxyFailure()`。

### Vercel 显示 `NOT_FOUND`

如果 `/api/proxy` 可用，但 `/`、`/index.html` 和静态资源都是 404，通常是因为 Vercel 把仓库根目录的 `server.js` 自动识别成了 Express / Node 应用：

- `server.js` 被作为单个 Function 部署，`/api/health`、`/` 等路由由它处理；
- `express.static()` 或自定义静态服务不会从 `dist` 提供文件；
- 因此页面根路径返回 `Not Found`。

仓库中的 `vercel.json` 已设置：

```json
{
  "framework": null,
  "buildCommand": "npm run build",
  "outputDirectory": "dist"
}
```

请确认 Vercel 项目的 **Settings → Build & Development Settings**：

```text
Framework Preset: Other
Build Command: npm run build
Output Directory: dist
Root Directory: 留空
```

修改后执行一次 **Redeploy**。如果项目仍然缓存了 Express 预设，建议在 Vercel 中重新导入仓库，或在设置中手动切换为 Other 后再部署。

## 功能

- **三种来源**：本地 `.xaml` 文件（拖拽或 Ctrl+O）、联网 URL、直接编辑 XAML 源码。
- **四个内置预设**：PCL 原版教程、控件画廊、事件测试台、替换标记示例。
- **PCL2 预设面板**：接入 PCL2 启动器内置的 25 个主页预设，支持搜索名称 / 域名，标注“通常可用 / 上游可能不可用 / 会被安全阻止”；在线项优先使用 `PCL2/2.99.0.0` UA，并在内存中缓存，刷新按钮可强制重新拉取。
- **1:1 PCL 外观**：850 × 500 窗口、48px 标题栏、300px 侧栏、8px 滚动条、500px 主页内容宽度、PCL English 字体、`ColorBrush1–8` 主题色阶、卡片/提示条/按钮/列表项的 PCL 尺寸与动画。
- **跨浏览器滚动条**：Chromium 使用 8px WebKit 滚动条，Firefox 使用标准 `scrollbar-width: thin` / `scrollbar-color`，保持透明轨道和半透明滑块。
- **四档界面外观**：右上角可切换「跟随系统 / 浅色 / 深色 / AMOLED」，选择保存在 `localStorage`（`pcl.lab.appearance.v1`）。各档只改变工具外壳与画布的衬底，画布内渲染的 XAML 完全一致；深色的两档都会把 850 × 500 画布压到 90% 亮度（`--appearance-dim`），避免白底卡片在暗环境里刺眼。默认跟随系统，第一次打开就与系统一致。
  - **跟随系统**：由 `prefers-color-scheme` 决定用浅色还是深色，系统在日落后切换时会跟着变；更动系统偏好不会覆盖手选的档位。首帧就按系统解析（`js/boot-theme.js`），不会先闪一下浅色再变暗。
  - **深色**：画布是主角。外壳保留冷色光晕、玻璃托底、1px 发丝描边与中等落影，截图或投屏时画布与外壳是一个整体。
  - **AMOLED**：画布是画面里唯一亮的东西。去掉光晕、玻璃与落影，页面底色压到近黑（`#05070a`），只留一圈极淡描边，夜里不干扰阅读。
  - **键盘**：方向键按「跟随系统 → 浅色 → 深色 → AMOLED → 跟随系统」循环，`Home` / `End` 跳到首尾。
- **静态资源优化**：favicon 仅保留 16 / 32 / 48 三个 32bpp 帧，`LogoHex.png` 按 2× 显示尺寸输出为 64 × 72 PNG，减少首屏资源体积。
- **资源与样式**：支持 `StackPanel.Resources` 中的 `sys:String`、`Style` 与 `{StaticResource}` / `{DynamicResource}` 字符串引用，包含隐式样式、显式 `Style`、`BasedOn` 和 `Setter`。
- **FlowDocument**：支持 PCL 新闻主页使用的 `FlowDocumentScrollViewer` / `FlowDocument` / `Paragraph` / `List` / `ListItem` / `Section`，以及段落内的 `Run`、`Bold`、`Underline`、`TextBox` 行内代码和 `ContentControl` 分隔线；分隔线文字会按内容伸展并自动换行，不再截成省略号。
- **WPF 行高语义**：遵循默认 `LineStackingStrategy="MaxHeight"`，行框取 `LineHeight` 与字体实际行高的较大值，避免上游 `LineHeight="12"` 配 `FontSize="14"` 时文字重叠；显式 `BlockLineHeight` 仍严格使用指定值。
- **GroupBox 模板语义**：PCL 没有覆盖 `GroupBox` 样式，因此按 WPF Aero2 模板渲染——左右与底部各 6px、Header 跨两行、`BorderGapMaskConverter` 在标题处挖掉框线（缺口从 7px 开始、宽度为 Header 宽度、高度为框高的一半，所以标题坐在框线断口上）、三层嵌套边框（白 / `BorderBrush` / 白）、`Padding` 作为内容周围的外边距、`BorderThickness` 同时作用于三层边框；无模板时文本沿用 PCL 全局 13px / 1.1509em 行高。
- **PCL 自定义事件**：按钮、卡片、列表项、提示条和 `CustomEventCollection` 都会进入同一个顺序事件队列；支持 PCL 标准替换标记。
- **PCL 帮助页导航**：`打开帮助` 指向远程帮助 JSON 时，会加载同目录同名 `.xaml`，并按 PCL 的 `PageOtherHelpDetail` 方式替换整个页面内容区；标题栏切换为“返回 + 帮助标题”，侧栏隐藏，支持多级进入、逐级返回和返回主页。
- **安全渲染**：XAML 通过 `DOMParser` 解析，只创建受控 DOM；不执行脚本、不加载 `x:Code`、不打开 `WebBrowser`，并过滤常见危险类型与成员。
- **联网代理**：运行 `node server.js` 时使用本地 `/api/proxy`；部署到 Vercel 时自动使用 `api/proxy.js`。代理默认 UA 为 `PCL2-Homepage-Viewer`，可通过联网面板、`ua` 参数或 `PCL_PROXY_UA` 环境变量自定义；同时附带 PCL 风格 Referer，支持重定向、gzip / br / deflate，限制 4 MB；文本模式只接受文本 / XAML，`image=1` 模式只接受图片。纯静态部署自动回退到 CORS 直连。
- **远程图片**：远程图片先直连，失败后自动通过 `/api/proxy?image=1` 代理加载，避免 CORP、防盗链等浏览器限制；静态部署没有代理时仍会回退到直连。远程图片默认使用原生 `loading="lazy"` 和 `decoding="async"`，长帮助页和新闻主页会减少首屏请求；测试环境会切换为 eager，避免离屏测试等待懒加载。
- **UA 自动回退**：联网主页或远程图片代理请求失败、返回 HTML/JSON 等非 XAML 内容时，会自动使用 `PCL2/2.99.0.0` 再尝试一次；自定义 UA 始终优先。
- **联网 URL 替换标记**：联网地址会在请求前解析 `{variable:...}`、`{setup:...}` 以及 PCL 版本、日期、实例等标记，例如 `https://weather-p.kaphia.top/{variable:PCLDailyWeatherPage:choose}.xaml`；输入框仍保留原始模板。
- **非 XAML 响应校验**：联网地址返回空内容、JSON、HTML 或纯文本时会直接报错，不再渲染为空白页。
- **调试面板**：显示控件数量、渲染耗时、警告、事件日志、自定义变量；底部事件条会完整显示 EventData 并自动换行，不再截断长日志；支持 Ctrl+Enter 渲染、全屏预览、导出当前 XAML。
- **弹窗无障碍**：弹窗打开时会锁定背景区域的 `inert`，Tab / Shift+Tab 在弹窗按钮间循环，关闭动画结束后恢复背景并回到原焦点；弹窗通过 `aria-describedby` 关联正文。
- **版本与账户记忆**：窗口内切换的演示版本和 Steve / Alex 账户会保存到 `localStorage`（`pcl.lab.shell.v1`），下次打开自动恢复；存储不可用或数据损坏时回退默认值。
- **独立主页页**：`home.html` 只画 PCL 右侧那块面板——550px 面板、25px 页边距、500px 内容列、8px 滚动条，没有工具外壳，适合把主页投出去或单独查看。默认 1:1（与预览器逐像素一致，只有窗口窄于 550px 时才等比缩小），工具栏的「适应宽度」用 CSS `zoom` 把整块面板放大到窗口宽度：`zoom` 只缩放像素尺寸、不改布局，所以折行位置、卡片高度与图片裁切都和 1:1 一致（上限 3 倍）。它读取与预览器同一个 `localStorage`（`pcl.lab.source.v1`），在另一个标签页切换来源时会跟着刷新；外观沿用 `pcl.lab.appearance.v1`，页面内不提供切换按钮。PCL 的弹窗、提示、复制、下载、打开网页等事件在这里都有对应实现，只有「切换页面 / 打开帮助」因为没有其他页面而退化成提示。

## 支持的 XAML

### PCL 控件

`local:MyCard`、`local:MyHint`、`local:MyButton`、`local:MyTextButton`、`local:MyIconButton`、`local:MyIconTextButton`、`local:MyListItem`、`local:MyImage`、`local:MyLoading`，以及 `MyCheckBox` / `MyRadioBox` / `MyRadioButton` 的基础外观。

常用的 PCL 属性包括：`Title`、`Text`、`Info`、`Theme`、`ColorType`、`Logo`、`LogoScale`、`CanSwap`、`IsSwapped` / `IsSwaped`、`SwapLogoRight`、`UseAnimation`、`HasMouseAnimation`、`CanClose`、`RelativeSetup`、`IsWarn`、`Source`、`FallbackSource`、`LoadingSource`、`Stretch`、`Type`、`EventType`、`EventData`、`ToolTip`、`PaddingLeft`、`MinPaddingRight` 等。

### WPF 布局与绘图

`StackPanel`、`Grid`（含行列定义、`Grid.Row` / `Grid.Column` / Span）、`UniformGrid`（`Rows` / `Columns` / `FirstColumn`）、`WrapPanel`、`Canvas`、`Border`、`ScrollViewer`、`Viewbox`、`GroupBox`（含 `HeaderTemplate` / `ContentTemplate` 文本模板）、`TextBlock`（含 `Run` / `Bold` / `Italic` / `Underline` / `Span` / `Hyperlink` / `LineBreak`）、`Image`、`Path`、`Rectangle`、`Ellipse`、`Line`、`Polygon`、`Polyline`。

文档流控件：`FlowDocumentScrollViewer`、`FlowDocument`、`Paragraph`、`Section`、`List`、`ListItem`、`ContentControl`（分隔线模板）与行内代码 `TextBox`。

通用属性：`Width`、`Height`、`Min/MaxWidth`、`Min/MaxHeight`、`Margin`、`Padding`、`HorizontalAlignment`、`VerticalAlignment`、`Background`、`Foreground`、`Opacity`、`Visibility`、`IsEnabled`、`IsHitTestVisible`、`Cursor`、`FontSize`、`FontWeight`、`FontStyle`、`LineHeight`、`TextWrapping`、`TextTrimming`、`TextAlignment`、`CornerRadius`、`BorderThickness`、`BorderBrush`、`Panel.ZIndex` 等。

`Rectangle` / `Ellipse` 支持 `Fill` 属性，以及 `Rectangle.Fill` 属性元素中的 `SolidColorBrush`、`LinearGradientBrush` 和 `RadialGradientBrush`。`local:MyCard` 的直接子元素与 PCL 一致按 Grid 叠放，使用 `Margin` 定位；文本、按钮等正文内容会按自然高度自动避让，避免上游 `Margin` 造成的纵向重叠。

### 资源、样式与图片

- `{DynamicResource ColorBrush1}` … `{DynamicResource ColorBrush8}`、`ColorBrushGray1–8`、`ColorBrushRed*`、`ColorBrushWhite` 等映射到 CSS 变量。
- `StackPanel.Resources` / `*.Resources` 中带 `x:Key` 的 `sys:String`、`sys:Double`、`sys:Int32` 等值可被 `{StaticResource Key}` / `{DynamicResource Key}` 引用；`Logo="{StaticResource LaunchIcon}"` 这类路径数据也会正常解析。
- 支持 `Style` 的隐式样式（无 `x:Key`，按 `TargetType` 匹配）、显式 `Style="{StaticResource Key}"`、`BasedOn` 与普通 `Setter`。页面级样式会参与布局、字体、颜色、边距和按钮 `EventType` 等属性。
- `pack://application:,,,/images/...` 会映射到 `assets/pcl/images/`，且大小写不敏感（例如 `Cobblestone.png` 可匹配 `CobbleStone.png`）。
- 支持 `http(s)`、`data:`、`blob:` 与本地相对路径图片；远程图片使用 `no-referrer` 请求，减少防盗链导致的 403。

## 替换标记

| 标记                                                   | 含义                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `{variable:Name}`                                      | 自定义变量；不存在时为空                                       |
| `{variable:Name:Default}`                              | 自定义变量；不存在时使用默认值                                 |
| `{setup:Key}`                                          | PCL 设置；内置默认值包括 `UiLauncherHue`、`UiLauncherTheme` 等 |
| `{hint}`                                               | 随机“你知道吗”提示                                             |
| `{cave}`                                               | 随机“回声洞”文本                                               |
| `{user}` / `{uuid}` / `{login}`                        | 当前演示用户信息                                               |
| `{pcl_version}`                                        | PCL 版本名，当前为 `2.99.0.0`                                  |
| `{pcl_version_code}`                                   | PCL 版本号，当前为 `414`                                       |
| `{pcl_version_branch}`                                 | 版本类型，当前为 `快照版`                                      |
| `{pcl_build_type}`                                     | 构建类型，当前为 `Snapshot`                                    |
| `{pcl_branch}`                                         | 代码分支，当前为 `OpenSource`                                  |
| `{identify}`                                           | 设备识别码；网页版固定为 `0000-0000-0000-0000`                 |
| `{date}` / `{time}`                                    | 当前本地日期 `yyyy/M/d` 与时间 `HH:mm:ss`                      |
| `{path}` / `{path_with_name}` / `{path_temp}`          | 模拟的 PCL 主目录、程序路径和缓存目录                          |
| `{pcl_md5}` / `{pcl_sha1}`                             | PCL 可执行文件哈希；网页版没有本地文件，返回空值               |
| `{java}`                                               | 模拟的 Java 目录                                               |
| `{minecraft}`                                          | 模拟的 `.minecraft` 目录                                       |
| `{version_path}` / `{verpath}`                         | 当前版本目录                                                   |
| `{version_indie}` / `{verindie}`                       | 当前版本隔离目录                                               |
| `{name}` / `{version}`                                 | 当前实例名与原版版本号                                         |
| `{forge}` / `{fabric}` / `{neoforge}` / `{liteloader}` | 当前实例的加载器版本；没有则为空                               |

替换在 XML 解析之前完成，插入的值会做 XML 转义，因此也可以安全地放进属性（例如 `Visibility="{variable:Flag:Visible}"`）。联网 URL 使用不转义的替换值，便于把变量放入地址。

路径、Java 和识别码使用网页演示值，不会访问或暴露本机文件系统；`{pcl_md5}` / `{pcl_sha1}` 也不会有真实哈希。

## 自定义事件

事件通过 `EventType` / `EventData` 属性，或嵌套的 `local:CustomEventService.Events` 声明。多个事件会按声明顺序执行。

| 事件                        | 网页版行为                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `打开网页`                  | 新标签页打开 `http(s)` / `mailto:` 链接，以及 PCL 支持的 `minecraft://` / `minecraft-preview://`；被弹窗拦截时提供复制地址，非法协议会直接拒绝 |
| `弹出窗口`                  | 显示 PCL 风格弹窗（标题 / 内容 / 按钮）                                                                                                        |
| `弹出提示`                  | 显示 PCL 底部渐变色提示条，支持 Blue / Green / Red / Yellow                                                                                    |
| `复制文本`                  | 写入剪贴板；需要浏览器允许剪贴板权限                                                                                                           |
| `刷新主页` / `刷新页面`     | 重新解析并渲染当前主页                                                                                                                         |
| `修改变量` / `写入变量`     | 写入 `localStorage`，刷新后参与替换标记                                                                                                        |
| `修改设置` / `写入设置`     | 写入设置；`UiLauncherHue` 会按 PCL 色阶重绘预览画布                                                                                            |
| `切换页面`                  | 切换到对应的 PCL 占位页（下载、联机、设置等）                                                                                                  |
| `今日人品`                  | 按日期与用户名生成确定性的模拟结果                                                                                                             |
| `内存优化` / `清理垃圾`     | 显示“已模拟执行”提示                                                                                                                           |
| `启动游戏`                  | 显示浏览器限制说明（不会真正启动 Minecraft）                                                                                                   |
| `打开文件` / `执行命令`     | 显示限制说明，可复制路径（不会执行程序）                                                                                                       |
| `导入整合包` / `安装整合包` | 选择文件后显示限制说明                                                                                                                         |
| `下载文件`                  | 先显示确认弹窗，再交给浏览器下载                                                                                                               |
| `打开帮助`                  | 远程 PCL 帮助 JSON / XAML 会在 PCL 窗口内以子页面打开，支持多级进入、返回与标题栏返回按钮；本地内置帮助仍显示说明并可打开 PCL 帮助文档库       |
| `加入房间`                  | 显示限制说明，可复制房间信息                                                                                                                   |
| `检查更新`                  | 显示说明，可选择打开 PCL 下载页                                                                                                                |
| `刷新帮助`                  | 显示“已刷新”提示                                                                                                                               |

浏览器无法真正启动进程、写剪贴板（无权限时）、启动游戏或调用 PCL 内部页面；这些操作会给出与 PCL 风格一致的说明，而不是静默失败。

## 主题色说明

工具外壳（左侧控制面板、标题、背景）默认使用 PCL 蓝色，可切换为「深色 / AMOLED」两种深色外观，也可选「跟随系统」由系统偏好决定（见「功能」）。主页源码中的 `{setup:UiLauncherHue}` 与 `修改设置 UiLauncherHue|<数值>` 只会重绘 850 × 500 的 PCL 预览画布，用来检查自定义主页在 PCL 不同色相下的外观。色阶按 PCL 的 `MyColor.FromHSL2` 亮度补偿公式计算；210° 使用 PCL 公布的 `ColorBrush` 表。

## 安全边界

- 不执行 JavaScript、VBScript、`x:Code`、`x:Static`、`ObjectDataProvider`、`XamlReader`、`WebBrowser`、`Frame` 等。
- 页面使用严格 CSP：脚本、样式和字体只允许同源资源。首帧外观恢复脚本放在 `js/boot-theme.js`，启动兜底脚本已放到 `js/boot.js`，页面没有内联脚本或内联样式；远程图片和 XAML 直连仍允许 `http(s)`，`data:` / `blob:` 仅用于图片。`server.js`、Vercel 和 Netlify 会发送 CSP 与 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`、COOP 等安全头；GitHub Pages 等无法自定义响应头的静态托管依靠 `index.html` 中的 meta CSP。
- 本地文件、编辑器源码、远程 XAML / 帮助页统一限制为 **4 MiB**；超限会拒绝渲染并显示实际大小，不会截断 XAML。远程直连响应采用流式累计字节，超过上限立即取消；`localStorage` 只持久化约 **500 KB** 的内容，超过时会提示使用“导出”保存。
- 链接只允许 `http` / `https` / `mailto`，以及与 PCL 兼容的 `minecraft://` / `minecraft-preview://`；`打开网页` 与 `下载文件` 会校验协议，`javascript:`、`file:`、`data:`、其他自定义协议等会被拒绝。
- `/api/proxy` 是服务端出站代理，不是通用开放代理。本地 `server.js` 与 Vercel 的 `api/proxy.js` 共用 `api/proxy-core.js`，都会拦截本机 / 内网 / 保留地址、非 80 / 443 端口、带用户名密码的 URL、HTML 响应和超限内容，并可通过 `PCL_PROXY_ALLOWLIST` 限定域名。UA 只接受 1–512 个可打印 ASCII 字符，不能注入请求头。`image=1` 模式只接受图片响应；远程 SVG 仍允许渲染，但会附加沙箱 CSP，禁止脚本、外部资源、对象和导航，避免直接打开代理 SVG 时执行脚本。公开部署时仍建议设置白名单并按需限流。本地 `server.js` 不内置速率限制，公开运行时必须在反向代理 / 平台层限制请求频率；仅在本地探针 / 开发需要访问内网 fixture 时才可设置 `PCL_PROXY_ALLOW_LOCAL=1`；它会放开内网地址与任意端口限制，不要用于公开服务。
- 静态部署时，联网 URL 受目标站点 CORS 策略限制；这属于浏览器安全边界，不是渲染器错误。Vercel 部署可通过同源 `/api/proxy` 获取未开放 CORS 的内容。
- 远程图片优先直连；失败后通过 `/api/proxy?image=1` 重试，仍失败才使用 `FallbackSource` 或 `NoIcon`。

## 已知限制

- 样式只实现 `Setter` 与 `BasedOn`；`Trigger`、`ItemsControl`、通用 `ControlTemplate`（`ContentControl` 分隔线除外）尚未实现。`DataTemplate` 目前只用于解析 `GroupBox` 的 `HeaderTemplate` / `ContentTemplate` 文本模板。
- 不支持脚本、WPF 动画时间线、3D、媒体与自定义控件。
- 不支持 PCL 内部的完整页面（下载、联机、设置等），只提供占位页；`打开帮助` 仅实现远程帮助页，未打包 PCL 的本地帮助文档。
- `修改设置` 目前只应用 `UiLauncherHue`；透明度、背景模糊等设置会保存并参与 `{setup:...}`，但不会改变渲染外观。
- 文本换行、字体度量与 WPF 不是逐像素完全相同；已对齐主要尺寸、边距、颜色与字号。
- 远程主页中的相对图片路径不会自动按远程 URL 解析。

## 与 PCL 的加载语义差异

PCL 用 `XamlReader` 加载 `Custom.xaml`，遇到类型上不存在的成员会整页失败并提示「加载主页失败 / 主页内容编写有误，请根据下列错误信息进行检查：『无法设置未知成员“PCL.xxx.yyy”。』，行号为“N”，行位置为“M”」。预览器**故意保持宽容**：未知成员照常忽略并继续渲染，但会在预览右上角显示「兼容性警告」徽标，点开可看到与 PCL 措辞一致、带行号和行位置的完整清单。落到红框的控件也分成两种提示——PCL 中存在但预览器暂未实现的，与 PCL 中根本不存在的。

## 项目结构

```text
index.html                 工具外壳 + 850 × 500 PCL 预览
home.html                  独立主页页：只显示 PCL 右侧面板（1:1 / 适应宽度）
css/pcl-theme.css          PCL 窗口、标题栏、侧栏、滚动条、提示、弹窗
css/xaml.css               XAML 控件样式
css/app.css                工具外壳与响应式布局
css/home.css               独立主页页的工具栏、面板与提示块
css/appearance.css         跟随系统 / 浅色 / 深色 / AMOLED 四档外壳与画布压暗
js/app.js                  应用入口、状态、渲染流程、快捷键与 UI 绑定
js/home.js                 独立主页页入口：复用渲染器与运行时，无工具外壳
js/app/home-fit.js         独立主页页的 550/500 几何与 1:1 / 适应宽度缩放
js/app/preset-catalog.js   内置四个预设 + PCL2 25 个预设的统一清单
js/app/source-state.js     来源状态序列化、UA 清洗与 localStorage 读写
js/app/remote.js           远程读取、大小上限、XAML/JSON 响应校验
js/app/sources.js          预设/文件/联网来源加载与来源标签
js/app/help-navigation.js  帮助页历史、请求取消与返回焦点
js/app/presets.js          PCL2 预设列表 DOM 渲染
js/app/appearance.js       外观档位读写、持久化与键盘操作
js/boot-theme.js           首帧前恢复已保存的外观（<head> 内同步脚本）
js/boot.js                 file:// 启动失败兜底提示（外部脚本，兼容严格 CSP）
js/limits.js               主页大小限制与字节格式化
js/help.js                 PCL 帮助页地址解析与标题提取
js/url.js                  外部链接协议白名单与 URL 规范化
js/pcl-presets.js          PCL2 25 个预设清单（UI 与测试共用）
js/xaml.js                 XAML 解析、替换标记、安全过滤
js/renderer.js             WPF / PCL 控件到 DOM 的渲染器入口
js/renderer/helpers.js     渲染器共用的解析/几何/文本辅助函数
js/renderer/known-attributes.js  PCL 控件属性白名单，用于兼容性警告
js/renderer/builders/      布局、控件、文档流三类控件构建器
js/runtime.js              自定义事件引擎
js/shell.js                窗口外壳入口
js/shell/base.js           窗口基础状态、提示、弹窗、提交信息
js/shell/navigation.js     窗口控件、账号、页面导航、帮助页与提示气泡
js/theme.js                PCL HSL 色阶计算
js/assets.js               由脚本生成的 pack:// 图片映射
assets/pcl/                PCL 图片、图标与字体
assets/presets/            教程 / 画廊 / 事件 / 提示预设
server.js                  静态服务器 + 本地文本代理
api/proxy.js               Vercel Node Function 代理（SSRF 防护 / 白名单）
netlify/functions/proxy.mjs Netlify Functions 适配层，复用 api/proxy.js
api/proxy-core.js          本地与 Vercel 代理共用的 URL / SSRF / UA / 内容类型策略
api/proxy-policy.js        代理图片/SVG 响应策略与安全头
api/security-headers.js    页面与静态服务器共用的 CSP / 安全响应头
tools/generate-assets.mjs  重新生成 js/assets.js
tools/build-static.mjs     构建 dist/ 静态站点
tools/regression.mjs       启动临时服务器和浏览器的测试运行器
tools/test-suite.js        浏览器内回归与批量验收逻辑
tools/home-suite.js        浏览器内独立主页页回归逻辑
tools/pcl-presets.mjs      测试侧的 PCL2 预设清单转发
netlify.toml               Netlify 构建与发布配置
vercel.json                Vercel 构建与发布配置
.github/workflows/         GitHub Pages 自动部署
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

1. 运行 `npm start`，确认四个内置预设和 PCL2 预设面板均可正常使用；
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
