import { isOpenableExternalUrl } from "./url.js";

const VARIABLES_KEY = "pcl.lab.variables.v1";
const SETTINGS_KEY = "pcl.lab.settings.v1";

const PCL_INFO = Object.freeze({
  version: "2.99.0.0",
  versionCode: "414",
  versionBranch: "快照版",
  buildType: "Snapshot",
  branch: "OpenSource",
  identify: "0000-0000-0000-0000"
});

const PCL_PATHS = Object.freeze({
  base: "C:\\Users\\Steve\\AppData\\Roaming\\PCL\\",
  exe: "C:\\Users\\Steve\\AppData\\Roaming\\PCL\\Plain Craft Launcher 2.exe",
  temp: "C:\\Users\\Steve\\AppData\\Local\\Temp\\PCL\\",
  java: "C:\\Program Files\\Java\\jdk-17\\",
  minecraft: "C:\\Users\\Steve\\AppData\\Roaming\\.minecraft\\"
});

const pad2 = (value) => String(value).padStart(2, "0");

const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
};

const localTime = () => {
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
};

const vanillaVersionName = (name) => String(name ?? "").match(/^\d+(?:\.\d+){1,3}/)?.[0] || String(name ?? "");

const hasLoader = (name, label) => {
  const cleaned = label === "forge" ? String(name).replace(/neoforge/gi, "") : String(name);
  return new RegExp(`(?:^|[-_ ])${label}(?:$|[-_ ])`, "i").test(cleaned);
};

const loaderVersion = (meta, label) => {
  const match = String(meta ?? "").match(new RegExp(`\\b${label}\\s+([^\\s·]+)`, "i"));
  return match?.[1] || "";
};

export const DEFAULT_SETTINGS = {
  UiLauncherHue: "210",
  UiLauncherTheme: "0",
  UiLauncherTransparent: "600",
  UiBackgroundOpacity: "1000",
  UiBackgroundBlur: "0",
  UiBackgroundSuit: "0",
  UiBackgroundColorful: "True",
  UiCustomType: "0",
  UiCustomPreset: "0",
  UiCustomNet: ""
};

const HINTS = [
  "使用 Shift + 左键点击箱子中的物品，可以快速移动整组物品。",
  "给盔甲架命名后，它的名字会显示在头顶。",
  "在熔炉上方放置漏斗，可以自动输入物品。",
  "水桶可以在落地前扑灭身上的火。",
  "用精准采集附魔采集玻璃，可以得到玻璃方块。",
  "鞘翅配合烟花火箭可以让你持续飞行。",
  "村庄里的钟可以吸引村民，也可以用来集合。",
  "在 PCL 设置 → 个性化 → 主页 中，可以把主页来源切换为本地文件或联网地址。",
  "Custom.xaml 支持打开网页、复制文本、修改变量等自定义事件。",
  "将主页 XAML 放在 PCL 文件夹中，再把主页来源设为本地文件即可加载。",
  "下界合金镐可以挖掘黑曜石，但钻石镐不行。",
  "在潮湿的海绵上放置熔炉，可以把它烘干。"
];

const CAVES = [
  // PCL 的 {cave} 标记，即“回声洞”的随机文本。
  "岩石里藏着什么？你听见了远处传来的回声。",
  "洞穴的回声重复了你最后说出的那个词。",
  "传说在 y=-59 附近能听到远古的低语。",
  "把火把插在墙上，影子却朝相反的方向移动。",
  "你听见滴水声，却找不到水源。",
  "这里的空气比外面更冷，像是从很深的地方吹来的。",
  "蝙蝠从头顶掠过，翅膀扇动的声音在洞里来回碰撞。",
  "有人在石壁上刻下了一个箭头，指向更深的黑暗。",
  "你踩到的不是石头，而是一块被苔藓覆盖的旧砖。",
  "回声洞说：今天就到这里吧，明天再继续探索。"
];

const loadJSON = (key, fallback) => {
  try {
    const value = localStorage.getItem(key);
    if (!value) return { ...fallback };
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? { ...fallback, ...parsed } : { ...fallback };
  } catch {
    return { ...fallback };
  }
};

const saveJSON = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore storage failures */
  }
};

const newline = (value) => String(value ?? "").replaceAll("\\n", "\n");

const lastPathPart = (url) => {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split("/").filter(Boolean).pop() || "download");
  } catch {
    return "download";
  }
};

const hashString = (value) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
};

