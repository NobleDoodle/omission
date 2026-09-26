import QtQuick
import QtMultimedia
import QtQuick.Effects
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Widgets
import qs.Commons
import "WindowModel.js" as WindowModel
import "SwitcherModel.js" as SwitcherModel

Item {
  id: root

  property var shell: null
  property var manifest: null
  readonly property int foreignToplevelCount: ToplevelManager.toplevels.values.length
  property bool dragActive: false
  property int dragFromIndex: -1
  property int dragTargetIndex: -1
  property bool windowDragActive: false
  property int windowDragIndex: -1
  property int windowDropWorkspaceId: -1
  property bool windowDropAnimating: false
  property var pendingWindowToplevel: null
  property int pendingWindowWorkspaceId: -1
  readonly property var spaceService: root.shell
    && typeof root.shell.serviceFor === "function"
    ? root.shell.serviceFor("io.github.nobledoodle.omission") : null
  readonly property var managedWorkspaceIds: spaceService && spaceService.spacesLoaded
    ? spaceService.managedWorkspaceIds : []
  readonly property bool spacesLoaded: !!spaceService && spaceService.spacesLoaded
  property int editingWorkspaceId: -1
  property int desktopRevision: 0
  property bool opened: false
  property bool closing: false
  property real revealProgress: 0
  property bool thumbnailCapturesEnabled: false
  property bool windowCapturesEnabled: false
  property int thumbnailWorkspaceBudget: 0
  property int targetMonitorId: -1
  property string targetMonitorName: ""
  property int selectedWorkspaceId: -1
  property int selectedIndex: -1
  property var workspaceIds: []
  property var windows: []
  property int totalWindowCount: 0
  readonly property int maxOverviewWindows: WindowModel.MAX_SELECTED_GRID_CAPTURES
  readonly property int maxSpaceThumbnailWindows: WindowModel.MAX_WORKSPACE_THUMBNAIL_CAPTURES
  property var desktopCache: ({})
  // Commands resolve through root-owned directories only, never the PATH the
  // shell inherited, so nothing earlier in that PATH can stand in for them.
  readonly property string trustedPath: "/usr/local/bin:/usr/bin:/bin"
  readonly property var trustedEnvironment: ({ PATH: root.trustedPath })
  // Breathing room in the space cards: the mini desktop sits this far inside
  // the card, and neighboring windows get this much extra space between them.
  readonly property real spaceCardPadding: 8
  readonly property real spaceCardWindowGap: 4
  readonly property string pluginSourceDir: {
    if (root.manifest && root.manifest.__sourceDir)
      return String(root.manifest.__sourceDir).replace(/\/+$/, "")
    var u = String(Qt.resolvedUrl("."))
    if (u.indexOf("file://") === 0) u = u.substring(7)
    return u.replace(/\/+$/, "")
  }
  readonly property string backgroundResolverPath: root.pluginSourceDir
    ? root.pluginSourceDir + "/bin/background-source" : ""
  property string backgroundPath: ""
  property string backgroundKind: "none"
  property string backgroundSource: "none"
  property int backgroundRequestGeneration: 0
  readonly property bool videoFrameReady: root.opened
    && root.backgroundKind === "video"
    && sharedVideoPlayer.playbackState === MediaPlayer.PlayingState
    && sharedVideoPlayer.hasVideo
    && sharedVideoOutput.sourceRect.width > 0
    && sharedVideoOutput.sourceRect.height > 0


  readonly property color backgroundColor: Color.menu.background
  readonly property color foregroundColor: Color.menu.text
  readonly property color borderColor: Color.menu.border
  readonly property color scrimColor: Color.menu.scrim
  readonly property color selectedColor: Color.menu.selectedBackground
  readonly property color selectedTextColor: Color.menu.selectedText
  readonly property color selectedBorderColor: Color.menu.selectedBorder
  // The overview takes the desktop's place in a single frame and only then
  // moves. It stays transparent until every window card holds its first
  // capture and the wallpaper has decoded (never longer than the give-up
  // timer), paints the wallpaper where the windows live, and stands each card
  // exactly on its window before shrinking it into the stage.
  property bool stageReady: false
  property bool backgroundResolved: false
  property bool keyboardSelecting: false
  // Window previews refresh off one 30 fps beat (33 ms) instead of running
  // live: a live capture makes the whole overlay redraw every frame. Measured
  // on a 1920x1080 laptop with the overview open on a two-window space: the shell
  // uses ~14-15% of a core and Hyprland ~9% at 30 fps. Raise the interval
  // below to trade smoothness for CPU.
  property int captureBeat: 0
  property var hyprDeco: ({
    border: 2,
    rounding: Math.max(0, Style.cornerRadius),
    active: Qt.rgba(0.91, 0.74, 0.45, 1),
    inactive: Qt.rgba(0.35, 0.35, 0.35, 0.67)
  })
  // Hyprland's window rounding, re-read on every config reload. Space cards
  // wear it as is; windows wear it scaled with them, as the real ones would.
  readonly property real hyprRounding: Math.max(0, Number(root.hyprDeco.rounding) || 0)
  // The open/close motion, 20% faster than upstream's 240 ms in / 160 ms out.
  readonly property int openDuration: 192
  readonly property int closeDuration: 128
  // How far a card has traded Hyprland's dress for the overview's.
  readonly property real dress: Math.min(1, Math.max(0, root.revealProgress / 0.6))
  readonly property bool stageInteractive: root.stageReady && !root.closing
    && root.revealProgress >= 0.999
  readonly property int shownWorkspaceId: root.overviewMonitor
    && root.overviewMonitor.activeWorkspace
    ? Number(root.overviewMonitor.activeWorkspace.id) : -1
  // Cards stand in for real windows only when the space in the overview is
  // the one on screen; any other space cross-fades instead.
  readonly property bool handOver: root.backgroundKind === "image"
    && root.selectedWorkspaceId > 0 && root.selectedWorkspaceId === root.shownWorkspaceId
  // Three-finger left/right swipes switch the desktop's workspace (input.lua),
  // and the compositor handles them while the overview is up. The overview
  // follows, so the selected space, the strip's highlight and the tiled stage
  // shift the way the desktop does. Only a real change of the desktop's
  // workspace counts: browsing with Ctrl+arrows or a click never fires this.
  onShownWorkspaceIdChanged: {
    if (root.opened && !root.closing && root.shownWorkspaceId > 0)
      root.selectWorkspace(root.shownWorkspaceId)
  }

  // Hyprland hands focus back to the window that was focused before the
  // overlay opened at the moment the overlay unmaps, undoing any focus change
  // made while it is still closing (a dispatch spawned at the start of the
  // fade lands ~100 ms in; the unmap follows at ~190 ms). So activations queue
  // their dispatches, and finishClose runs them once the overlay is gone:
  // in-process (nothing to spawn) and as soon as Hyprland reports the unmap.
  property var pendingFocus: []

  function focusAfterClose(dispatches) {
    if (root.opened) root.pendingFocus = dispatches
  }

  function runPendingFocus() {
    var list = root.pendingFocus
    root.pendingFocus = []
    if (root.opened) return
    for (var i = 0; i < list.length; i++) Hyprland.dispatch(list[i])
  }

  Timer {
    id: pendingFocusTimer
    interval: 24
    repeat: false
    onTriggered: root.runPendingFocus()
  }
  // The part of the screen windows live in: all of it, less what the bar and
  // anything else exclusive has reserved ([left, top, right, bottom]).
  readonly property var usableArea: {
    var monitor = root.overviewMonitor
    var reserved = monitor && monitor.lastIpcObject
      ? WindowModel.valuesOf(monitor.lastIpcObject.reserved) : []
    var left = Number(reserved[0]) || 0
    var top = Number(reserved[1]) || 0
    var right = Number(reserved[2]) || 0
    var bottom = Number(reserved[3]) || 0
    return {
      x: left,
      y: top,
      width: Math.max(1, keyScope.width - left - right),
      height: Math.max(1, keyScope.height - top - bottom)
    }
  }
  readonly property real railHeight: workspaceRail.chipHeight
    + 2 * Math.max(Style.space(18), 18)
  readonly property real stageMargin: Math.max(Style.space(28), 28)
  readonly property real stageTop: root.railHeight + Math.max(Style.space(24), 24)
  readonly property real stageScale: Math.max(0.05, Math.min(
    (keyScope.width - 2 * root.stageMargin) / root.usableArea.width,
    (keyScope.height - root.stageTop - root.stageMargin) / root.usableArea.height))
  readonly property real stageWidth: root.usableArea.width * root.stageScale
  readonly property real stageHeight: root.usableArea.height * root.stageScale
  readonly property real stageX: (keyScope.width - root.stageWidth) / 2
  readonly property real stageY: root.stageTop
    + (keyScope.height - root.stageTop - root.stageMargin - root.stageHeight) / 2
  readonly property bool backgroundSettled: root.backgroundResolved
    && (root.backgroundKind !== "image"
      || workAreaWallpaper.status === Image.Ready
      || workAreaWallpaper.status === Image.Error)
  readonly property bool stageCaptured: {
    var windows = root.windows
    for (var i = 0; i < windowRepeater.count; i++) {
      var item = windowRepeater.itemAt(i)
      if (item && item.waiting) return false
    }
    return true
  }
  readonly property bool stageCanShow: root.opened && !root.closing && !root.stageReady
    && root.backgroundSettled && root.stageCaptured
  onStageCanShowChanged: if (root.stageCanShow) stageSettleTimer.restart()

  function revealStage() {
    stageSettleTimer.stop()
    stageGiveUpTimer.stop()
    if (!root.opened || root.closing || root.stageReady) return
    root.stageReady = true
    root.revealProgress = 1
  }

  // Where a window really is, in overlay coordinates.
  function realRect(toplevel) {
    var data = WindowModel.metadata(toplevel)
    var at = WindowModel.valuesOf(data.at)
    var size = WindowModel.valuesOf(data.size)
    if (at.length < 2 || size.length < 2) return null
    var monitor = root.overviewMonitor
    return {
      x: Number(at[0]) - (monitor ? Number(monitor.x) || 0 : 0),
      y: Number(at[1]) - (monitor ? Number(monitor.y) || 0 : 0),
      width: Math.max(1, Number(size[0]) || 1),
      height: Math.max(1, Number(size[1]) || 1)
    }
  }

  // The same window in the stage: the usable part of the screen, scaled.
  function stageRect(real) {
    if (!real) return null
    return {
      x: root.stageX + (real.x - root.usableArea.x) * root.stageScale,
      y: root.stageY + (real.y - root.usableArea.y) * root.stageScale,
      width: real.width * root.stageScale,
      height: real.height * root.stageScale
    }
  }

  function stageRects() {
    var rects = []
    for (var i = 0; i < root.windows.length; i++)
      rects.push(root.stageRect(root.realRect(root.windows[i].toplevel)))
    return rects
  }

  function cycleSelection(step) {
    var count = root.windows.length
    root.keyboardSelecting = true
    if (count === 0) {
      root.selectedIndex = -1
      return
    }
    var current = root.selectedIndex >= 0 ? root.selectedIndex : (step > 0 ? -1 : 0)
    root.selectedIndex = ((current + step) % count + count) % count
  }

  // Hyprland reports colors as AARRGGBB, a gradient as stops then an angle.
  function hyprColor(value, fallback) {
    var token = String(value || "").trim().split(/\s+/)[0].replace(/^0x/i, "")
    if (/^[0-9a-fA-F]{6}$/.test(token)) token = "ff" + token
    if (!/^[0-9a-fA-F]{8}$/.test(token)) return fallback
    return Qt.rgba(parseInt(token.substr(2, 2), 16) / 255,
      parseInt(token.substr(4, 2), 16) / 255,
      parseInt(token.substr(6, 2), 16) / 255,
      parseInt(token.substr(0, 2), 16) / 255)
  }

  function applyHyprDeco(text) {
    var next = {
      border: root.hyprDeco.border,
      rounding: root.hyprDeco.rounding,
      active: root.hyprDeco.active,
      inactive: root.hyprDeco.inactive
    }
    var chunks = String(text || "").split(/\n\s*\n/)
    for (var i = 0; i < chunks.length; i++) {
      var entry = null
      try { entry = JSON.parse(chunks[i]) } catch (_error) { continue }
      if (!entry) continue
      var value = entry.gradient !== undefined ? entry.gradient
        : entry.str !== undefined ? entry.str : entry.int
      if (entry.option === "general:border_size" && isFinite(Number(value)))
        next.border = Math.max(0, Math.min(20, Number(value)))
      else if (entry.option === "decoration:rounding" && isFinite(Number(value)))
        next.rounding = Math.max(0, Math.min(100, Number(value)))
      else if (entry.option === "general:col.active_border")
        next.active = root.hyprColor(value, next.active)
      else if (entry.option === "general:col.inactive_border")
        next.inactive = root.hyprColor(value, next.inactive)
    }
    root.hyprDeco = next
  }

  function readHyprDeco() {
    if (!hyprDecoProcess.running) hyprDecoProcess.running = true
  }

  Component.onCompleted: root.readHyprDeco()

  Process {
    id: hyprDecoProcess
    environment: root.trustedEnvironment
    command: ["hyprctl", "--batch", "j/getoption general:border_size ; "
      + "j/getoption general:col.active_border ; j/getoption general:col.inactive_border ; "
      + "j/getoption decoration:rounding"]
    stdout: StdioCollector { id: hyprDecoStdout; waitForEnd: true }
    onExited: function(exitCode) { if (exitCode === 0) root.applyHyprDeco(hyprDecoStdout.text) }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (!event) return
      if (String(event.name) === "configreloaded") root.readHyprDeco()
      // Hyprland refocuses the old window in the same breath as it reports
      // the overlay's layer closed, so queued focus goes out on that event:
      // the old window or space is on screen for under a frame instead of the
      // ~40 ms a timer needs. The timer stays as a fallback.
      else if (String(event.name) === "closelayer"
          && String(event.data) === "omission")
        root.runPendingFocus()
    }
  }

  Timer {
    id: stageSettleTimer
    interval: 24
    repeat: false
    onTriggered: if (root.stageCanShow) root.revealStage()
  }

  Timer {
    id: stageGiveUpTimer
    interval: 250
    repeat: false
    onTriggered: root.revealStage()
  }

  // Resolve and decode the wallpaper once shortly after startup, so even the
  // first opening after a shell restart does not wait on the resolver or on
  // decoding a full-screen image.
  Timer {
    id: backgroundPrewarmTimer
    interval: 1500
    running: true
    repeat: false
    onTriggered: root.prewarmBackground()
  }

  function prewarmBackground() {
    var monitor = Hyprland.focusedMonitor
    if (root.opened || root.backgroundResolved || !root.backgroundResolverPath
        || !monitor || backgroundPrewarmProcess.running) return
    backgroundPrewarmProcess.command = [root.backgroundResolverPath, String(monitor.name || "")]
    backgroundPrewarmProcess.running = true
  }

  Process {
    id: backgroundPrewarmProcess
    environment: root.trustedEnvironment
    stdout: StdioCollector { id: backgroundPrewarmStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0 || root.opened) return
      var record = root.parseBackgroundRecord(backgroundPrewarmStdout.text)
      if (record) root.applyBackgroundRecord(record)
    }
  }

  Timer {
    id: captureBeatTimer
    interval: 33
    repeat: true
    running: root.opened && root.stageReady
    onTriggered: root.captureBeat += 1
  }

  readonly property int gridSpacing: Math.max(Style.spacing.lg, 18)
  readonly property var overviewMonitor: root.monitorById(root.targetMonitorId)
  readonly property int gridColumns: WindowModel.gridColumns(
    root.windows.length, windowGrid.width, windowGrid.height)
  readonly property int gridRows: root.windows.length === 0 || root.gridColumns === 0
    ? 0 : Math.ceil(root.windows.length / root.gridColumns)
  readonly property real cellWidth: root.gridColumns === 0 ? 0
    : (windowGrid.width - (root.gridColumns - 1) * root.gridSpacing) / root.gridColumns
  readonly property real cellHeight: root.gridRows === 0 ? 0
    : (windowGrid.height - (root.gridRows - 1) * root.gridSpacing) / root.gridRows

  Behavior on revealProgress {
    enabled: root.opened
    NumberAnimation {
      duration: root.closing ? root.closeDuration : root.openDuration
      easing.type: root.closing ? Easing.InOutCubic : Easing.OutCubic
    }
  }

  function monitorScreen(name) {
    var screens = Quickshell.screens || []
    for (var i = 0; i < screens.length; i++) {
      if (String(screens[i].name || "") === String(name || "")) return screens[i]
    }
    return screens.length > 0 ? screens[0] : null
  }

  function monitorById(monitorId) {
    var monitors = Hyprland.monitors.values
    for (var i = 0; i < monitors.length; i++) {
      if (Number(monitors[i].id) === Number(monitorId)) return monitors[i]
    }
    return null
  }
  function parseBackgroundRecord(output) {
    var record
    try {
      record = JSON.parse(String(output || "").trim())
    } catch (_error) {
      return null
    }

    if (!record || typeof record !== "object" || Array.isArray(record)
        || typeof record.path !== "string"
        || typeof record.kind !== "string"
        || typeof record.source !== "string") return null

    var path = String(record.path)
    var kind = String(record.kind)
    var source = String(record.source)
    if (kind !== "image" && kind !== "video" && kind !== "none") return null
    if (source !== "mpvpaper" && source !== "state" && source !== "none") return null
    if (kind === "none") {
      if (path !== "" || source !== "none") return null
    } else if (!path || path.charAt(0) !== "/" || path.indexOf("\u0000") !== -1
               || source === "none") {
      return null
    }

    return { path: path, kind: kind, source: source }
  }

  function applyBackgroundRecord(record) {
    if (!record) return
    root.backgroundResolved = true
    var changed = root.backgroundPath !== record.path
      || root.backgroundKind !== record.kind
    if (changed && root.backgroundKind === "video") sharedVideoPlayer.stop()

    if (root.backgroundKind === "video" && record.kind !== "video") {
      root.backgroundKind = record.kind
      root.backgroundPath = record.path
    } else {
      root.backgroundPath = record.path
      root.backgroundKind = record.kind
    }
    root.backgroundSource = record.source
  }

  function refreshBackgroundSource() {
    if (!root.opened || root.closing || !root.backgroundResolverPath
        || !root.targetMonitorName || backgroundSourceProcess.running) return
    backgroundSourceProcess.requestGeneration = root.backgroundRequestGeneration
    backgroundSourceProcess.requestedMonitor = root.targetMonitorName
    backgroundSourceProcess.command = [
      root.backgroundResolverPath,
      root.targetMonitorName
    ]
    backgroundSourceProcess.running = true
  }


  function desktopCaptureModel(workspaceId) {
    var revision = root.desktopRevision
    return WindowModel.workspaceThumbnailCaptureModel(
      Hyprland.toplevels.values, Number(workspaceId), root.targetMonitorId)
  }

  function thumbnailRect(toplevel, width, height) {
    return WindowModel.workspaceThumbnailRect(
      toplevel, root.overviewMonitor, width, height,
      root.spaceCardPadding, root.spaceCardWindowGap)
  }

  function desktopEntry(metadata) {
    var initialClass = String(metadata.initialClass || "")
    var windowClass = String(metadata.class || "")
    var cacheKey = (initialClass + "\n" + windowClass).toLowerCase()
    if (root.desktopCache[cacheKey] !== undefined) return root.desktopCache[cacheKey]
    var entry = SwitcherModel.desktopEntry(DesktopEntries.applications.values || [],
      initialClass, windowClass, "")
    root.desktopCache[cacheKey] = entry
    return entry
  }

  // Plugins only receive the shell's appLibrary when they declare the "menu"
  // kind, so read the desktop entries and icon theme directly.
  function resolveIcon(iconName) {
    var name = String(iconName || "")
    if (name.charAt(0) === "/") return "file://" + name
    var themed = name ? String(Quickshell.iconPath(name, true) || "") : ""
    return themed || Quickshell.iconPath("application-x-executable", true)
  }

  function decorate(toplevel) {
    var metadata = toplevel.lastIpcObject || ({})
    var entry = root.desktopEntry(metadata)
    var fallbackName = String(metadata.class || metadata.initialClass || "Application")
    var appName = entry ? String(entry.name || fallbackName) : fallbackName
    var iconName = entry ? String(entry.icon || "")
      : SwitcherModel.safeIconName(metadata.initialClass || metadata.class)
    var sourceSize = metadata.size || []
    var sourceAspect = Number(sourceSize[0]) / Number(sourceSize[1])
    if (!isFinite(sourceAspect) || sourceAspect <= 0) sourceAspect = 16 / 10

    return {
      toplevel: toplevel,
      captureSource: toplevel.wayland,
      address: String(toplevel.address || metadata.address || ""),
      stableId: String(toplevel.stableId || metadata.stableId || ""),
      aspect: sourceAspect,
      appName: appName,
      title: WindowModel.shortenedTitle(toplevel.title || metadata.title || appName, 120),
      iconSource: root.resolveIcon(iconName)
    }
  }

  function currentSelectedAddress() {
    if (root.selectedIndex < 0 || root.selectedIndex >= root.windows.length) return ""
    return String(root.windows[root.selectedIndex].address || "")
  }

  function sameWindows(current, next) {
    if (!current || current.length !== next.length) return false
    for (var i = 0; i < next.length; i++) {
      if (current[i].toplevel !== next[i].toplevel
          || current[i].address !== next[i].address
          || current[i].iconSource !== next[i].iconSource
          || current[i].appName !== next[i].appName) return false
    }
    return true
  }

  function refreshWindows(preferredAddress) {
    var captureModel = WindowModel.selectedGridCaptureModel(
      Hyprland.toplevels.values, root.selectedWorkspaceId,
      root.targetMonitorId, preferredAddress)
    root.totalWindowCount = captureModel.totalCount
    var handles = captureModel.items
    var nextWindows = []
    for (var i = 0; i < handles.length; i++) nextWindows.push(root.decorate(handles[i]))

    // Rebuilding the cards drops their captures, and a fresh card shows its
    // app icon until the first frame lands, so a refresh that finds the same
    // windows keeps the cards it has. Titles are bound live on the card.
    if (root.sameWindows(root.windows, nextWindows)) nextWindows = root.windows
    else root.windows = nextWindows
    var wantedAddress = String(preferredAddress || "")
    var nextIndex = -1

    for (var j = 0; j < nextWindows.length; j++) {
      if (wantedAddress && nextWindows[j].address === wantedAddress) {
        nextIndex = j
        break
      }
      if (nextIndex < 0 && nextWindows[j].toplevel.activated) nextIndex = j
    }

    root.selectedIndex = nextIndex >= 0 ? nextIndex : (nextWindows.length > 0 ? 0 : -1)
  }

  function refreshOverview() {
    var preferredAddress = root.currentSelectedAddress()
    if (!root.dragActive) {
      root.workspaceIds = WindowModel.workspaceIds(
        Hyprland.workspaces.values, root.targetMonitorId, root.selectedWorkspaceId,
        root.managedWorkspaceIds)

      if (root.workspaceIds.indexOf(root.selectedWorkspaceId) === -1)
        root.selectedWorkspaceId = root.workspaceIds.length > 0 ? root.workspaceIds[0] : -1
    }

    root.refreshWindows(preferredAddress)
  }

  function open(payloadJson) {
    var monitor = Hyprland.focusedMonitor
    if (!monitor) return "unavailable"

    var payload = ({})
    try { payload = JSON.parse(payloadJson || "{}") } catch (_error) { payload = ({}) }
    var wasVisible = root.opened
    closeAnimationTimer.stop()
    pendingFocusTimer.stop()
    root.pendingFocus = []
    root.closing = false

    root.targetMonitorId = Number(monitor.id)
    root.targetMonitorName = String(monitor.name || "")
    var activeWorkspace = monitor.activeWorkspace || Hyprland.focusedWorkspace
    var requestedWorkspace = Number(payload.workspace)
    root.selectedWorkspaceId = requestedWorkspace > 0
      ? requestedWorkspace : (activeWorkspace ? Number(activeWorkspace.id) : -1)

    Hyprland.refreshWorkspaces()
    Hyprland.refreshToplevels()
    root.opened = true
    root.backgroundRequestGeneration += 1
    backgroundPollTimer.restart()
    root.refreshBackgroundSource()
    if (!wasVisible) {
      root.thumbnailCapturesEnabled = false
      root.windowCapturesEnabled = true
      root.thumbnailWorkspaceBudget = 1
      thumbnailCaptureTimer.stop()
      thumbnailCaptureBatchTimer.stop()
      root.revealProgress = 0
      root.keyboardSelecting = false
      stageGiveUpTimer.restart()
    }
    root.refreshOverview()

    Qt.callLater(function() {
      if (!root.opened || root.closing) return
      if (root.stageReady) root.revealProgress = 1
      if (!root.thumbnailCapturesEnabled) thumbnailCaptureTimer.restart()
      if (root.thumbnailWorkspaceBudget < root.workspaceIds.length)
        thumbnailCaptureBatchTimer.restart()
      keyScope.forceActiveFocus()
    })
    return "ok"
  }

  function toggle(payloadJson) {
    if (root.opened && !root.closing) {
      root.close()
      return "closed"
    }
    return root.open(payloadJson || "{}")
  }

  function finishClose() {
    sharedVideoPlayer.stop()
    backgroundPollTimer.stop()
    thumbnailCaptureBatchTimer.stop()
    root.backgroundRequestGeneration += 1
    if (backgroundSourceProcess.running) backgroundSourceProcess.running = false
    root.thumbnailCapturesEnabled = false
    root.stageReady = false
    root.keyboardSelecting = false
    root.windowCapturesEnabled = false
    root.thumbnailWorkspaceBudget = 0
    root.opened = false
    root.closing = false
    root.windows = []
    root.totalWindowCount = 0
    root.workspaceIds = []
    root.desktopCache = ({})
    stageFreezeFrame.stop()
    stageThawTimer.stop()
    root.stageFrozen = false
    root.selectedIndex = -1
    root.editingWorkspaceId = -1
    root.windowDragActive = false
    root.windowDragIndex = -1
    root.windowDropWorkspaceId = -1
    root.windowDropAnimating = false
    root.pendingWindowToplevel = null
    root.pendingWindowWorkspaceId = -1
    if (root.pendingFocus.length > 0) pendingFocusTimer.restart()
  }

  function close() {
    if (!root.opened || root.closing) return
    root.editingWorkspaceId = -1
    root.windowDragActive = false
    thumbnailCaptureTimer.stop()
    thumbnailCaptureBatchTimer.stop()
    refreshTimer.stop()
    desktopRefreshTimer.stop()
    windowDropTimer.stop()
    windowDropCleanupTimer.stop()
    stageSettleTimer.stop()
    stageGiveUpTimer.stop()
    root.closing = true
    root.revealProgress = 0
    closeAnimationTimer.restart()
  }

  function selectWorkspace(workspaceId) {
    var nextId = Number(workspaceId)
    if (nextId <= 0 || nextId === root.selectedWorkspaceId) return
    root.selectedWorkspaceId = nextId
    if (stageFreezeFrame.running) {
      // The snapshot is being taken; the swap it is waiting for picks up
      // the latest selection.
    } else if (root.stageInteractive && !root.stageFrozen) {
      stageSnapshot.scheduleUpdate()
      stageFreezeFrame.frames = 0
      stageFreezeFrame.start()
    } else {
      root.refreshWindows("")
    }
    keyScope.forceActiveFocus()
  }

  // A new space's cards have no capture for their first frame or two, and
  // would flash their app icons. The outgoing stage is frozen into a snapshot
  // first, held over the new cards until each has its first frame, and let go.
  property bool stageFrozen: false

  function swapFrozenStage() {
    if (!root.opened || root.closing) return
    root.stageFrozen = true
    root.refreshWindows("")
    stageThawTimer.restart()
    Qt.callLater(root.thawStageIfCaptured)
  }

  function thawStageIfCaptured() {
    if (root.stageFrozen && root.stageCaptured) root.thawStage()
  }

  function thawStage() {
    stageThawTimer.stop()
    root.stageFrozen = false
  }

  onStageCapturedChanged: root.thawStageIfCaptured()

  // Frame 1 renders the snapshot of the outgoing stage; the swap waits for
  // frame 2 so the new cards never end up in it.
  FrameAnimation {
    id: stageFreezeFrame
    property int frames: 0
    onTriggered: {
      frames += 1
      if (frames < 2) return
      stop()
      root.swapFrozenStage()
    }
  }

  Timer {
    id: stageThawTimer
    interval: 250
    repeat: false
    onTriggered: root.thawStage()
  }

  function workspaceSelector(workspaceId) {
    return '"' + Math.floor(Number(workspaceId)) + '"'
  }

  // Only a hex address is ever spliced into Lua; anything else yields an
  // empty selector, which Hyprland rejects without matching a window.
  function windowSelector(toplevel) {
    var address = WindowModel.stableAddress(toplevel).replace(/^0x/i, "")
    if (!/^[0-9A-Fa-f]{1,16}$/.test(address)) address = ""
    return '"address:' + (address ? "0x" + address : "") + '"'
  }


  function saveManagedSpaces(values) {
    if (!root.spaceService
        || typeof root.spaceService.setManagedSpaces !== "function") {
      console.warn("io.github.nobledoodle.omission: workspace state service is unavailable")
      return []
    }
    var next = root.spaceService.setManagedSpaces(values)
    if (root.opened && !root.closing)
      Qt.callLater(function() { root.refreshOverview() })
    return next
  }

  function spaceName(workspaceId) {
    return root.spaceService && typeof root.spaceService.spaceName === "function"
      ? root.spaceService.spaceName(workspaceId) : ""
  }

  function beginSpaceRename(workspaceId) {
    root.editingWorkspaceId = Math.floor(Number(workspaceId))
  }

  function cancelSpaceRename() {
    root.editingWorkspaceId = -1
    keyScope.forceActiveFocus()
  }

  function commitSpaceRename(workspaceId, value) {
    if (root.spaceService && typeof root.spaceService.setSpaceName === "function")
      root.spaceService.setSpaceName(workspaceId, value)
    root.editingWorkspaceId = -1
    keyScope.forceActiveFocus()
  }

  function runWorkspaceLua(lua, description) {
    if (workspaceProcess.running) {
      console.warn("io.github.nobledoodle.omission: workspace op still running, skipped " + description)
      return false
    }
    workspaceProcess.operation = description
    workspaceProcess.command = ["hyprctl", "eval", lua]
    workspaceProcess.running = true
    return true
  }

  function addWorkspace() {
    var nextId = WindowModel.nextFreeWorkspaceId(root.workspaceIds, 10)
    if (nextId <= 0) return

    var nextManaged = root.managedWorkspaceIds.slice()
    nextManaged.push(nextId)
    root.saveManagedSpaces(nextManaged)
    runWorkspaceLua(
      'hl.dispatch(hl.dsp.focus({ workspace = ' + root.workspaceSelector(nextId) + ' }))',
      "add workspace")
    root.selectWorkspace(nextId)
  }

  function removeWorkspace(workspaceId) {
    var removedId = Math.floor(Number(workspaceId))
    var neighbor = WindowModel.removalNeighbor(root.workspaceIds, removedId)
    if (removedId <= 0 || neighbor <= 0) return

    var nextManaged = []
    for (var i = 0; i < root.managedWorkspaceIds.length; i++) {
      if (root.managedWorkspaceIds[i] !== removedId)
        nextManaged.push(root.managedWorkspaceIds[i])
    }
    root.saveManagedSpaces(nextManaged)
    if (root.spaceService && typeof root.spaceService.setSpaceName === "function")
      root.spaceService.setSpaceName(removedId, "")

    var lua = [
      'hl.dispatch(hl.dsp.focus({ workspace = ' + root.workspaceSelector(neighbor) + ' }))'
    ]
    var handles = WindowModel.visibleToplevels(
      Hyprland.toplevels.values, removedId, root.targetMonitorId)
    for (var j = 0; j < handles.length; j++) {
      lua.push('hl.dispatch(hl.dsp.window.move({ window = ' + root.windowSelector(handles[j])
        + ', workspace = ' + root.workspaceSelector(neighbor) + ', follow = false }))')
    }

    runWorkspaceLua(lua.join("\n"), "remove workspace " + removedId)
    if (root.selectedWorkspaceId === removedId) root.selectedWorkspaceId = neighbor
  }

  function commitReorder(fromIndex, toIndex) {
    if (fromIndex === toIndex) return
    var currentIds = root.workspaceIds
    var desiredIds = WindowModel.moveArrayValue(currentIds, fromIndex, toIndex)
    if (!desiredIds) return

    var maxId = 0
    for (var i = 0; i < currentIds.length; i++)
      maxId = Math.max(maxId, Math.floor(Number(currentIds[i]) || 0))

    var actualIds = WindowModel.workspaceIds(
      Hyprland.workspaces.values, root.targetMonitorId, -1, [])
    var moves = WindowModel.reassignPlan(
      currentIds, desiredIds, 1000 + maxId, actualIds)
    if (moves.length > 0) {
      var lua = []
      for (var j = 0; j < moves.length; j++) {
        lua.push('hl.dispatch(hl.dsp.workspace.change_id({ workspace = '
          + root.workspaceSelector(moves[j].workspace) + ', id = '
          + Math.floor(moves[j].id) + ' }))')
      }
      runWorkspaceLua(lua.join("\n"), "reorder workspaces")
    }
    if (root.spaceService && typeof root.spaceService.remapNames === "function")
      root.spaceService.remapNames(currentIds, desiredIds)

    root.saveManagedSpaces(WindowModel.remapWorkspaceIds(
      root.managedWorkspaceIds, currentIds, desiredIds))
    var selectedPosition = desiredIds.indexOf(root.selectedWorkspaceId)
    if (selectedPosition >= 0) {
      root.selectedWorkspaceId = currentIds[selectedPosition]
      root.refreshWindows("")
    }
  }

  function nudgeSelectedWorkspace(direction) {
    var index = root.workspaceIds.indexOf(root.selectedWorkspaceId)
    if (index < 0) return
    var target = index + (Number(direction) < 0 ? -1 : 1)
    if (target < 0 || target >= root.workspaceIds.length) return
    root.commitReorder(index, target)
  }

  function selectAdjacentWorkspace(direction) {
    var index = root.workspaceIds.indexOf(root.selectedWorkspaceId)
    if (index < 0) return
    var target = index + (Number(direction) < 0 ? -1 : 1)
    if (target < 0 || target >= root.workspaceIds.length) return
    root.selectWorkspace(root.workspaceIds[target])
  }

  function activateWorkspace() {
    if (root.selectedWorkspaceId <= 0) {
      root.close()
      return
    }

    var workspaceId = root.selectedWorkspaceId
    root.focusAfterClose(['hl.dsp.focus({ workspace = "' + workspaceId + '" })'])
    root.close()
  }

  function activateWindow(index) {
    if (index < 0 || index >= root.windows.length) {
      root.activateWorkspace()
      return
    }

    var selectedStableId = String(root.windows[index].stableId || "")
    var live = SwitcherModel.findSwitchableByStableId(
      Hyprland.toplevels.values, selectedStableId,
      root.targetMonitorId, root.selectedWorkspaceId)
    if (live && /^[0-9A-Fa-f]+$/.test(selectedStableId))
      root.focusAfterClose([
        'hl.dsp.focus({ window = "stableid:' + selectedStableId + '" })',
        'hl.dsp.window.bring_to_top()'
      ])
    root.close()
  }

  function activateSelected() {
    root.activateWindow(root.selectedIndex)
  }

  function closeWindow(index) {
    if (index < 0 || index >= root.windows.length) return
    var toplevel = root.windows[index].captureSource
    if (toplevel) toplevel.close()
    if (root.opened && !root.closing) refreshTimer.restart()
  }

  function moveWindowToWorkspace(toplevel, workspaceId) {
    var destination = Math.floor(Number(workspaceId))
    if (!toplevel || destination <= 0 || destination === root.selectedWorkspaceId
        || root.workspaceIds.indexOf(destination) === -1) return false

    return root.runWorkspaceLua(
      'hl.dispatch(hl.dsp.window.move({ window = ' + root.windowSelector(toplevel)
        + ', workspace = ' + root.workspaceSelector(destination)
        + ', follow = false }))',
      "move window to space " + destination)
  }

  function moveSelectedWindowToWorkspace(workspaceId) {
    if (root.selectedIndex < 0 || root.selectedIndex >= root.windows.length) return false
    var item = windowRepeater.itemAt(root.selectedIndex)
    return item && typeof item.animateToWorkspace === "function"
      ? item.animateToWorkspace(workspaceId) : false
  }

  function moveSelection(horizontal, vertical) {
    root.keyboardSelecting = true
    root.selectedIndex = WindowModel.spatialNeighborIndex(
      root.stageRects(), root.selectedIndex, horizontal, vertical)
  }

  function workspaceNumberForKey(key) {
    var plain = [
      Qt.Key_1, Qt.Key_2, Qt.Key_3, Qt.Key_4, Qt.Key_5,
      Qt.Key_6, Qt.Key_7, Qt.Key_8, Qt.Key_9
    ]
    var shifted = [
      Qt.Key_Exclam, Qt.Key_At, Qt.Key_NumberSign, Qt.Key_Dollar,
      Qt.Key_Percent, Qt.Key_AsciiCircum, Qt.Key_Ampersand,
      Qt.Key_Asterisk, Qt.Key_ParenLeft
    ]
    var index = plain.indexOf(key)
    if (index < 0) index = shifted.indexOf(key)
    return index < 0 ? -1 : index + 1
  }





  function status(_argument) {
    return JSON.stringify({
      open: root.opened,
      closing: root.closing,
      revealProgress: root.revealProgress,
      monitor: root.targetMonitorName,
      workspace: root.selectedWorkspaceId,
      workspaceCount: root.workspaceIds.length,
      workspaceIds: root.workspaceIds,
      selectedIndex: root.selectedIndex,
      selectedHasToplevel: root.selectedIndex >= 0
        && root.selectedIndex < root.windows.length
        && !!root.windows[root.selectedIndex].toplevel,
      windowCount: root.windows.length,
      totalWindowCount: root.totalWindowCount,
      windowCountCapped: root.totalWindowCount > root.windows.length,
      omittedWindowCount: Math.max(0, root.totalWindowCount - root.windows.length),
      maxOverviewWindows: root.maxOverviewWindows,
      maxSpaceThumbnailWindows: root.maxSpaceThumbnailWindows,
      hyprlandToplevelCount: Hyprland.toplevels.values.length,
      foreignToplevelCount: root.foreignToplevelCount,
      backgroundPath: root.backgroundPath,
      backgroundKind: root.backgroundKind,
      backgroundSource: root.backgroundSource,
      videoFrameReady: root.videoFrameReady,
      videoPlaybackState: sharedVideoPlayer.playbackState,
      selectedAddress: root.currentSelectedAddress()
    })
  }

  function interactionRect(item) {
    if (!item) return null
    var point = item.mapToItem(keyScope, 0, 0)
    return {
      x: point.x,
      y: point.y,
      width: item.width,
      height: item.height,
      centerX: point.x + item.width / 2,
      centerY: point.y + item.height / 2
    }
  }

  function interactionGeometry(_argument) {
    var spaces = []
    for (var i = 0; i < workspaceRepeater.count; i++) {
      var space = workspaceRepeater.itemAt(i)
      if (!space) continue
      spaces.push({
        index: i,
        id: Number(space.modelData),
        rect: root.interactionRect(space),
        removeRect: root.interactionRect(space.removeButtonItem),
        renameRect: root.interactionRect(space.renameButtonItem),
        name: String(space.displayName || ""),
        windowCount: Number(space.windowCount),
        renderedWindowCount: Number(space.renderedWindowCount)
      })
    }

    var windows = []
    for (var j = 0; j < windowRepeater.count; j++) {
      var windowItem = windowRepeater.itemAt(j)
      if (!windowItem) continue
      windows.push({
        index: j,
        address: String(windowItem.modelData.address || ""),
        rect: root.interactionRect(windowItem.cardItem),
        closeRect: root.interactionRect(windowItem.closeButtonItem)
      })
    }

    return JSON.stringify({
      open: root.opened,
      closing: root.closing,
      revealProgress: root.revealProgress,
      width: keyScope.width,
      height: keyScope.height,
      selectedWorkspaceId: root.selectedWorkspaceId,
      selectedWindowIndex: root.selectedIndex,
      gridColumns: root.gridColumns,
      spaceRail: root.interactionRect(workspaceRail),
      spaces: spaces,
      addRect: root.interactionRect(addWorkspaceButton),
      windows: windows,
      backgroundPoint: {
        x: Math.max(1, keyScope.width - 4),
        y: Math.max(1, keyScope.height - 4)
      }
    })
  }

  Connections {
    target: Hyprland
    function onRawEvent(_event) {
      if (root.opened && !root.closing) {
        refreshTimer.restart()
        desktopRefreshTimer.restart()
      }
    }
  }

  Connections {
    target: Hyprland.toplevels
    function onValuesChanged() {
      if (root.opened && !root.closing) {
        refreshTimer.restart()
        desktopRefreshTimer.restart()
      }
    }
  }

  Connections {
    target: Hyprland.workspaces
    function onValuesChanged() {
      if (root.opened && !root.closing) refreshTimer.restart()
    }
  }



  Timer {
    id: backgroundPollTimer
    interval: 5000
    repeat: true
    onTriggered: root.refreshBackgroundSource()
  }

  Timer {
    id: closeAnimationTimer
    interval: root.closeDuration + 24
    repeat: false
    onTriggered: root.finishClose()
  }

  Timer {
    id: thumbnailCaptureTimer
    interval: 270
    repeat: false
    onTriggered: {
      if (!root.opened || root.closing) return
      root.thumbnailCapturesEnabled = true
    }
  }

  Timer {
    id: thumbnailCaptureBatchTimer
    interval: 34
    repeat: true
    onTriggered: {
      if (!root.opened || root.closing
          || root.thumbnailWorkspaceBudget >= root.workspaceIds.length) {
        stop()
        return
      }
      root.thumbnailWorkspaceBudget += 1
    }
  }

  Timer {
    id: refreshTimer
    interval: 45
    repeat: false
    onTriggered: if (root.opened && !root.closing) root.refreshOverview()
  }

  Timer {
    id: desktopRefreshTimer
    interval: 120
    repeat: false
    onTriggered: if (root.opened && !root.closing) root.desktopRevision += 1
  }

  Timer {
    id: windowDropTimer
    interval: 180
    repeat: false
    onTriggered: {
      root.moveWindowToWorkspace(
        root.pendingWindowToplevel, root.pendingWindowWorkspaceId)
      windowDropCleanupTimer.restart()
    }
  }

  Timer {
    id: windowDropCleanupTimer
    interval: 100
    repeat: false
    onTriggered: {
      root.windowDropAnimating = false
      root.windowDragActive = false
      root.windowDragIndex = -1
      root.windowDropWorkspaceId = -1
      root.pendingWindowToplevel = null
      root.pendingWindowWorkspaceId = -1
    }
  }

  Process {
    id: workspaceProcess
    environment: root.trustedEnvironment
    property string operation: ""
    stdout: StdioCollector { id: workspaceStdout; waitForEnd: true }
    stderr: StdioCollector { id: workspaceStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        var detail = String(workspaceStdout.text || workspaceStderr.text || "").trim()
        console.warn("io.github.nobledoodle.omission: failed to " + operation
          + " (exit " + exitCode + ")" + (detail ? ": " + detail : ""))
      }
      if (root.opened && !root.closing) {
        Hyprland.refreshWorkspaces()
        Hyprland.refreshToplevels()
        refreshTimer.restart()
        desktopRefreshTimer.restart()
      }
    }
  }

  Process {
    id: backgroundSourceProcess
    environment: root.trustedEnvironment
    property int requestGeneration: -1
    property string requestedMonitor: ""
    stdout: StdioCollector { id: backgroundSourceStdout; waitForEnd: true }
    stderr: StdioCollector { id: backgroundSourceStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (!root.opened || root.closing) return
      if (requestGeneration !== root.backgroundRequestGeneration
          || requestedMonitor !== root.targetMonitorName) {
        Qt.callLater(function() { root.refreshBackgroundSource() })
        return
      }
      if (exitCode !== 0) {
        var detail = String(
          backgroundSourceStderr.text || backgroundSourceStdout.text || "").trim()
        console.warn("io.github.nobledoodle.omission: background resolver failed (exit "
          + exitCode + ")" + (detail ? ": " + detail : ""))
        return
      }

      var record = root.parseBackgroundRecord(backgroundSourceStdout.text)
      if (!record) {
        console.warn("io.github.nobledoodle.omission: background resolver returned invalid JSON")
        return
      }
      root.applyBackgroundRecord(record)
    }
  }

  MediaPlayer {
    id: sharedVideoPlayer
    source: root.opened && root.thumbnailCapturesEnabled
      && root.backgroundKind === "video" && root.backgroundPath
      ? Util.fileUrl(root.backgroundPath) : ""
    videoOutput: sharedVideoOutput
    activeAudioTrack: -1
    audioOutput: AudioOutput {
      muted: true
      volume: 0
    }
    loops: MediaPlayer.Infinite
    autoPlay: root.thumbnailCapturesEnabled
    onErrorOccurred: function(error, errorString) {
      if (error !== MediaPlayer.NoError)
        console.warn("io.github.nobledoodle.omission: video wallpaper failed: " + errorString)
    }
  }


  PanelWindow {
    id: panel

    visible: root.opened
    screen: root.monitorScreen(root.targetMonitorName)
    anchors { top: true; right: true; bottom: true; left: true }
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "omission"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: root.stageReady
      && (!root.closing || root.pendingFocus.length > 0)
      ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None

    FocusScope {
      id: keyScope
      anchors.fill: parent
      focus: root.opened
      opacity: root.stageReady ? 1 : 0
      scale: 1

      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) {
        var vimModifiers = event.modifiers === Qt.NoModifier
          || event.modifiers === Qt.ShiftModifier
        var workspaceNumber = root.workspaceNumberForKey(event.key)
        if (root.editingWorkspaceId >= 0) {
          event.accepted = false
          return
        }
        if (event.key === Qt.Key_Escape || (event.key === Qt.Key_Q && vimModifiers)) {
          root.close()
          event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
          root.activateSelected()
          event.accepted = true
        } else if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
          var reverse = event.key === Qt.Key_Backtab || !!(event.modifiers & Qt.ShiftModifier)
          root.cycleSelection(reverse ? -1 : 1)
          event.accepted = true
        } else if (event.key === Qt.Key_Left && (event.modifiers & Qt.ShiftModifier)) {
          root.nudgeSelectedWorkspace(-1)
          event.accepted = true
        } else if (event.key === Qt.Key_Right && (event.modifiers & Qt.ShiftModifier)) {
          root.nudgeSelectedWorkspace(1)
          event.accepted = true
        } else if (event.key === Qt.Key_Left && (event.modifiers & Qt.ControlModifier)) {
          root.selectAdjacentWorkspace(-1)
          event.accepted = true
        } else if (event.key === Qt.Key_Right && (event.modifiers & Qt.ControlModifier)) {
          root.selectAdjacentWorkspace(1)
          event.accepted = true
        } else if (event.key === Qt.Key_Left || (event.key === Qt.Key_H && vimModifiers)) {
          root.moveSelection(-1, 0)
          event.accepted = true
        } else if (event.key === Qt.Key_Right || (event.key === Qt.Key_L && vimModifiers)) {
          root.moveSelection(1, 0)
          event.accepted = true
        } else if (event.key === Qt.Key_Up || (event.key === Qt.Key_K && vimModifiers)) {
          root.moveSelection(0, -1)
          event.accepted = true
        } else if (event.key === Qt.Key_Down || (event.key === Qt.Key_J && vimModifiers)) {
          root.moveSelection(0, 1)
          event.accepted = true
        } else if (workspaceNumber > 0) {
          var workspaceId = workspaceNumber
          if (root.workspaceIds.indexOf(workspaceId) !== -1) {
            if (event.modifiers & Qt.ShiftModifier)
              root.moveSelectedWindowToWorkspace(workspaceId)
            else
              root.selectWorkspace(workspaceId)
            event.accepted = true
          }
        }
      }

      VideoOutput {
        id: sharedVideoOutput
        x: -width - Style.space(1)
        width: Math.max(1, workspaceRail.chipWidth)
        height: Math.max(1, workspaceRail.chipHeight)
        z: -1
        visible: root.opened && root.backgroundKind === "video"
        fillMode: VideoOutput.PreserveAspectCrop
      }

      // The desktop's wallpaper, decoded once at the screen's own size so every
      // copy below shares one texture through the image cache.
      Image {
        id: wallpaperSource
        visible: false
        source: root.backgroundKind === "image" && root.backgroundPath
          ? Util.fileUrl(root.backgroundPath) : ""
        fillMode: Image.PreserveAspectCrop
        sourceSize.width: panel.screen
          ? Math.ceil(panel.screen.width * (panel.screen.devicePixelRatio || 1)) : 0
        sourceSize.height: panel.screen
          ? Math.ceil(panel.screen.height * (panel.screen.devicePixelRatio || 1)) : 0
        asynchronous: true
        cache: true
        smooth: true
      }

      Item {
        id: backdrop
        anchors.fill: parent

        // Without a still wallpaper (none, or a video), a plain themed ground.
        Rectangle {
          anchors.fill: parent
          color: root.backgroundColor
          opacity: root.revealProgress
        }

        // The whole screen, bar strip included, fades in with the reveal:
        // nothing in the overview stands in for the bar.
        Image {
          anchors.fill: parent
          source: wallpaperSource.source
          sourceSize: wallpaperSource.sourceSize
          fillMode: Image.PreserveAspectCrop
          asynchronous: true
          cache: true
          smooth: true
          opacity: root.revealProgress
        }

        // Where the windows live: solid from the first frame whenever the cards
        // stand in for the real windows, so the desktop becomes the overview
        // with no cross-fade and nothing showing through twice.
        Item {
          id: workArea
          x: root.usableArea.x
          y: root.usableArea.y
          width: root.usableArea.width
          height: root.usableArea.height
          clip: true
          opacity: root.handOver ? 1 : root.revealProgress

          Image {
            id: workAreaWallpaper
            x: -workArea.x
            y: -workArea.y
            width: backdrop.width
            height: backdrop.height
            source: wallpaperSource.source
            sourceSize: wallpaperSource.sourceSize
            fillMode: Image.PreserveAspectCrop
            asynchronous: true
            cache: true
            smooth: true
          }
        }

        MouseArea {
          anchors.fill: parent
          onClicked: root.close()
        }
      }

      Item {
        id: overview
        anchors.fill: parent

        Rectangle {
          id: workspaceRail
          opacity: root.revealProgress
          scale: 1
          readonly property real monitorAspect: root.overviewMonitor
            && root.overviewMonitor.height > 0
            ? root.overviewMonitor.width / root.overviewMonitor.height : 16 / 9
          readonly property real chipSpacing: Math.max(Style.spacing.sm, 10)
          readonly property real chipWidth: Math.max(160, Math.min(420,
            (overview.width - 220 - root.workspaceIds.length * chipSpacing)
              / Math.max(1, root.workspaceIds.length)))
          readonly property real chipHeight: Math.max(72, Math.min(220,
            chipWidth / monitorAspect))

          x: 0
          y: -height * (1 - root.revealProgress)
          width: parent.width
          height: root.railHeight
          radius: 0
          color: "transparent"
          border.width: 0

          MouseArea { anchors.fill: parent; onClicked: function(mouse) { mouse.accepted = true } }

          // A frosted strip across the top: the wallpaper behind it, blurred
          // once into a cached layer, under the theme's background color
          // (colors.toml `background`, which follows theme switches) with just
          // enough of the blur left to read as glass.
          Item {
            anchors.fill: parent
            clip: true

            MultiEffect {
              y: -workspaceRail.y
              width: backdrop.width
              height: backdrop.height
              source: wallpaperSource
              visible: wallpaperSource.status === Image.Ready
              blurEnabled: true
              blur: 1
              blurMax: 64
              autoPaddingEnabled: false
              layer.enabled: true
            }
          }

          Rectangle {
            anchors.fill: parent
            color: Util.alpha(Color.background, 0.85)
          }

          Row {
            id: workspaceRow
            anchors.centerIn: parent
            spacing: workspaceRail.chipSpacing

            Repeater {
              id: workspaceRepeater
              model: root.workspaceIds

              Rectangle {
                id: workspaceChip
                required property int modelData
                required property int index
                property alias removeButtonItem: removeSpaceButton
                property alias renameButtonItem: renameSpaceButton
                readonly property string customName: root.spaceService
                  && root.spaceService.namesLoaded
                  ? String(root.spaceService.spaceNames[String(modelData)] || "") : ""
                readonly property string displayName: customName || ("Space " + modelData)
                readonly property var previewModel: root.desktopCaptureModel(modelData)
                readonly property int windowCount: previewModel.totalCount
                readonly property int omittedWindowCount: previewModel.omittedCount
                readonly property int renderedWindowCount: thumbnailWindowRepeater.count
                readonly property bool windowDropTarget: (root.windowDragActive
                  || root.windowDropAnimating) && root.windowDropWorkspaceId === modelData
                readonly property bool selected: modelData === root.selectedWorkspaceId
                property bool hovered: false
                property real dragOffset: 0

                width: workspaceRail.chipWidth
                height: workspaceRail.chipHeight
                radius: root.hyprRounding
                color: windowDropTarget || selected
                  ? root.selectedColor : Util.alpha(root.backgroundColor, 0.55)
                border.color: windowDropTarget
                  ? root.selectedBorderColor : root.hyprDeco.inactive
                border.width: windowDropTarget ? 3 : 1
                z: root.dragActive && root.dragFromIndex === index ? 20 : 1
                scale: windowDropTarget ? 1.02
                  : (root.dragActive && root.dragFromIndex === index ? 1.02 : 1)
                transform: Translate { x: workspaceChip.dragOffset }

                Behavior on scale { NumberAnimation { duration: 120; easing.type: Easing.OutCubic } }

                ClippingRectangle {
                  id: desktopSurface
                  anchors.fill: parent
                  radius: workspaceChip.radius
                  color: "transparent"

                  Rectangle {
                    anchors.fill: parent
                    color: workspaceChip.color
                  }

                  Image {
                    anchors.fill: parent
                    visible: root.backgroundKind === "image" && !!root.backgroundPath
                    source: visible ? Util.fileUrl(root.backgroundPath) : ""
                    fillMode: Image.PreserveAspectCrop
                    asynchronous: true
                    cache: true
                    smooth: true
                  }

                  ShaderEffectSource {
                    anchors.fill: parent
                    visible: root.videoFrameReady && root.thumbnailCapturesEnabled
                      && (workspaceChip.selected
                        || workspaceChip.index < root.thumbnailWorkspaceBudget)
                    sourceItem: root.opened && root.thumbnailCapturesEnabled
                      && root.backgroundKind === "video"
                      && (workspaceChip.selected
                        || workspaceChip.index < root.thumbnailWorkspaceBudget)
                      ? sharedVideoOutput : null
                    sourceRect: Qt.rect(
                      0, 0, sharedVideoOutput.width, sharedVideoOutput.height)
                    hideSource: true
                    live: false
                    onVisibleChanged: if (visible) scheduleUpdate()
                    smooth: true
                  }

                  Rectangle {
                    anchors.fill: parent
                    color: Util.alpha(root.scrimColor, 0.12)
                  }

                  Repeater {
                    id: thumbnailWindowRepeater
                    model: workspaceChip.previewModel.items

                    Item {
                      id: thumbnailWindow
                      required property var modelData
                      readonly property var geometry: root.thumbnailRect(
                        modelData, desktopSurface.width, desktopSurface.height)

                      visible: geometry !== null && !!modelData.wayland
                      x: geometry ? geometry.x : 0
                      y: geometry ? geometry.y : 0
                      width: geometry ? geometry.width : 0
                      height: geometry ? geometry.height : 0

                      ClippingRectangle {
                        anchors.fill: parent
                        radius: {
                          var size = WindowModel.valuesOf(
                            WindowModel.metadata(thumbnailWindow.modelData).size)
                          var realWidth = Number(size[0]) || 0
                          return realWidth > 0
                            ? root.hyprRounding * thumbnailWindow.width / realWidth : 0
                        }
                        // ClippingRectangle paints white under its content by default.
                        color: "transparent"

                        ScreencopyView {
                          anchors.fill: parent
                          captureSource: root.windowCapturesEnabled
                            && (workspaceChip.selected
                              || workspaceChip.index < root.thumbnailWorkspaceBudget)
                            ? thumbnailWindow.modelData.wayland : null
                          live: false
                          paintCursor: false
                        }
                      }
                    }
                  }

                  Rectangle {
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.bottom: parent.bottom
                    height: Math.min(44, Math.max(34, parent.height * 0.36))
                    color: Util.alpha(root.backgroundColor, 0.94)
                    z: 5

                    Rectangle {
                      anchors.top: parent.top
                      anchors.left: parent.left
                      anchors.right: parent.right
                      height: 1
                      color: root.hyprDeco.inactive
                    }

                    Row {
                      anchors.fill: parent
                      anchors.leftMargin: 12
                      anchors.rightMargin: 12
                      spacing: 10

                      Text {
                        width: Math.max(0, parent.width - windowCountLabel.width - parent.spacing)
                        anchors.verticalCenter: parent.verticalCenter
                        text: workspaceChip.displayName
                        textFormat: Text.PlainText
                        color: root.foregroundColor
                        font.family: Style.font.menuFamily
                        font.pixelSize: workspaceChip.customName
                          ? Math.max(Style.font.title, 18)
                          : Math.max(Style.font.body, 14)
                        font.weight: workspaceChip.customName ? Font.Bold : Font.DemiBold
                        elide: Text.ElideRight
                      }

                      Text {
                        id: windowCountLabel
                        anchors.verticalCenter: parent.verticalCenter
                        text: workspaceChip.renderedWindowCount < workspaceChip.windowCount
                          ? workspaceChip.renderedWindowCount + " of "
                            + workspaceChip.windowCount + " windows"
                          : workspaceChip.windowCount === 1
                            ? "1 window" : workspaceChip.windowCount + " windows"
                        color: root.foregroundColor
                        opacity: 0.68
                        font.family: Style.font.menuFamily
                        font.pixelSize: Math.max(Style.font.caption, 12)
                      }
                    }
                  }

                  Rectangle {
                    anchors.fill: parent
                    color: "transparent"
                    radius: workspaceChip.radius
                    border.color: workspaceChip.windowDropTarget
                      ? root.selectedBorderColor : root.hyprDeco.inactive
                    border.width: workspaceChip.windowDropTarget ? 3 : 1
                    z: 6
                  }
                }

                Rectangle {
                  x: -3
                  y: -3
                  width: parent.width + 6
                  height: parent.height + 6
                  radius: workspaceChip.radius > 0 ? workspaceChip.radius + 3 : 0
                  color: "transparent"
                  border.width: 3
                  border.color: root.hyprDeco.active
                  opacity: workspaceChip.selected ? 1 : 0
                  visible: opacity > 0.01

                  Behavior on opacity {
                    enabled: root.stageInteractive
                    NumberAnimation { duration: 120; easing.type: Easing.OutCubic }
                  }
                }

                MouseArea {
                  id: workspaceDrag
                  anchors.fill: parent
                  enabled: !root.windowDragActive && !root.windowDropAnimating
                    && root.editingWorkspaceId < 0
                  hoverEnabled: true
                  cursorShape: root.dragActive ? Qt.ClosedHandCursor : Qt.OpenHandCursor
                  preventStealing: true
                  property real pressRowX: 0
                  property bool moved: false

                  onEntered: workspaceChip.hovered = true
                  onExited: workspaceChip.hovered = false
                  onPressed: function(mouse) {
                    var point = mapToItem(workspaceRow, mouse.x, mouse.y)
                    pressRowX = point.x
                    moved = false
                    root.dragActive = true
                    root.dragFromIndex = workspaceChip.index
                    root.dragTargetIndex = workspaceChip.index
                  }
                  onPositionChanged: function(mouse) {
                    if (!pressed) return
                    var point = mapToItem(workspaceRow, mouse.x, mouse.y)
                    workspaceChip.dragOffset = point.x - pressRowX
                    if (Math.abs(workspaceChip.dragOffset) > 6) moved = true

                    var step = workspaceRail.chipWidth + workspaceRail.chipSpacing
                    var target = Math.round((workspaceChip.x + workspaceChip.dragOffset) / step)
                    root.dragTargetIndex = Math.max(0, Math.min(root.workspaceIds.length - 1, target))
                  }
                  onReleased: {
                    var from = root.dragFromIndex
                    var to = root.dragTargetIndex
                    workspaceChip.dragOffset = 0
                    root.dragActive = false
                    root.dragFromIndex = -1
                    root.dragTargetIndex = -1
                    if (moved) root.commitReorder(from, to)
                  }
                  onCanceled: {
                    workspaceChip.dragOffset = 0
                    root.dragActive = false
                    root.dragFromIndex = -1
                    root.dragTargetIndex = -1
                  }
                  onClicked: if (!moved) root.selectWorkspace(workspaceChip.modelData)
                  onDoubleClicked: if (!moved) {
                    root.selectWorkspace(workspaceChip.modelData)
                    root.activateWorkspace()
                  }
                }

                Rectangle {
                  id: removeSpaceButton
                  visible: workspaceChip.hovered && !root.dragActive
                    && !root.windowDragActive && root.editingWorkspaceId < 0
                    && root.workspaceIds.length > 1
                  anchors.top: parent.top
                  anchors.right: parent.right
                  anchors.margins: 4
                  width: 22
                  height: 22
                  radius: width / 2
                  color: Util.alpha(root.backgroundColor, 0.78)
                  z: 30

                  Text {
                    anchors.centerIn: parent
                    text: "×"
                    color: root.foregroundColor
                    font.pixelSize: Style.font.body
                    font.weight: Font.DemiBold
                  }

                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: function(mouse) {
                      mouse.accepted = true
                      root.removeWorkspace(workspaceChip.modelData)
                    }
                  }
                }

                Rectangle {
                  id: renameSpaceButton
                  visible: workspaceChip.hovered && !root.dragActive
                    && !root.windowDragActive && root.editingWorkspaceId < 0
                  anchors.top: parent.top
                  anchors.left: parent.left
                  anchors.margins: 4
                  width: 44
                  height: 22
                  radius: height / 2
                  color: Util.alpha(root.backgroundColor, 0.78)
                  z: 30

                  Text {
                    anchors.centerIn: parent
                    text: "Edit"
                    color: root.foregroundColor
                    font.family: Style.font.menuFamily
                    font.pixelSize: Style.font.caption
                    font.weight: Font.DemiBold
                  }

                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: function(mouse) {
                      mouse.accepted = true
                      root.beginSpaceRename(workspaceChip.modelData)
                    }
                  }
                }

                Rectangle {
                  visible: root.editingWorkspaceId === workspaceChip.modelData
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.bottom: parent.bottom
                  anchors.margins: 4
                  height: 34
                  radius: 8
                  color: Util.alpha(root.backgroundColor, 0.97)
                  border.color: root.selectedBorderColor
                  border.width: 2
                  z: 40

                  TextInput {
                    id: spaceNameInput
                    anchors.fill: parent
                    anchors.margins: 7
                    maximumLength: 32
                    selectByMouse: true
                    color: root.foregroundColor
                    selectionColor: root.selectedColor
                    selectedTextColor: root.selectedTextColor
                    font.family: Style.font.menuFamily
                    font.pixelSize: Style.font.body
                    verticalAlignment: TextInput.AlignVCenter

                    onVisibleChanged: if (visible) {
                      text = root.spaceName(workspaceChip.modelData)
                      forceActiveFocus()
                      selectAll()
                    }

                    Keys.onReturnPressed: function(event) {
                      root.commitSpaceRename(workspaceChip.modelData, text)
                      event.accepted = true
                    }
                    Keys.onEnterPressed: function(event) {
                      root.commitSpaceRename(workspaceChip.modelData, text)
                      event.accepted = true
                    }
                    Keys.onEscapePressed: function(event) {
                      root.cancelSpaceRename()
                      event.accepted = true
                    }
                  }
                }
              }
            }
          }

          Item {
            id: addWorkspaceButton
            visible: root.workspaceIds.length < 10
            anchors.right: parent.right
            anchors.rightMargin: root.stageMargin * 1.3
            anchors.verticalCenter: parent.verticalCenter
            width: Math.max(Style.space(44), 44)
            height: width

            Text {
              anchors.centerIn: parent
              text: "+"
              color: root.foregroundColor
              opacity: addWorkspaceMouse.containsMouse ? 1 : 0.72
              font.family: Style.font.menuFamily
              font.pixelSize: Math.max(Style.font.display, 26)
              font.weight: Font.Light

              Behavior on opacity { NumberAnimation { duration: 120 } }
            }

            MouseArea {
              id: addWorkspaceMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.addWorkspace()
            }
          }

          Rectangle {
            visible: root.dragActive && root.dragTargetIndex >= 0
              && root.dragTargetIndex !== root.dragFromIndex
            x: workspaceRow.x + root.dragTargetIndex
              * (workspaceRail.chipWidth + workspaceRail.chipSpacing)
              + (root.dragTargetIndex > root.dragFromIndex
                ? workspaceRail.chipWidth + workspaceRail.chipSpacing / 2
                : -workspaceRail.chipSpacing / 2)
            anchors.verticalCenter: workspaceRow.verticalCenter
            width: 3
            height: workspaceRail.chipHeight - 8
            radius: width / 2
            color: root.selectedBorderColor
            z: 40
          }
        }

        // The selected space as it is tiled: every window at its real place and
        // size, scaled into the stage and drawn bare. Its title shows on hover
        // (or keyboard selection) in the same bar the space cards use.
        Item {
          id: windowGrid
          anchors.fill: parent
          opacity: root.stageFrozen ? 0 : 1

          Repeater {
            id: windowRepeater
            model: root.windows

            Item {
              id: windowCell
              required property var modelData
              required property int index
              property alias cardItem: windowCard
              property alias closeButtonItem: closeButton
              readonly property bool selected: index === root.selectedIndex
              property bool hovered: false
              property real dragOffsetX: 0
              property real dragOffsetY: 0
              property real dragScale: 1
              readonly property bool beingDragged: root.windowDragIndex === index
                && (root.windowDragActive || root.windowDropAnimating)
              readonly property var metadata: WindowModel.metadata(modelData.toplevel)
              readonly property bool floating: windowCell.metadata.floating === true
              readonly property bool focusedWindow: !!(modelData.toplevel
                && modelData.toplevel.activated)
              readonly property var realRect: root.realRect(modelData.toplevel)
              readonly property var targetRect: root.stageRect(windowCell.realRect)
              readonly property bool onScreen: !!windowCell.realRect
                && windowCell.realRect.x < keyScope.width
                && windowCell.realRect.x + windowCell.realRect.width > 0
                && windowCell.realRect.y < keyScope.height
                && windowCell.realRect.y + windowCell.realRect.height > 0
              // On screen with nothing captured yet: the stage waits for it.
              readonly property bool waiting: windowCell.onScreen
                && !!modelData.captureSource && !preview.hasContent
              readonly property real cornerRadius: root.hyprRounding
                * (windowCell.realRect ? windowCell.width / windowCell.realRect.width : 1)
              readonly property bool showTitle: root.stageInteractive && !windowCell.beingDragged
                && (windowCell.hovered || (windowCell.selected && root.keyboardSelecting))
              // Floating windows over tiled ones, the most recent on top.
              z: windowCell.beingDragged ? 1000 : (windowCell.floating ? 500 : 100) - index
              visible: !!windowCell.realRect

              // From where the window really is to where it sits in the stage.
              x: windowCell.realRect && windowCell.targetRect
                ? windowCell.realRect.x
                  + (windowCell.targetRect.x - windowCell.realRect.x) * root.revealProgress
                : 0
              y: windowCell.realRect && windowCell.targetRect
                ? windowCell.realRect.y
                  + (windowCell.targetRect.y - windowCell.realRect.y) * root.revealProgress
                : 0
              width: windowCell.realRect && windowCell.targetRect
                ? windowCell.realRect.width
                  + (windowCell.targetRect.width - windowCell.realRect.width) * root.revealProgress
                : 0
              height: windowCell.realRect && windowCell.targetRect
                ? windowCell.realRect.height
                  + (windowCell.targetRect.height - windowCell.realRect.height) * root.revealProgress
                : 0

              function animateToWorkspace(workspaceId) {
                var destination = Math.floor(Number(workspaceId))
                if (!modelData.toplevel || destination <= 0
                    || destination === root.selectedWorkspaceId
                    || root.workspaceIds.indexOf(destination) === -1
                    || workspaceProcess.running) return false

                var targetIndex = root.workspaceIds.indexOf(destination)
                var step = workspaceRail.chipWidth + workspaceRail.chipSpacing
                var targetCenter = workspaceRow.mapToItem(
                  overview, targetIndex * step + workspaceRail.chipWidth / 2,
                  workspaceRail.chipHeight / 2)
                var currentCenter = windowCard.mapToItem(
                  overview, windowCard.width / 2, windowCard.height / 2)

                root.pendingWindowToplevel = modelData.toplevel
                root.pendingWindowWorkspaceId = destination
                root.windowDragIndex = index
                root.windowDropWorkspaceId = destination
                root.windowDropAnimating = true
                root.windowDragActive = false
                dragOffsetX += targetCenter.x - currentCenter.x
                dragOffsetY += targetCenter.y - currentCenter.y
                dragScale = Math.max(0.08, Math.min(
                  workspaceRail.chipWidth * 0.72 / Math.max(1, windowCard.width),
                  workspaceRail.chipHeight * 0.72 / Math.max(1, windowCard.height)))
                windowDropTimer.restart()
                return true
              }
              Behavior on dragOffsetX {
                enabled: root.windowDropAnimating
                NumberAnimation { duration: 170; easing.type: Easing.InOutCubic }
              }
              Behavior on dragOffsetY {
                enabled: root.windowDropAnimating
                NumberAnimation { duration: 170; easing.type: Easing.InOutCubic }
              }
              onBeingDraggedChanged: if (!beingDragged) {
                dragOffsetX = 0
                dragOffsetY = 0
                dragScale = 1
              }

              Item {
                id: windowCard
                anchors.fill: parent
                transform: Translate {
                  x: windowCell.dragOffsetX
                  y: windowCell.dragOffsetY
                }
                scale: windowCell.beingDragged ? windowCell.dragScale : 1
                opacity: root.windowDropAnimating && windowCell.beingDragged
                  ? 0.28 : (root.handOver ? 1 : root.revealProgress)

                Behavior on scale {
                  NumberAnimation { duration: 120; easing.type: Easing.OutCubic }
                }

                // Hyprland's own border, worn while the card stands in for the
                // window and shed as it shrinks into the stage.
                Rectangle {
                  readonly property real thickness: Number(root.hyprDeco.border) || 0
                  x: -thickness
                  y: -thickness
                  width: parent.width + 2 * thickness
                  height: parent.height + 2 * thickness
                  radius: windowCell.cornerRadius > 0 ? windowCell.cornerRadius + thickness : 0
                  color: "transparent"
                  border.width: thickness
                  border.color: windowCell.focusedWindow
                    ? root.hyprDeco.active : root.hyprDeco.inactive
                  opacity: 1 - root.dress
                  visible: thickness > 0 && opacity > 0.01 && !windowCell.beingDragged
                }

                ClippingRectangle {
                  anchors.fill: parent
                  radius: windowCell.cornerRadius
                  // ClippingRectangle paints white under its content by default.
                  color: "transparent"

                  ScreencopyView {
                    id: preview
                    anchors.fill: parent
                    captureSource: windowCell.modelData.captureSource
                    paintCursor: false
                    // Live only until the first frame is in, and for the few
                    // frames at either end of the motion where the card hands
                    // over to or from the real window. Otherwise the shared
                    // capture beat refreshes it.
                    live: root.opened && (!hasContent
                      || (root.revealProgress > 0.0005 && root.revealProgress < 0.15))

                    Connections {
                      target: root
                      function onCaptureBeatChanged() {
                        if (!preview.live && preview.captureSource) preview.captureFrame()
                      }
                    }
                  }

                  Rectangle {
                    anchors.fill: parent
                    visible: !preview.hasContent
                    color: Util.alpha(root.backgroundColor, 0.72)
                    opacity: root.revealProgress

                    Image {
                      anchors.centerIn: parent
                      width: Math.min(parent.width, parent.height) * 0.24
                      height: width
                      source: String(windowCell.modelData.iconSource || "")
                      fillMode: Image.PreserveAspectFit
                      asynchronous: true
                      smooth: true
                      opacity: 0.8
                    }
                  }

                  // The window's title, in the same bar the space cards use.
                  Rectangle {
                    id: titleBar
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.bottom: parent.bottom
                    height: Math.min(44, Math.max(34, parent.height * 0.36))
                    color: Util.alpha(root.backgroundColor, 0.94)
                    opacity: windowCell.showTitle ? 1 : 0
                    visible: opacity > 0.01

                    Behavior on opacity {
                      NumberAnimation { duration: 120; easing.type: Easing.OutCubic }
                    }

                    Rectangle {
                      anchors.top: parent.top
                      anchors.left: parent.left
                      anchors.right: parent.right
                      height: 1
                      color: root.hyprDeco.inactive
                    }

                    Row {
                      anchors.fill: parent
                      anchors.leftMargin: 12
                      anchors.rightMargin: 12
                      spacing: 10

                      Text {
                        width: Math.max(0, parent.width - appNameLabel.width - parent.spacing)
                        anchors.verticalCenter: parent.verticalCenter
                        text: WindowModel.shortenedTitle(String(
                          (windowCell.modelData.toplevel && windowCell.modelData.toplevel.title)
                          || windowCell.modelData.title || ""), 120)
                        textFormat: Text.PlainText
                        color: root.foregroundColor
                        font.family: Style.font.menuFamily
                        font.pixelSize: Math.max(Style.font.body, 14)
                        font.weight: Font.DemiBold
                        elide: Text.ElideRight
                      }

                      Text {
                        id: appNameLabel
                        width: Math.min(implicitWidth, parent.width * 0.4)
                        anchors.verticalCenter: parent.verticalCenter
                        text: String(windowCell.modelData.appName || "Application")
                        textFormat: Text.PlainText
                        color: root.foregroundColor
                        opacity: 0.68
                        elide: Text.ElideRight
                        font.family: Style.font.menuFamily
                        font.pixelSize: Math.max(Style.font.caption, 12)
                      }
                    }
                  }
                }

                // A hairline once it is a card, and a selection ring in the
                // color Hyprland outlines the active window with.
                Rectangle {
                  anchors.fill: parent
                  radius: windowCell.cornerRadius
                  color: "transparent"
                  border.width: 1
                  border.color: Util.alpha(root.borderColor, 0.45)
                  opacity: root.dress
                }

                Rectangle {
                  x: -3
                  y: -3
                  width: parent.width + 6
                  height: parent.height + 6
                  radius: windowCell.cornerRadius > 0 ? windowCell.cornerRadius + 3 : 0
                  color: "transparent"
                  border.width: 3
                  border.color: root.hyprDeco.active
                  opacity: windowCell.selected && !windowCell.beingDragged ? root.dress : 0

                  Behavior on opacity {
                    enabled: root.stageInteractive
                    NumberAnimation { duration: 120; easing.type: Easing.OutCubic }
                  }
                }

                Rectangle {
                  id: closeButton
                  visible: windowCell.hovered && root.stageInteractive && !windowCell.beingDragged
                  anchors.top: parent.top
                  anchors.right: parent.right
                  anchors.margins: Math.max(Style.space(10), 10)
                  width: Math.max(Style.space(28), 28)
                  height: width
                  radius: width / 2
                  color: Util.alpha(root.backgroundColor, 0.92)
                  border.color: root.borderColor
                  border.width: 1
                  z: 3

                  Text {
                    anchors.centerIn: parent
                    text: "×"
                    color: root.foregroundColor
                    font.family: Style.font.menuFamily
                    font.pixelSize: Style.font.title
                    font.weight: Font.Medium
                  }

                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.closeWindow(windowCell.index)
                  }
                }

                MouseArea {
                  id: windowDrag
                  anchors.fill: parent
                  enabled: root.stageInteractive && !workspaceProcess.running
                    && !root.windowDropAnimating
                  hoverEnabled: true
                  preventStealing: true
                  cursorShape: windowCell.beingDragged ? Qt.ClosedHandCursor : Qt.OpenHandCursor
                  z: 2
                  property real pressOverviewX: 0
                  property real pressOverviewY: 0
                  property bool moved: false

                  onEntered: {
                    windowCell.hovered = true
                    root.keyboardSelecting = false
                    root.selectedIndex = windowCell.index
                  }
                  onExited: if (!windowCell.beingDragged) windowCell.hovered = false
                  onPressed: function(mouse) {
                    var point = mapToItem(overview, mouse.x, mouse.y)
                    pressOverviewX = point.x
                    pressOverviewY = point.y
                    moved = false
                    root.selectedIndex = windowCell.index
                  }
                  onPositionChanged: function(mouse) {
                    if (!pressed) return
                    var point = mapToItem(overview, mouse.x, mouse.y)
                    var offsetX = point.x - pressOverviewX
                    var offsetY = point.y - pressOverviewY
                    if (!moved && Math.sqrt(offsetX * offsetX + offsetY * offsetY) <= 8) return

                    moved = true
                    root.windowDragActive = true
                    root.windowDragIndex = windowCell.index
                    windowCell.dragOffsetX = offsetX
                    windowCell.dragOffsetY = offsetY

                    var rowPoint = mapToItem(workspaceRow, mouse.x, mouse.y)
                    var targetIndex = WindowModel.spaceCardIndexAt(
                      rowPoint.x, rowPoint.y, root.workspaceIds.length,
                      workspaceRail.chipWidth, workspaceRail.chipHeight,
                      workspaceRail.chipSpacing)
                    var destination = targetIndex >= 0 ? root.workspaceIds[targetIndex] : -1
                    root.windowDropWorkspaceId = destination === root.selectedWorkspaceId
                      ? -1 : destination
                    var dropScale = root.windowDropWorkspaceId > 0
                      ? Math.min(0.32,
                        workspaceRail.chipWidth * 0.82 / Math.max(1, windowCard.width),
                        workspaceRail.chipHeight * 0.82 / Math.max(1, windowCard.height))
                      : 0.72
                    windowCell.dragScale = Math.max(0.1, dropScale)
                  }
                  onReleased: {
                    var destination = root.windowDropWorkspaceId
                    if (moved && destination > 0
                        && windowCell.animateToWorkspace(destination)) return

                    windowCell.dragOffsetX = 0
                    windowCell.dragOffsetY = 0
                    windowCell.dragScale = 1
                    root.windowDragActive = false
                    root.windowDragIndex = -1
                    root.windowDropWorkspaceId = -1
                  }
                  onCanceled: {
                    windowCell.dragOffsetX = 0
                    windowCell.dragOffsetY = 0
                    root.windowDragActive = false
                    root.windowDragIndex = -1
                    root.windowDropWorkspaceId = -1
                    windowCell.dragScale = 1
                    root.windowDropAnimating = false
                    root.pendingWindowToplevel = null
                    root.pendingWindowWorkspaceId = -1
                  }
                  onClicked: if (!moved) root.activateWindow(windowCell.index)
                }
              }
            }
          }

          Rectangle {
            visible: root.windows.length === 0
            x: root.stageX + (root.stageWidth - width) / 2
            y: root.stageY + (root.stageHeight - height) / 2
            width: emptyColumn.implicitWidth + 48
            height: emptyColumn.implicitHeight + 32
            radius: Math.max(Style.cornerRadius, 12)
            color: Util.alpha(root.backgroundColor, 0.94)
            border.color: Util.alpha(root.borderColor, 0.6)
            border.width: 1
            opacity: root.revealProgress

            Column {
              id: emptyColumn
              anchors.centerIn: parent
              spacing: Math.max(Style.spacing.md, 12)

              Text {
                anchors.horizontalCenter: parent.horizontalCenter
                text: "No windows in Space " + root.selectedWorkspaceId
                color: root.foregroundColor
                font.family: Style.font.menuFamily
                font.pixelSize: Math.max(Style.font.title, 20)
                font.weight: Font.DemiBold
              }

              Text {
                anchors.horizontalCenter: parent.horizontalCenter
                text: "Press Enter to switch to this workspace"
                color: root.foregroundColor
                opacity: 0.55
                font.family: Style.font.menuFamily
                font.pixelSize: Style.font.body
              }
            }
          }
        }

        // The outgoing stage, frozen while the incoming space's cards capture.
        ShaderEffectSource {
          id: stageSnapshot
          x: windowGrid.x
          y: windowGrid.y
          width: windowGrid.width
          height: windowGrid.height
          z: windowGrid.z + 1
          readonly property bool active: root.stageFrozen || stageFreezeFrame.running
          visible: active
          sourceItem: active ? windowGrid : null
          live: false
          hideSource: false
        }
      }
    }
  }
}
