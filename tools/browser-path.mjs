import fs from "node:fs";
import path from "node:path";

// The test harness and the dist smoke test both need a Chromium build. Keep one
// candidate list so PCL_TEST_BROWSER never works in one place but not the other.
const findOnPath = (name) => {
  const extensions = process.platform === "win32" ? [".exe", ""] : [""];
  for (const folder of String(process.env.PATH || "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(folder, `${name}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
};

export const findBrowser = () => {
  const candidates = [
    process.env.PCL_TEST_BROWSER,
    process.platform === "win32" &&
      path.join(process.env["PROGRAMFILES"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    process.platform === "win32" &&
      path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    process.platform === "win32" &&
      path.join(process.env["PROGRAMFILES"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    process.platform === "win32" &&
      path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    // browser-actions/setup-chrome installs outside PATH on Linux images.
    "/opt/google/chrome/chrome",
    "/opt/hostedtoolcache/chrome/stable/x64/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    findOnPath("google-chrome"),
    findOnPath("chromium"),
    findOnPath("chromium-browser"),
    findOnPath("msedge")
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
};
