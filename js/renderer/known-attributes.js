// Attribute allow-lists used to spot properties that real PCL would reject.
//
// PCL loads Custom.xaml with XamlReader, so an attribute the target type does
// not declare throws "无法设置未知成员“PCL.<Type>.<Member”" and the whole page
// fails. The previewer keeps rendering (a previewer that dies on the first
// typo is useless), but it now reports those members with the line/position
// PCL puts in its own message.
//
// The tables below are the union of every attribute used by PCL's own XAML
// (FormMain, the pages and all Controls/*.xaml) plus the WPF properties those
// templates touch. Attributes that are not listed are reported as suspicious,
// never silently dropped.

const list = (text) => text.split(/\s+/).filter(Boolean);
const lowerSet = (text) => new Set(list(text).map((item) => item.toLowerCase()));

// FrameworkElement / UIElement / TextBlock / Shape / brush / animation
// properties that every XAML dialect accepts.
export const COMMON_ATTRIBUTES = lowerSet(`
    AcceptsReturn AlignmentX AlignmentY AllowDrop AllowsTransparency Angle AngleX AngleY
    AutoReverse Background BeginTime BlurRadius BorderBrush BorderThickness By CanContentScroll
    CanHorizontallyScroll CanVerticallyScroll CenterX CenterY ClipToBounds Color Content
    ContentTemplate ContentTemplateSelector Converter ConverterParameter CornerRadius Cursor Data
    DefaultChecked DeltaMult Direction DockPanel.Dock Duration EasingMode ElementName EndPoint
    Fill FocusVisualStyle Focusable FontFamily FontSize FontStyle FontWeight Foreground From
    GeometryCombineMode GradientOrigin Grid.Column Grid.ColumnSpan Grid.IsSharedSizeScope Grid.Row
    Grid.RowSpan Header Height HorizontalAlignment HorizontalContentAlignment HorizontalOffset
    HorizontalScrollBarVisibility Icon ImageSource IsChecked IsDirectionReversed IsEditable
    IsEnabled IsHitTestVisible IsItemsHost IsOpen IsReadOnly IsSelected IsTabStop IsTextSearchEnabled
    IsUndoEnabled KeyboardNavigation.DirectionalNavigation LineHeight Margin Max MaxHeight MaxLength
    MaxWidth Maximum Min MinHeight MinWidth Minimum Mode Name Offset Opacity Orientation Padding
    Panel.ZIndex PanningMode Path Placement PlacementRectangle PopupAnimation Property Radius
    RadiusX RadiusY Rect RelativeSource RenderOptions.BitmapScalingMode RenderOptions.ClearTypeHint
    RenderTransformOrigin RenderingBias RepeatBehavior ResizeMode Reverse Rules ScaleX ScaleY
    ScrollViewer.CanContentScroll ScrollViewer.VerticalScrollBarVisibility ShadowDepth
    ShutdownMode SnapsToDevicePixels Softness Source SpeedRatio StartPoint StartupUri
    Storyboard.TargetName Storyboard.TargetProperty Stretch Stroke StrokeThickness Style Tag
    TargetName TargetType Template Text TextAlignment TextDecorations TextOptions.TextFormattingMode
    TextTrimming TextWrapping ThumbnailClipMargin Title To ToolTip ToolTipService.InitialShowDelay
    ToolTipService.ShowOnDisabled Topmost Type TypeName TypeNameSpaced UseLayoutRounding Value
    VerticalAlignment VerticalContentAlignment VerticalOffset VerticalScrollBarVisibility
    ViewportSize Visibility Width WindowStyle X X1 X2 Y Y1 Y2
`);

// Properties the renderer actually reads that are not in the WPF/PCL lists
// above. They are allowed as Style Setters; anything outside every table is
// refused, so a remote XAML cannot inject an arbitrary CSS declaration.
export const RENDERER_ATTRIBUTES = lowerSet(`
    Columns FirstColumn HeaderTemplate Index IsSelectionEnabled LineStackingStrategy MarkerStyle
    NavigateUri Points Rows TextIndent TileMode
`);