export class PclRuntime {
  constructor({ shell, onRefresh, onSettingChange, onOpenHelp }) {
    this.shell = shell;
    this.onRefresh = onRefresh;
    this.onSettingChange = onSettingChange;
    this.onOpenHelp = onOpenHelp;
    this.variables = loadJSON(VARIABLES_KEY, {});
    this.settings = loadJSON(SETTINGS_KEY, DEFAULT_SETTINGS);
    this.queue = Promise.resolve();
    this.user = {
      name: "Steve",
      uuid: "8667ba71-b85a-4004-af54-457a9734eed7",
      login: "离线"
    };
    this.context = {
      getVariable: (name, fallback = "") => {
        const value = this.variables[String(name)];
        return value === undefined ? fallback : value;
      },
      getSetting: (name) => {
        const key = String(name);
        return this.settings[key] ?? DEFAULT_SETTINGS[key] ?? "";
      },
      randomHint: () => HINTS[Math.floor(Math.random() * HINTS.length)],
      randomCave: () => CAVES[Math.floor(Math.random() * CAVES.length)],
      getPlaceholder: (name) => this.getPlaceholder(name),
      user: this.user
    };
  }

  setUser(partial) {
    Object.assign(this.user, partial);
  }

  getPlaceholder(name) {
    const key = String(name ?? "").toLowerCase();
    const info = this.shell?.getVersionInfo?.() || {
      name: this.shell?.getVersion?.() || "1.20.1-Fabric",
      meta: ""
    };
    const versionName = String(info.name || "1.20.1-Fabric");
    const meta = String(info.meta || "");
    const versionPath = `${PCL_PATHS.minecraft}versions\\${versionName}\\`;

    switch (key) {
      case "pcl_version":
        return PCL_INFO.version;
      case "pcl_version_code":
        return PCL_INFO.versionCode;
      case "pcl_version_branch":
        return PCL_INFO.versionBranch;
      case "pcl_build_type":
        return PCL_INFO.buildType;
      case "pcl_branch":
        return PCL_INFO.branch;
      case "identify":
        return PCL_INFO.identify;
      case "path":
        return PCL_PATHS.base;
      case "path_with_name":
        return PCL_PATHS.exe;
      case "path_temp":
        return PCL_PATHS.temp;
      case "pcl_md5":
      case "pcl_sha1":
        return "";
      case "date":
        return localDate();
      case "time":
        return localTime();
      case "java":
        return PCL_PATHS.java;
      case "minecraft":
        return PCL_PATHS.minecraft;
      case "version_path":
      case "verpath":
      case "version_indie":
      case "verindie":
        return versionPath;
      case "name":
        return versionName;
      case "version":
        return vanillaVersionName(versionName);
      case "forge":
        return hasLoader(versionName, "forge") ? loaderVersion(meta, "forge") : "";
      case "fabric":
        return hasLoader(versionName, "fabric") ? loaderVersion(meta, "fabric") : "";
      case "neoforge":
        return hasLoader(versionName, "neoforge") ? loaderVersion(meta, "neoforge") : "";
      case "liteloader":
        return hasLoader(versionName, "liteloader") ? "true" : "";
      case "user":
        return this.user.name ?? "";
      case "uuid":
        return String(this.user.uuid ?? "").toLowerCase();
      case "login":
        return this.user.login ?? "";
      case "hint":
        return HINTS[Math.floor(Math.random() * HINTS.length)];
      case "cave":
        return CAVES[Math.floor(Math.random() * CAVES.length)];
      default:
        return "";
    }
  }

  raise(events) {
    if (!events?.length) return;
    this.queue = this.queue
      .then(async () => {
        for (const event of events) {
          await this.handle(event.type, event.data ?? "");
        }
      })
      .catch((error) => {
        console.error("[PCL Runtime]", error);
        this.shell.showModal({
          title: "事件执行失败",
          caption: error?.message ? String(error.message) : String(error),
          buttons: ["确定"],
          warn: true
        });
      });
  }

  async handle(type, data) {
    const started = performance.now();
    const raw = String(data ?? "");
    const args = raw.split("|");
    const arg0 = args[0] ?? "";
    const arg1 = args.slice(1).join("|");
    this.shell.pushEvent({ type, data: raw, status: "run", time: Date.now() });
    try {
      const result = await this.dispatch(type, raw, args, arg0, arg1);
      this.shell.pushEvent({
        type,
        data: raw,
        status: "ok",
        message: result ?? "",
        duration: Math.round(performance.now() - started),
        time: Date.now()
      });
      return result;
    } catch (error) {
      this.shell.pushEvent({
        type,
        data: raw,
        status: "error",
        message: error?.message || String(error),
        duration: Math.round(performance.now() - started),
        time: Date.now()
      });
      throw error;
    }
  }

