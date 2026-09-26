import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const qml = readFileSync(new URL("../Overview.qml", import.meta.url), "utf8")
const service = readFileSync(new URL("../Service.qml", import.meta.url), "utf8")
const overlay = readFileSync(new URL("../Overlay.qml", import.meta.url), "utf8")
const stage = qml.slice(qml.indexOf("id: windowGrid"))

test("the overview stays transparent until it can take the desktop's place", () => {
  assert.match(qml, /FocusScope \{\s*id: keyScope[\s\S]*?opacity: root\.stageReady \? 1 : 0/)
  assert.match(qml, /stageCanShow: root\.opened && !root\.closing && !root\.stageReady\s*&& root\.backgroundSettled && root\.stageCaptured/)
  assert.match(qml, /id: stageSettleTimer\s*interval: 24/)
  assert.match(qml, /id: stageGiveUpTimer\s*interval: 250/)
  assert.match(qml, /function revealStage\(\)[\s\S]*?root\.stageReady = true\s*root\.revealProgress = 1/)
  assert.match(qml, /function finishClose\(\)[\s\S]*?root\.stageReady = false/)
})

test("keyboard focus is held only while showing, and through the close of an activation", () => {
  assert.match(qml, /WlrLayershell\.keyboardFocus: root\.stageReady\s*&& \(!root\.closing \|\| root\.pendingFocus\.length > 0\)\s*\? WlrKeyboardFocus\.Exclusive : WlrKeyboardFocus\.None/)
})

test("the wallpaper is resolved and decoded before the first opening", () => {
  assert.match(qml, /id: backgroundPrewarmTimer[\s\S]*?running: true/)
  assert.match(qml, /function prewarmBackground\(\)[\s\S]*?root\.backgroundResolved/)
})

test("the backdrop is the wallpaper, solid where the windows live while cards hand over", () => {
  assert.doesNotMatch(qml, /color: root\.scrimColor\s*opacity: 0\.94/)
  assert.match(qml, /id: wallpaperSource[\s\S]*?visible: false[\s\S]*?sourceSize\.width: panel\.screen/)
  assert.match(qml, /id: workArea[\s\S]*?opacity: root\.handOver \? 1 : root\.revealProgress/)
})

test("the space strip spans the screen over a cached blur of the wallpaper", () => {
  const rail = qml.slice(qml.indexOf("id: workspaceRail"), qml.indexOf("id: workspaceRow"))
  assert.match(rail, /width: parent\.width/)
  assert.match(rail, /y: -height \* \(1 - root\.revealProgress\)/)
  assert.match(rail, /MultiEffect \{[\s\S]*?source: wallpaperSource[\s\S]*?blurEnabled: true[\s\S]*?layer\.enabled: true/)
  assert.match(rail, /color: Util\.alpha\(Color\.background, 0\.85\)/, "tinted with the theme's own background")
})

test("windows move from their real place to the tiled stage, bare and rounded", () => {
  assert.match(stage, /windowCell\.realRect\.x\s*\+ \(windowCell\.targetRect\.x - windowCell\.realRect\.x\) \* root\.revealProgress/)
  assert.match(stage, /ClippingRectangle \{[\s\S]*?color: "transparent"/)
  assert.match(stage, /border\.color: windowCell\.focusedWindow\s*\? root\.hyprDeco\.active : root\.hyprDeco\.inactive/)
  assert.doesNotMatch(stage, /id: previewFrame|chromeHeight|root\.cellWidth/)
})

test("previews refresh off the 30 fps beat, live only at the hand-over ends", () => {
  assert.match(qml, /id: captureBeatTimer\s*interval: 33\s*repeat: true/)
  assert.match(stage, /live: root\.opened && \(!hasContent\s*\|\| \(root\.revealProgress > 0\.0005 && root\.revealProgress < 0\.15\)\)/)
  assert.match(stage, /function onCaptureBeatChanged\(\)[\s\S]*?preview\.captureFrame\(\)/)
})

test("titles appear on hover in the space cards' own bar, as plain text", () => {
  assert.match(stage, /showTitle: root\.stageInteractive && !windowCell\.beingDragged\s*&& \(windowCell\.hovered \|\| \(windowCell\.selected && root\.keyboardSelecting\)\)/)
  assert.match(stage, /id: titleBar[\s\S]*?height: Math\.min\(44, Math\.max\(34, parent\.height \* 0\.36\)\)\s*color: Util\.alpha\(root\.backgroundColor, 0\.94\)/)
  // Bound to the live toplevel title, so refreshes can keep the same cards.
  assert.match(stage, /text: WindowModel\.shortenedTitle\(String\(\s*\(windowCell\.modelData\.toplevel && windowCell\.modelData\.toplevel\.title\)\s*\|\| windowCell\.modelData\.title \|\| ""\), 120\)\s*textFormat: Text\.PlainText/)
})

test("keys move spatially, tab cycles, and activation animates back", () => {
  assert.match(qml, /function moveSelection\(horizontal, vertical\)[\s\S]*?WindowModel\.spatialNeighborIndex\(/)
  assert.match(qml, /root\.cycleSelection\(reverse \? -1 : 1\)/)
  // The focus is queued before close() starts, so holding keyboard focus through the close sees it.
  assert.match(qml, /function activateWindow\(index\)[\s\S]*?root\.focusAfterClose\([\s\S]*?hl\.dsp\.focus[\s\S]*?\n    root\.close\(\)/)
})

test("hyprland's layer fade is disabled for the overlay, once per Lua state", () => {
  assert.match(service, /if not _G\.omission_layer_rule then/)
  assert.match(service, /hl\.layer_rule\(\{ match = \{ namespace = "\^omission\$" \}, no_anim = true, animation = "none" \}\)/)
})

test("the selection ring is the active window's outline color", () => {
  assert.match(stage, /border\.width: 3\s*border\.color: root\.hyprDeco\.active/)
  assert.doesNotMatch(qml, /themeSelectionColor/)
})

test("adding a space is a bare plus at the far right of the strip", () => {
  const plus = qml.slice(qml.indexOf("id: addWorkspaceButton"), qml.indexOf("id: addWorkspaceMouse"))
  const row = qml.slice(qml.indexOf("id: workspaceRow"), qml.indexOf("id: addWorkspaceButton"))
  assert.match(plus, /anchors\.right: parent\.right/)
  assert.doesNotMatch(plus, /border\.|radius:|Rectangle \{/)
  assert.match(row, /Repeater \{[\s\S]*\n          \}\n\n          Item \{\n            $/, "the plus sits after the row, not in it")
})

test("the overview follows the desktop's workspace when a swipe switches it", () => {
  const follow = qml.match(/onShownWorkspaceIdChanged: \{[\s\S]*?\n  \}/)?.[0] || ""
  assert.match(follow, /root\.opened && !root\.closing && root\.shownWorkspaceId > 0/)
  assert.match(follow, /root\.selectWorkspace\(root\.shownWorkspaceId\)/)
})

test("swipe down goes to the shown space, and only while the overview is open", () => {
  const fn = overlay.match(/function activateDisplayed\(argument\)\s*\{[\s\S]*?\n  \}/)?.[0] || ""
  assert.match(fn, /if \(overviewSurface\.opened && !overviewSurface\.closing\)/)
  assert.match(fn, /overviewSurface\.activateWorkspace\(\)/)
  assert.match(fn, /\n    close\(\)\n/, "with no overview up it still dismisses the switcher")
})

test("the swipe-down gesture calls it, while Ctrl+Down still just closes", () => {
  assert.match(service, /direction = "down"[\s\S]*?shell call io\.github\.nobledoodle\.omission activateDisplayed ignored/)
  assert.match(service, /CTRL \+ DOWN[\s\S]{0,160}?shell hide io\.github\.nobledoodle\.omission/)
})

test("focus changes wait for the overlay to unmap, then dispatch in-process", () => {
  const activateWorkspace = qml.match(/function activateWorkspace\(\)\s*\{[\s\S]*?\n  \}\n\n  function activateWindow/)?.[0] || ""
  const activateWindow = qml.match(/function activateWindow\(index\)\s*\{[\s\S]*?\n  \}\n\n  function activateSelected/)?.[0] || ""
  for (const fn of [activateWorkspace, activateWindow]) {
    assert.match(fn, /root\.focusAfterClose\(/)
    assert.doesNotMatch(fn, /execDetached/, "a dispatch during the fade is undone when the overlay unmaps")
  }
  assert.match(activateWindow, /hl\.dsp\.focus\(\{ window = "stableid:[\s\S]*?hl\.dsp\.window\.bring_to_top\(\)/)
  assert.match(activateWorkspace, /hl\.dsp\.focus\(\{ workspace = /)
  assert.match(qml, /function finishClose\(\)[\s\S]*?if \(root\.pendingFocus\.length > 0\) pendingFocusTimer\.restart\(\)/)
  assert.match(qml, /id: pendingFocusTimer\s*interval: \d+/)
  assert.match(qml, /"closelayer"\s*&& String\(event\.data\) === "omission"\)\s*root\.runPendingFocus\(\)/)
  assert.match(qml, /function runPendingFocus\(\)[\s\S]*?if \(root\.opened\) return[\s\S]*?Hyprland\.dispatch\(list\[i\]\)/)
  assert.match(qml, /function open\(payloadJson\)[\s\S]*?pendingFocusTimer\.stop\(\)\s*root\.pendingFocus = \[\]/)
})

test("the focused space is ringed like the focused window", () => {
  const chip = qml.slice(qml.indexOf("id: workspaceChip"), qml.indexOf("id: removeSpaceButton"))
  const ring = chip.match(/Rectangle \{\s*x: -3\s*y: -3[\s\S]*?\n                \}\n/)?.[0] || ""
  assert.match(ring, /border\.width: 3\s*border\.color: root\.hyprDeco\.active\s*opacity: workspaceChip\.selected \? 1 : 0/)
  // Square when Hyprland's windows are square, as Hyprland's own border is.
  assert.match(ring, /radius: workspaceChip\.radius > 0 \? workspaceChip\.radius \+ 3 : 0/)
  const windowRing = stage.match(/x: -3\s*y: -3[\s\S]*?border\.color: root\.hyprDeco\.active/)?.[0] || ""
  assert.ok(windowRing, "the window ring is the model")
  assert.doesNotMatch(chip, /workspaceChip\.windowDropTarget \|\| workspaceChip\.selected\s*\? root\.selectedBorderColor : Util\.alpha/, "no faint inner ring for the selected space")
})

test("space card contents are clipped to the card's rounded outline", () => {
  const surface = qml.match(/ClippingRectangle \{\s*id: desktopSurface[\s\S]*?\n                  clip|ClippingRectangle \{\s*id: desktopSurface[\s\S]{0,200}/)?.[0] || ""
  assert.match(surface, /ClippingRectangle \{\s*id: desktopSurface\s*anchors\.fill: parent\s*radius: workspaceChip\.radius\s*color: "transparent"/)
  assert.doesNotMatch(qml, /Item \{\s*id: desktopSurface/, "a plain Item's clip is rectangular")
})

test("the open/close motion runs 20% faster than upstream's 240/160 ms", () => {
  assert.match(qml, /readonly property int openDuration: 192/)
  assert.match(qml, /readonly property int closeDuration: 128/)
  assert.match(qml, /duration: root\.closing \? root\.closeDuration : root\.openDuration/)
  assert.match(qml, /id: closeAnimationTimer\s*interval: root\.closeDuration \+ 24/)
})

test("the strip has no hairline along its bottom edge", () => {
  const rail = qml.slice(qml.indexOf("id: workspaceRail"), qml.indexOf("id: workspaceRow"))
  assert.doesNotMatch(rail, /anchors\.bottom: parent\.bottom\s*height: 1/)
  assert.doesNotMatch(rail, /border\.width: [1-9]/)
})

test("an inactive space card is outlined in Hyprland's inactive window border color", () => {
  const chip = qml.slice(qml.indexOf("id: workspaceChip"), qml.indexOf("id: removeSpaceButton"))
  assert.match(chip, /border\.color: windowDropTarget\s*\? root\.selectedBorderColor : root\.hyprDeco\.inactive\s*border\.width: windowDropTarget \? 3 : 1/)
  assert.match(chip, /border\.color: workspaceChip\.windowDropTarget\s*\? root\.selectedBorderColor : root\.hyprDeco\.inactive/)
  assert.match(qml, /inactive: Qt\.rgba\(0\.35, 0\.35, 0\.35, 0\.67\)|next\.inactive = root\.hyprColor\(value, next\.inactive\)/)
})

test("space cards and windows take their corners from Hyprland's rounding", () => {
  assert.match(qml, /"j\/getoption decoration:rounding"/)
  assert.match(qml, /entry\.option === "decoration:rounding" && isFinite\(Number\(value\)\)\)\s*\n\s*next\.rounding = Math\.max\(0, Math\.min\(100, Number\(value\)\)\)/)
  const chip = qml.slice(qml.indexOf("id: workspaceChip"), qml.indexOf("id: removeSpaceButton"))
  assert.match(chip, /radius: root\.hyprRounding\n/, "a space card wears the rounding as is")
  assert.doesNotMatch(chip, /radius: Math\.max\(/, "no minimum radius on a space card")
  assert.match(qml, /radius: \{[\s\S]*?root\.hyprRounding \* thumbnailWindow\.width \/ realWidth : 0\s*\}/, "mini windows scale it")
  assert.match(stage, /readonly property real cornerRadius: root\.hyprRounding\s*\n\s*\* \(windowCell\.realRect \? windowCell\.width \/ windowCell\.realRect\.width : 1\)/)
  assert.match(stage, /radius: windowCell\.cornerRadius > 0 \? windowCell\.cornerRadius \+ thickness : 0/)
  assert.match(stage, /radius: windowCell\.cornerRadius > 0 \? windowCell\.cornerRadius \+ 3 : 0/)
})