// Members each PCL control declares (Controls/*.xaml.vb Public Property) plus
// the WPF properties their templates bind.
export const CONTROL_ATTRIBUTES = new Map(
  Object.entries({
    MyButton: "ColorType Text TextPadding",
    MyCard: "CanSwap CornerRadius HasMouseAnimation IsSwaped IsSwapped SwapLogoRight Title UseAnimation",
    MyCheckBox: "Checked Text",
    MyComboBox: "HintText Items SelectedIndex SelectedValue Text",
    MyComboBoxItem: "Content IsSelected Tag Text",
    MyDropShadow: "Color CornerRadius ShadowRadius",
    MyExtraButton: "CanRightClick Logo LogoScale Progress Show",
    MyExtraTextButton: "Logo LogoScale Show Text",
    MyHint: "CanClose HasBorder IsWarn RelativeSetup Text Theme",
    MyIconButton: "CanClick Foreground Logo LogoScale Theme",
    MyIconTextButton: "ColorType Logo LogoScale Text",
    MyImage: "EnableCache FallbackSource LoadingSource",
    MyListItem:
      "Buttons Checked Clickable FontSize Foreground Info IsScaleAnimationEnabled Logo LogoClickable LogoScale MinPaddingRight PaddingLeft Title Type",
    // LoadingState is an explicit interface implementation in
    // Controls/MyLoading.xaml.vb, so XAML really cannot set it.
    MyLoading: "AutoRun HasAnimation ShowProgress State Text TextError TextErrorInherit",
    MyMenuItem: "Icon Text",
    MyPageLeft: "AnimatedControl",
    MyPageRight: "PageState PanScroll",
    MyRadioBox: "Checked Text",
    MyRadioButton: "Checked ColorType Logo LogoScale Text",
    MyScrollBar: "Orientation",
    MyScrollViewer: "DeltaMult",
    MySearchBox: "HintText Text",
    MySlider: "MaxValue Value ValueByKey",
    MySliderDot: "MaxValue Value ValueByKey",
    MyTextBox: "CornerRadius HasBackground HintText ShowValidateResult Text ValidateResult ValidateRules",
    MyTextButton: "Text",
    MyVirtualizingElement: ""
  }).map(([tag, attributes]) => [tag.toLowerCase(), lowerSet(attributes)])
);

export const EVENT_ATTRIBUTES = new Set(
  list(`
    local:CustomEventService.EventType local:CustomEventService.EventData
    CustomEventService.EventType CustomEventService.EventData EventType EventData Click
  `)
);

/** True when PCL itself ships a control with this tag. */
export function isKnownControl(tag) {
  return CONTROL_ATTRIBUTES.has(String(tag || "").toLowerCase());
}

/**
 * True when a `<Setter Property="…">` may write this attribute. Remote XAML
 * could otherwise use a Style to push an arbitrary declaration at the renderer;
 * only members we know how to read are honoured, the rest are skipped.
 *
 * @param {string} name attribute name as authored
 * @returns {boolean}
 */
export function isSupportedSetterProperty(name) {
  const authored = String(name ?? "").trim();
  if (!authored) return false;
  const lower = authored.toLowerCase();
  if (COMMON_ATTRIBUTES.has(lower) || RENDERER_ATTRIBUTES.has(lower)) return true;
  if (EVENT_ATTRIBUTES.has(authored) || EVENT_ATTRIBUTES.has(lower)) return true;
  for (const allowed of CONTROL_ATTRIBUTES.values()) {
    if (allowed.has(lower)) return true;
  }
  return false;
}

const NAMESPACE_PREFIXES = ["x:", "d:", "mc:", "local:", "sys:", "core:", "corewpf:"];

const isNamespaceAttribute = (name) =>
  /^xmlns(:\w+)?$/i.test(name) || NAMESPACE_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix));

/**
 * Describe why `name` is not accepted on `tag`, or return null when it is.
 *
 * @param {string} tag lower-cased element local name
 * @param {string} name attribute name as authored
 * @param {string} [declared] tag as PCL spells it (for the member prefix)
 * @returns {{ severity: "error" | "warning", member: string, reason: string } | null}
 */
export function classifyAttribute(tag, name, declared = tag) {
  if (isNamespaceAttribute(name)) return null;
  if (EVENT_ATTRIBUTES.has(name)) return null;
  const lower = name.toLowerCase();
  if (COMMON_ATTRIBUTES.has(lower)) return null;

  const allowed = CONTROL_ATTRIBUTES.get(tag);
  if (!allowed) return null;
  if (allowed.has(lower)) return null;
  return {
    severity: "error",
    member: `PCL.${declared}.${name}`,
    reason: `${declared} 没有 ${name} 属性`
  };
}

/**
 * Locate an attribute in the authored source so the message can carry the
 * same 行号/行位置 PCL prints. `cursor` is the offset to resume from, which
 * keeps repeated attribute names pointing at successive occurrences.
 *
 * @param {string} source
 * @param {string} name
 * @param {number} cursor
 * @returns {{ line: number, column: number, cursor: number }}
 */
export function locateAttribute(source, name, cursor = 0) {
  const pattern = new RegExp(`(?<![\\w.:-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`, "g");
  pattern.lastIndex = Math.max(0, cursor);
  let match = pattern.exec(source);
  if (!match) {
    pattern.lastIndex = 0;
    match = pattern.exec(source);
  }
  if (!match) return { line: 0, column: 0, cursor };
  const index = match.index;
  const line = source.slice(0, index).split("\n").length;
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  return { line, column: index - lineStart + 1, cursor: index + match[0].length };
}
