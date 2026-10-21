import { PCL_FALLBACK_UA } from "../js/ua.js";

export const PCL_TEST_UA = PCL_FALLBACK_UA;

const hintPreset = `
<local:MyCard Title="你知道吗？" Margin="0,0,0,15">
  <TextBlock Margin="25,38,23,15" FontSize="13.5" IsHitTestVisible="False"
             Text="{hint}" TextWrapping="Wrap" Foreground="{DynamicResource ColorBrush1}" />
</local:MyCard>`;

const cavePreset = `
<local:MyCard Title="回声洞" Margin="0,0,0,15">
  <TextBlock Margin="25,38,23,15" FontSize="13.5" IsHitTestVisible="False"
             Text="{cave}" TextWrapping="Wrap" Foreground="{DynamicResource ColorBrush1}" />
</local:MyCard>`;

// Titles and URLs mirror PCL's PageLaunchRight preset table.
// "unavailable" and "blocked" are known upstream states, not viewer failures.
export const PCL_PRESETS = [
  { id: 0, name: "你知道吗", kind: "inline", xaml: hintPreset, expected: "ok" },
  { id: 1, name: "回声洞", kind: "inline", xaml: cavePreset, expected: "ok" },
  { id: 2, name: "Minecraft 新闻", url: "https://mcnews.meloong.com", expected: "ok" },
  { id: 3, name: "简单主页", url: "https://pclhomeplazaoss.lingyunawa.top:26994/d/Homepages/MFn233/Custom.xaml", expected: "unavailable" },
  { id: 4, name: "每日整合包推荐", url: "https://pclsub.sodamc.com/", expected: "ok" },
  { id: 5, name: "Minecraft 皮肤推荐", url: "https://forgepixel.com/pcl_sub_file", expected: "unavailable" },
  { id: 6, name: "OpenBMCLAPI 仪表盘 Lite", url: "https://pcl-bmcl.milu.ink/", expected: "unavailable" },
  { id: 7, name: "主页市场", url: "https://pclhomeplazaoss.lingyunawa.top:26994/p/Homepages/Homepage.Market/Custom.xaml", expected: "unavailable" },
  { id: 8, name: "更新日志", url: "https://pclhomeplazaoss.lingyunawa.top:26994/d/Homepages/Joker2184/UpdateHomepage.xaml", expected: "unavailable" },
  { id: 9, name: "PCL 新功能说明书", url: "https://raw.gitcode.com/WForst-Breeze/WhatsNewPCL/raw/main/Custom.xaml", expected: "ok" },
  { id: 10, name: "OpenMCIM Dashboard", url: "https://files.mcimirror.top/PCL", expected: "unavailable" },
  { id: 11, name: "杂志主页", url: "https://gh-proxy.com/https://github.com/Neclyon/Magazine-Homepage-PCL/raw/main/output/Custom.xaml", expected: "blocked" },
  { id: 12, name: "PCL GitHub 仪表盘", url: "https://ddf.pcl-community.top/Custom.xaml", expected: "ok" },
  { id: 13, name: "PCL 更新摘要", url: "https://raw.gitcode.com/ENC_Euphony/PCL-AI-Summary-HomePage/raw/master/Custom.xaml", expected: "ok" },
  { id: 14, name: "今日新闻热点", url: "https://pcl.wyc-w.top/index.xaml", expected: "ok" },
  { id: 15, name: "Minecraft 芝士站", url: "https://mkss-services.awaeric.xyz", expected: "ok" },
  { id: 16, name: "整合包推荐引擎", url: "https://qawsedrftgyhujiko.fun/pcl2/Custom.xaml", expected: "ok" },
  { id: 17, name: "Bangumi 番剧主页", url: "https://bangumi.p.kaphia.top", expected: "ok" },
  { id: 18, name: "Bilibili 热门", url: "https://bilibili.p.kaphia.top", expected: "ok" },
  { id: 19, name: "Music 云音乐热门", url: "https://cloudmusic.p.kaphia.top", expected: "ok" },
  { id: 20, name: "模组推荐", url: "https://g-fish.dpdns.org/download/ModPage.xaml", expected: "ok" },
  { id: 21, name: "每日游戏推荐", url: "https://pcl.xn--9iq209asnop94b.top/download/GamePage.xaml", expected: "ok" },
  { id: 22, name: "Wallpaper 每日壁纸", url: "https://wallpaper.p.kaphia.top", expected: "ok" },
  { id: 23, name: "Weather 天气预报", url: "https://weather-p.kaphia.top/{variable:PCLDailyWeatherPage:choose}.xaml", expected: "ok" },
  { id: 24, name: "新一代狗屁王大杂烩主页", url: "https://end.g-fish.dpdns.org/Custom.xaml", expected: "ok" }
];