  async dispatch(type, raw, args, arg0, _arg1) {
    switch (type) {
      case "打开网页": {
        const url = raw.replaceAll("\\", "/").trim();
        if (!isOpenableExternalUrl(url)) {
          await this.shell.showModal({
            title: "事件执行失败",
            caption:
              "EventData 必须为 http://、https://、mailto: 链接，\n" +
              "或 PCL 支持的 minecraft://、minecraft-preview:// 链接。\n" +
              "如果想要启动其他程序，请将 EventType 改为 打开文件。",
            buttons: ["确定"],
            warn: true
          });
          return "invalid-url";
        }
        this.shell.showHint(`正在开启，请稍候：${url}`, "Blue");
        const ok = this.shell.openUrl(url);
        if (!ok) {
          const choice = await this.shell.showModal({
            title: "无法打开网页",
            caption: `浏览器阻止了新窗口。\n请允许弹出窗口后重试，或手动复制下面的地址：\n\n${url}`,
            buttons: ["复制地址", "关闭"],
            warn: true
          });
          if (choice === 0) await this.shell.copyText(url);
        }
        return url;
      }

      case "打开文件":
      case "执行命令": {
        const choice = await this.shell.showModal({
          title: "网页版限制",
          caption: `${type} 需要在本机执行程序或命令，浏览器无法完成此操作。\n\nEventData：${raw || "（空）"}\n\n在 PCL 中会调用 StartProcess。`,
          buttons: ["复制路径", "关闭"],
          warn: false
        });
        if (choice === 0) await this.shell.copyText(arg0);
        return "blocked";
      }

      case "打开帮助": {
        const target = String(raw ?? "").trim();
        if (/^https?:\/\//i.test(target) && typeof this.onOpenHelp === "function") {
          try {
            await this.onOpenHelp(target);
            return "help";
          } catch (error) {
            await this.shell.showModal({
              title: "打开帮助失败",
              caption: `无法加载帮助页面：${String(error?.message || error)}\n\n地址：${target}`,
              buttons: ["确定"],
              warn: true
            });
            return "error";
          }
        }
        const choice = await this.shell.showModal({
          title: "打开帮助",
          caption: `网页渲染器没有打包 PCL 的内置帮助文档。\n\n请求的帮助页面：${raw || "（空）"}\n\n可以在 PCL 帮助文档库中查找对应条目。`,
          buttons: ["打开帮助文档库", "关闭"],
          warn: false
        });
        if (choice === 0) this.shell.openUrl("https://github.com/LTCatt/PCL2Help");
        return "help";
      }

      case "启动游戏": {
        const version = arg0 === "\\current" ? this.shell.getVersion() : arg0 || this.shell.getVersion();
        const server = args.length >= 2 ? args[1] : "";
        await this.shell.showModal({
          title: "启动游戏",
          caption: `网页渲染器无法真正启动 Minecraft。\n\n版本：${version || "（未指定）"}${server ? `\n服务器：${server}` : ""}\n\n在 PCL 中，此操作会调用 McLaunchStart。`,
          buttons: ["确定"],
          warn: false
        });
        return version;
      }

      case "复制文本": {
        const ok = await this.shell.copyText(raw);
        this.shell.showHint(ok ? "已成功复制！" : "复制失败，剪贴板可能被占用。", ok ? "Green" : "Red");
        return ok;
      }

      case "刷新主页":
      case "刷新页面": {
        await this.onRefresh?.(type);
        if (!raw) this.shell.showHint("已刷新！", "Green");
        return "refreshed";
      }

      case "刷新帮助":
        this.shell.showHint("已刷新！", "Green");
        return "refreshed";

      case "今日人品": {
        const now = new Date();
        const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const score = hashString(`${day}:${this.user.name}`) % 101;
        const fortunes = [
          "今天适合挖矿，尤其是往脚下挖。",
          "会遇到一只对你很友好的苦力怕。",
          "在洞穴里待久了，记得带一桶水。",
          "今天的红石电路一次就能点亮。",
          "向村民交易时，价格可能会让你惊讶。",
          "如果迷路了，抬头看看太阳。",
          "今天的运气藏在最后一个箱子里。"
        ];
        const fortune = fortunes[hashString(day) % fortunes.length];
        await this.shell.showModal({
          title: "今日人品",
          caption: `今天的人品：${score}\n\n${fortune}\n\n（网页版模拟结果，与 PCL 百宝箱无关）`,
          buttons: ["好"],
          warn: false
        });
        return score;
      }

      case "内存优化":
      case "清理垃圾":
        this.shell.showHint(`网页渲染器已模拟执行「${type}」（浏览器无法管理进程内存）。`, "Blue");
        return "simulated";

      case "弹出窗口": {
        if (args.length < 2) {
          throw new Error(`EventType ${type} 需要至少 2 个以 | 分割的参数，例如 弹窗标题|弹窗内容`);
        }
        const title = newline(arg0);
        const caption = newline(args.length === 2 ? args[1] : args.slice(1, -1).join("|"));
        const button = newline(args.length > 2 ? args[args.length - 1] : "确定") || "确定";
        await this.shell.showModal({ title, caption, buttons: [button], warn: false });
        return "modal";
      }

      case "弹出提示": {
        const text = newline(arg0);
        const hintType = args.length > 1 ? args[1] : "Blue";
        this.shell.showHint(text, hintType);
        return "hint";
      }

      case "切换页面":
        this.shell.switchPage(arg0 || "Launch", args.length > 1 ? args[1] : "");
        return arg0;

      case "导入整合包":
      case "安装整合包": {
        const file = await this.shell.pickFile(".zip,application/zip");
        if (!file) return "cancelled";
        await this.shell.showModal({
          title: type,
          caption: `网页渲染器无法执行整合包安装流程。\n\n已选择：${file.name}\n\n在 PCL 中，此操作会调用 ModpackInstall()。`,
          buttons: ["确定"],
          warn: false
        });
        return file.name;
      }

      case "下载文件": {
        const url = arg0.replaceAll("\\", "/");
        if (!/^https?:\/\//i.test(url)) {
          await this.shell.showModal({
            title: "事件执行失败",
            caption: "EventData 必须为以 http:// 或 https:// 开头的网址。\nPCL 不支持其他乱七八糟的下载协议。",
            buttons: ["确定"],
            warn: true
          });
          return "invalid-url";
        }
        const fileName = args.length >= 2 ? args[1] : lastPathPart(url);
        const choice = await this.shell.showModal({
          title: "下载文件",
          caption: `即将从该网址下载文件：\n${url}\n\n保存名称：${fileName}`,
          buttons: ["下载", "取消"],
          warn: false
        });
        if (choice !== 0) return "cancelled";
        this.shell.download(url, fileName);
        this.shell.showHint(`已开始下载：${fileName}`, "Blue");
        return fileName;
      }

      case "修改设置":
      case "写入设置": {
        if (args.length < 2) {
          throw new Error(`EventType ${type} 需要至少 2 个以 | 分割的参数，例如 UiLauncherTransparent|400`);
        }
        const key = arg0;
        const value = args[1];
        this.settings[key] = value;
        saveJSON(SETTINGS_KEY, this.settings);
        this.onSettingChange?.(key, value);
        if (args.length === 2) this.shell.showHint(`已写入设置：${key} → ${value}`, "Green");
        return value;
      }

      case "修改变量":
      case "写入变量": {
        if (args.length < 2) {
          throw new Error(`EventType ${type} 需要至少 2 个以 | 分割的参数，例如 VariableName|SomeValue`);
        }
        this.variables[arg0] = args[1];
        saveJSON(VARIABLES_KEY, this.variables);
        if (args.length === 2) this.shell.showHint(`已写入变量：${arg0} → ${args[1]}`, "Green");
        this.onSettingChange?.("__variables", this.variables);
        return args[1];
      }

      case "加入房间": {
        const choice = await this.shell.showModal({
          title: "加入房间",
          caption: `网页渲染器无法加入第三方联机房间。\n\n房间信息：${raw || "（空）"}\n\n在 PCL 中，此操作会调用 PageLinkMain.Join()。`,
          buttons: ["复制房间号", "关闭"],
          warn: false
        });
        if (choice === 0) await this.shell.copyText(raw);
        return "blocked";
      }

      case "检查更新": {
        const choice = await this.shell.showModal({
          title: "检查更新",
          caption: "网页渲染器无法检查 PCL 更新。\n可以前往 PCL 下载页获取最新正式版。",
          buttons: ["打开 PCL 下载页", "关闭"],
          warn: false
        });
        if (choice === 0) this.shell.openUrl("https://meloong.com/pcl");
        return "blocked";
      }

      default:
        await this.shell.showModal({
          title: "事件执行失败",
          caption: `未知的事件类型：${type}\n请检查事件类型填写是否正确，或者 PCL 是否为最新版本。`,
          buttons: ["确定"],
          warn: true
        });
        return "unknown";
    }
  }

  clearVariables() {
    this.variables = {};
    saveJSON(VARIABLES_KEY, this.variables);
    this.onSettingChange?.("__variables", this.variables);
  }
}
