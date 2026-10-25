// The setting names PCL registers at startup.
//
// Pages/PageSetup/Settings.vb:5 builds a static `Entries` dictionary from
// 192 `New Setting("…")` calls, and every read/write goes through
// Settings.Get/Set, which throw `KeyNotFoundException("未找到设置项：" & Key)`
// when the name is missing (Settings.vb:282, 303, 313, 372, 382).
//
// MyHint_Loaded reads its dismissal flag with
// `Settings.Get(Of Boolean)(RelativeSetup)` (Controls/MyHint.xaml.vb:102), so a
// RelativeSetup the launcher never registered fails the whole page load. The
// previewer keeps its lenient localStorage behaviour, but it reports the
// mismatch so a page that only works in the browser is obvious.
//
// Generated from PCL 2.99.0.0 (build 413) — keep it in sync with Settings.vb if
// a future launcher registers new keys.

const list = (text) => text.split(/\s+/).filter(Boolean);

export const PCL_SETTING_NAMES = new Set(
  list(`
    AprilYear CacheAuthAccess CacheAuthClient CacheAuthName CacheAuthPass CacheAuthServerName
    CacheAuthServerRegister CacheAuthServerServer CacheAuthUsername CacheAuthUuid CacheConfig CacheDownloadFolder
    CacheDrops CacheExportConfig CacheJavaListVersion CacheMsAccess CacheMsName CacheMsOAuthRefresh
    CacheMsProfileJson CacheMsUuid CacheMsV2Access CacheMsV2Expires CacheMsV2Migrated CacheMsV2Name
    CacheMsV2OAuthRefresh CacheMsV2ProfileJson CacheMsV2Uuid CacheNideAccess CacheNideClient CacheNideName
    CacheNidePass CacheNideServer CacheNideUsername CacheNideUuid CacheSavedPageUrl CacheSavedPageVersion
    HintBuy HintClearRubbish HintCustomCommand HintCustomWarn HintDownload HintDownloadThread
    HintExportConfig HintHandInstall HintHide HintIndieSetup HintMoreAdvancedSetup HintNotice
    HintSnapshot HintUpdateMod Identify LaunchAdvanceDisableJLW LaunchAdvanceDisableLUA LaunchAdvanceGame
    LaunchAdvanceGC LaunchAdvanceGraphicCard LaunchAdvanceJvm LaunchAdvanceRun LaunchAdvanceRunWait LaunchArgumentIndie
    LaunchArgumentIndieV2 LaunchArgumentInfo LaunchArgumentJavaAll LaunchArgumentJavaSelect LaunchArgumentPriority LaunchArgumentRam
    LaunchArgumentTitle LaunchArgumentVisible LaunchArgumentWindowHeight LaunchArgumentWindowType LaunchArgumentWindowWidth LaunchFolders
    LaunchFolderSelect LaunchRamCustom LaunchRamType LaunchSkinID LaunchSkinSlim LaunchSkinType
    LinkCustomPeer LinkEasyTierVersion LinkLastAutoJoinInviteCode LinkLatencyMode LoginAuthEmail LoginAuthPass
    LoginLegacyName LoginMsJson LoginNideEmail LoginNidePass LoginPageType LoginRemember
    LoginType Potatoes SystemCount SystemDebugAnim SystemDebugDelay SystemDebugMode
    SystemDebugSkipCopy SystemEulaVersion SystemHelpVersion SystemHighestAlphaVersionReg SystemHighestBetaVersionReg SystemHighestSavedBetaVersionReg
    SystemLastVersionReg SystemLaunchCount SystemSystemActivity SystemSystemCache SystemSystemTelemetry SystemSystemUpdate
    ToolDownloadCert ToolDownloadMod ToolDownloadSource ToolDownloadSpeed ToolDownloadThread ToolDownloadTranslate
    ToolDownloadTranslateV2 ToolDownloadVersion ToolHelpChinese ToolModLocalNameStyle ToolUpdateRelease ToolUpdateReleaseLast
    ToolUpdateSnapshot ToolUpdateSnapshotLast UiBackgroundBlur UiBackgroundColorful UiBackgroundOpacity UiBackgroundSuit
    UiCustomNet UiCustomPreset UiCustomType UiHiddenFunctionHidden UiHiddenFunctionInstanceModify UiHiddenFunctionModUpdate
    UiHiddenFunctionSelect UiHiddenOtherAbout UiHiddenOtherFeedback UiHiddenOtherHelp UiHiddenOtherTest UiHiddenOtherVote
    UiHiddenPageDownload UiHiddenPageLink UiHiddenPageOther UiHiddenPageSetup UiHiddenSetupLaunch UiHiddenSetupLink
    UiHiddenSetupSystem UiHiddenSetupUi UiLauncherDelta UiLauncherEmail UiLauncherHue UiLauncherLight
    UiLauncherLogo UiLauncherSat UiLauncherTheme UiLauncherThemeHide UiLauncherThemeHide2 UiLauncherTransparent
    UiLogoLeft UiLogoText UiLogoType UiMusicAuto UiMusicRandom UiMusicStart
    UiMusicStop UiMusicVolume VersionAdvanceAssets VersionAdvanceAssetsV2 VersionAdvanceDisableJLW VersionAdvanceDisableLUA
    VersionAdvanceDisableModUpdate VersionAdvanceGame VersionAdvanceGC VersionAdvanceJvm VersionAdvanceRun VersionAdvanceRunWait
    VersionArgumentIndie VersionArgumentIndieV2 VersionArgumentInfo VersionArgumentJavaRange VersionArgumentJavaSelect VersionArgumentJavaV2
    VersionArgumentTitle VersionRamCustom VersionRamOptimize VersionRamType VersionServerAuthName VersionServerAuthRegister
    VersionServerAuthServer VersionServerEnter VersionServerLogin VersionServerNide WindowHeight WindowWidth
`)
);

/**
 * Whether PCL registers this setting name. Names are case-sensitive: the
 * dictionary is an ordinary Dictionary(Of String, Setting).
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isRegisteredSetting(name) {
  const key = String(name ?? "").trim();
  return key ? PCL_SETTING_NAMES.has(key) : false;
}
