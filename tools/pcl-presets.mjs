import { PCL_FALLBACK_UA } from "../js/ua.js";

// UI 与测试共用 js/pcl-presets.js，避免两份清单逐渐不同步。
export { PCL2_PRESETS as PCL_PRESETS } from "../js/pcl-presets.js";

export const PCL_TEST_UA = PCL_FALLBACK_UA;
