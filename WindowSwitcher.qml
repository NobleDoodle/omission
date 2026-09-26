pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Wayland
import qs.Commons
import "SwitcherModel.js" as SwitcherModel

Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null

  property bool opened: false
  property bool loading: false
  property bool commitWhenReady: false
  property int pendingDirection: 1
  property int queuedDelta: 0
  property int selectedIndex: -1
  property int targetMonitorId: -1
  property string targetMonitorName: ""
  property int targetWorkspaceId: -1
  property var clients: []
  property var desktopRows: []
  property var desktopCache: ({})
  // Commands resolve through root-owned directories only, never the PATH the
  // shell inherited, so nothing earlier in that PATH can stand in for them.
  readonly property string trustedPath: "/usr/local/bin:/usr/bin:/bin"
  readonly property var trustedEnvironment: ({ PATH: root.trustedPath })
  property string modelError: ""

  readonly property color transparentColor: Util.alpha(Color.background, 0)
  readonly property color backgroundColor: Color.menu.background
  readonly property color foregroundColor: Color.menu.text
  readonly property color borderColor: Color.menu.border
  readonly property color scrimColor: Color.menu.scrim
  readonly property color surfaceTopColor: Util.alpha(
    backgroundColor, Math.min(0.82, Math.max(backgroundColor.a, 0.74)))
  readonly property color surfaceBottomColor: Util.alpha(
    backgroundColor, Math.min(0.72, Math.max(backgroundColor.a, 0.64)))
  readonly property color surfaceBorderColor: Util.alpha(
    borderColor, Math.max(borderColor.a, 0.55))
  readonly property color surfaceInnerBorderColor: Util.alpha(foregroundColor, 0.10)
  readonly property color panelShadowColor: Util.alpha(Color.background, 0.52)
  readonly property color selectedColor: Util.alpha(Color.menu.selectedBackground, 0.20)
  readonly property color selectedTextColor: foregroundColor
  readonly property color selectedSecondaryTextColor: Util.alpha(foregroundColor, 0.68)
  readonly property color selectedBorderColor: Util.alpha(
    Color.menu.selectedBorder.a > 0 ? Color.menu.selectedBorder : foregroundColor, 0.85)
  readonly property color secondaryTextColor: Util.alpha(foregroundColor, 0.62)
  readonly property color idleCardColor: Style.normalFillFor(foregroundColor, selectedTextColor)
  readonly property color hoverCardColor: Style.hoverFillFor(foregroundColor, selectedTextColor)
  readonly property color idleCardBorderColor: Style.normalBorderFor(foregroundColor, selectedTextColor)
  readonly property color hoverCardBorderColor: Style.hoverBorderFor(foregroundColor, selectedTextColor)
  readonly property color iconShadowColor: Util.alpha(Color.background, 0.48)
  // The whole switcher is drawn at 80% of its natural size.
  readonly property real uiScale: 0.8
  readonly property real displayScale: root.uiScale * Math.max(1, Math.min(1.6,
    panel.height / Math.max(1, Style.space(1080))))
  readonly property int cardWidth: Math.round(Style.space(150) * displayScale)
  readonly property int cardHeight: Math.round(Style.space(188) * displayScale)
  readonly property int cardSpacing: Math.round(Style.space(10) * displayScale)
  readonly property int panelPadding: Math.round(Style.space(16) * displayScale)
  readonly property int cardPadding: Math.round(Style.space(12) * displayScale)
  readonly property int iconSize: Math.round(Style.space(84) * displayScale)
  readonly property int iconAreaHeight: Math.round(Style.space(108) * displayScale)
  readonly property int panelRadius: Math.max(Style.cornerRadius, Style.space(18))
  readonly property int cardRadius: Math.max(Style.cornerRadius, Style.space(13))
  readonly property int screenMargin: Math.max(
    Style.space(40), Math.round(panel.width * 0.04))
  readonly property int maxVisibleCards: 9
  readonly property int quickMotionDuration: 130
  readonly property int selectionMotionDuration: 170
  readonly property int entranceMotionDuration: 200
  readonly property bool errorState: root.opened && !root.loading && root.modelError.length > 0
  readonly property bool emptyState: root.opened && !root.loading
    && !root.errorState && root.clients.length === 0
  readonly property bool compactState: root.loading || root.emptyState || root.errorState
  readonly property int compactPanelWidth: Math.round(Style.space(270) * displayScale)
  readonly property int compactPanelHeight: Math.round(Style.space(84) * displayScale)
  readonly property int singlePanelWidth: Math.round(Style.space(320) * displayScale)
  readonly property int singlePanelHeight: Math.round(Style.space(112) * displayScale)
  readonly property int singleIconSize: Math.round(Style.space(64) * displayScale)

  function monitorScreen(name) {
    var screens = Quickshell.screens || []
    for (var i = 0; i < screens.length; i++) {
      if (String(screens[i].name || "") === String(name || "")) return screens[i]
    }
    return screens.length > 0 ? screens[0] : null
  }

  function desktopEntry(data) {
    var cacheKey = (String(data.initialClass || "") + "\n"
      + String(data.class || "") + "\n" + String(data.title || "")).toLowerCase()
    if (root.desktopCache[cacheKey] !== undefined) return root.desktopCache[cacheKey]
    var entry = SwitcherModel.desktopEntry(root.desktopRows,
      data.initialClass, data.class, data.title)
    root.desktopCache[cacheKey] = entry || null
    return entry
  }

  function rebuildDesktopCatalog() {
    root.desktopCache = ({})
    root.desktopRows = DesktopEntries.applications.values || []
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
    var data = SwitcherModel.metadata(toplevel)
    var entry = root.desktopEntry(data)
    var fallbackClass = String(data.initialClass || data.class || "")
    var appName = entry ? String(entry.name || "") : ""
    var iconName = entry ? String(entry.icon || "") : SwitcherModel.safeIconName(fallbackClass)
    return {
      toplevel: toplevel,
      stableId: SwitcherModel.stableId(toplevel),
      address: SwitcherModel.address(toplevel),
      appName: appName || SwitcherModel.classLabel(data.class || data.initialClass),
      displayTitle: SwitcherModel.shortenedTitle(
        String(toplevel.title || data.title || appName || ""), 96),
      iconSource: root.resolveIcon(iconName)
    }
  }

  function currentStableId() {
    if (root.selectedIndex < 0 || root.selectedIndex >= root.clients.length) return ""
    return String(root.clients[root.selectedIndex].stableId || "")
  }

  function selectedIndexForStableId(id, windows) {
    var wanted = String(id || "")
    if (!wanted) return -1
    for (var i = 0; i < windows.length; i++) {
      if (String(windows[i].stableId || "") === wanted) return i
    }
    return -1
  }

  function refreshClients(initial) {
    if (!root.opened) return
    var previousStableId = root.currentStableId()
    var previousIndex = root.selectedIndex
    try {
      var filtered = SwitcherModel.switchableClients(Hyprland.toplevels.values,
        root.targetMonitorId, root.targetWorkspaceId, SwitcherModel.MAX_CLIENTS)
      var decorated = []
      for (var i = 0; i < filtered.length; i++) decorated.push(root.decorate(filtered[i]))
      root.clients = decorated
      root.modelError = ""

      if (initial) {
        root.selectedIndex = SwitcherModel.initialIndex(root.pendingDirection, decorated.length)
        if (root.queuedDelta !== 0)
          root.selectedIndex = SwitcherModel.nextIndex(
            root.selectedIndex, root.queuedDelta, decorated.length)
      } else {
        var preserved = root.selectedIndexForStableId(previousStableId, decorated)
        root.selectedIndex = preserved >= 0 ? preserved
          : decorated.length > 0 ? Math.min(Math.max(previousIndex, 0), decorated.length - 1) : -1
      }
    } catch (error) {
      root.clients = []
      root.selectedIndex = -1
      root.modelError = "Could not read Hyprland windows"
      console.warn("io.github.nobledoodle.omission: native toplevel refresh failed:", error)
    }
    root.loading = false
    Qt.callLater(function() {
      if (root.selectedIndex >= 0)
        strip.positionViewAtIndex(root.selectedIndex, ListView.Contain)
      if (root.commitWhenReady) root.commit()
    })
  }

  function focusedScopeStillMatches() {
    var monitor = Hyprland.focusedMonitor
    var workspace = Hyprland.focusedWorkspace
    return monitor && workspace
      && Number(monitor.id) === root.targetMonitorId
      && Number(workspace.id) === root.targetWorkspaceId
  }

  function queueLiveRefresh() {
    if (!root.opened) return
    if (!root.focusedScopeStillMatches()) {
      root.cancel()
      return
    }
    refreshTimer.restart()
  }

  function showForFocusedMonitor(direction) {
    var monitor = Hyprland.focusedMonitor
    var workspace = Hyprland.focusedWorkspace
    if (!monitor || !workspace) return false

    root.pendingDirection = Number(direction) < 0 ? -1 : 1
    root.queuedDelta = 0
    root.commitWhenReady = false
    root.targetMonitorId = Number(monitor.id)
    root.targetMonitorName = String(monitor.name || "")
    root.targetWorkspaceId = Number(workspace.id)
    root.clients = []
    root.selectedIndex = -1
    root.modelError = ""
    root.loading = true
    root.opened = true
    root.rebuildDesktopCatalog()
    root.refreshClients(true)
    Hyprland.refreshToplevels()
    ipcSettleTimer.restart()
    return true
  }

  function advance(direction) {
    var numeric = Number(direction)
    var delta = isFinite(numeric) && numeric !== 0 ? Math.trunc(numeric) : 1
    if (!root.opened) return root.showForFocusedMonitor(delta < 0 ? -1 : 1)
      ? "ok" : "unavailable"
    if (root.loading) root.queuedDelta += delta
    else root.select(delta)
    return "ok"
  }

  function open(payloadJson) {
    var direction = 1
    try {
      var payload = JSON.parse(payloadJson || "{}")
      direction = Number(payload.direction)
      if (!isFinite(direction) || direction === 0) direction = 1
    } catch (_error) { }
    return root.advance(direction)
  }

  function close() {
    root.cancel()
  }

  function cancel() {
    root.opened = false
    root.loading = false
    root.commitWhenReady = false
    root.clients = []
    root.selectedIndex = -1
    refreshTimer.stop()
  }

  function select(delta) {
    root.selectedIndex = SwitcherModel.nextIndex(root.selectedIndex, delta, root.clients.length)
    if (root.selectedIndex >= 0) strip.positionViewAtIndex(root.selectedIndex, ListView.Contain)
  }

  function commit(argument) {
    if (!root.opened) return
    var numeric = Number(argument)
    var finalDelta = isFinite(numeric) ? Math.trunc(numeric) : 0
    if (root.loading) {
      root.queuedDelta += finalDelta
      root.commitWhenReady = true
      return
    }
    if (finalDelta !== 0) root.select(finalDelta)
    if (root.selectedIndex < 0 || root.selectedIndex >= root.clients.length) {
      root.cancel()
      return
    }

    var selectedStableId = String(root.clients[root.selectedIndex].stableId || "")
    var live = SwitcherModel.findSwitchableByStableId(Hyprland.toplevels.values,
      selectedStableId, root.targetMonitorId, root.targetWorkspaceId)
    root.cancel()
    if (!live || !/^[0-9A-Fa-f]+$/.test(selectedStableId)) return
    Quickshell.execDetached({
      command: [
        "hyprctl", "eval",
        'hl.dispatch(hl.dsp.focus({ window = "stableid:' + selectedStableId + '" }))\n'
          + 'hl.dispatch(hl.dsp.window.bring_to_top())'
      ],
      environment: root.trustedEnvironment
    })
  }

  function status(_argument) {
    return JSON.stringify({
      open: root.opened,
      loading: root.loading,
      monitor: root.targetMonitorName,
      workspace: root.targetWorkspaceId,
      count: root.clients.length,
      capped: root.clients.length >= SwitcherModel.MAX_CLIENTS,
      state: root.modelError ? "error"
        : root.loading ? "loading"
        : root.clients.length === 0 ? "empty"
        : root.clients.length === 1 ? "single" : "multiple",
      error: root.modelError,
      selectedIndex: root.selectedIndex,
      selectedStableId: root.currentStableId(),
      panelWidth: panel.width,
      panelHeight: panel.height,
      stripWidth: strip.width,
      stripHeight: strip.height,
      cardPanelWidth: switcherPanel.width,
      cardPanelHeight: switcherPanel.height,
      cardPanelOpacity: switcherPanel.opacity
    })
  }

  Timer {
    id: refreshTimer
    interval: 16
    repeat: false
    onTriggered: root.refreshClients(false)
  }

  // A window that has just mapped reaches Hyprland.toplevels with a partial
  // IPC record (no class yet, or not mapped), which yields a generic icon or
  // hides it. Re-read the records once the compositor has settled.
  Timer {
    id: ipcSettleTimer
    interval: 90
    repeat: false
    onTriggered: {
      Hyprland.refreshToplevels()
      ipcApplyTimer.restart()
    }
  }

  Timer {
    id: ipcApplyTimer
    interval: 120
    repeat: false
    onTriggered: root.refreshClients(false)
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (!root.opened) return
      var name = String(event && event.name || "")
      if (name === "openwindow" || name === "windowtitlev2" || name === "movewindowv2")
        ipcSettleTimer.restart()
    }
  }

  Connections {
    target: Hyprland.toplevels
    function onValuesChanged() { root.queueLiveRefresh() }
  }

  Connections {
    target: Hyprland.workspaces
    function onValuesChanged() { root.queueLiveRefresh() }
  }

  Connections {
    target: Hyprland.monitors
    function onValuesChanged() { root.queueLiveRefresh() }
  }

  Connections {
    target: DesktopEntries.applications
    function onValuesChanged() {
      if (!root.opened) return
      root.rebuildDesktopCatalog()
      refreshTimer.restart()
    }
  }

  PanelWindow {
    id: panel
    visible: root.opened
    screen: root.monitorScreen(root.targetMonitorName)
    anchors { top: true; right: true; bottom: true; left: true }
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "omission-switcher"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

    FocusScope {
      id: keyScope
      anchors.fill: parent
      focus: root.opened

      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) {
        var reverse = !!(event.modifiers & Qt.ShiftModifier)
        if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
          root.advance(reverse || event.key === Qt.Key_Backtab ? -1 : 1)
          event.accepted = true
        } else if (event.key === Qt.Key_Left) {
          root.select(-1)
          event.accepted = true
        } else if (event.key === Qt.Key_Right) {
          root.select(1)
          event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
          root.commit()
          event.accepted = true
        } else if (event.key === Qt.Key_Escape) {
          root.cancel()
          event.accepted = true
        }
      }
      Keys.onReleased: function(event) {
        if (event.key === Qt.Key_Alt || event.key === Qt.Key_AltGr) {
          root.commit()
          event.accepted = true
        }
      }

      Rectangle {
        anchors.fill: parent
        color: root.scrimColor
        opacity: root.opened ? 0.45 : 0

        Behavior on opacity {
          NumberAnimation {
            duration: root.entranceMotionDuration
            easing.type: Easing.OutQuart
          }
        }

        MouseArea {
          anchors.fill: parent
          onClicked: root.cancel()
        }
      }

      Item {
        id: switcherPanel
        anchors.centerIn: parent
        width: Math.min(
          Math.max(Style.space(1), panel.width - root.screenMargin * 2),
          root.compactState ? root.compactPanelWidth
            : root.clients.length === 1 ? root.singlePanelWidth
            : Math.max(
                Math.round(Style.space(300) * root.displayScale),
                Math.min(root.clients.length, root.maxVisibleCards) * root.cardWidth
                  + Math.max(0, Math.min(root.clients.length, root.maxVisibleCards) - 1)
                    * root.cardSpacing
                  + root.panelPadding * 2))
        height: root.compactState ? root.compactPanelHeight
          : root.clients.length === 1 ? root.singlePanelHeight
          : root.cardHeight + root.panelPadding * 2
        opacity: root.opened ? 1 : 0
        scale: root.opened ? 1 : 0.94
        transformOrigin: Item.Center

        transform: Translate {
          y: root.opened ? 0 : Style.space(10)

          Behavior on y {
            NumberAnimation {
              duration: root.entranceMotionDuration
              easing.type: Easing.OutQuart
            }
          }
        }

        Behavior on opacity {
          NumberAnimation {
            duration: root.entranceMotionDuration
            easing.type: Easing.OutQuart
          }
        }
        Behavior on scale {
          NumberAnimation {
            duration: root.entranceMotionDuration
            easing.type: Easing.OutQuart
          }
        }

        Rectangle {
          anchors.fill: parent
          radius: root.panelRadius
          color: root.panelShadowColor
          opacity: 0.66
          scale: 1.015
          transform: Translate { y: Math.round(Style.space(8) * root.displayScale) }
        }

        Rectangle {
          id: panelSurface
          anchors.fill: parent
          radius: root.panelRadius
          border.color: root.surfaceBorderColor
          border.width: Math.max(Style.spacing.hairline, Style.normalBorderWidth)
          gradient: Gradient {
            GradientStop { position: 0; color: root.surfaceTopColor }
            GradientStop { position: 1; color: root.surfaceBottomColor }
          }

          Rectangle {
            anchors.fill: parent
            anchors.margins: Math.max(Style.spacing.hairline, Style.normalBorderWidth)
            radius: Math.max(0, parent.radius - anchors.margins)
            color: root.transparentColor
            border.color: root.surfaceInnerBorderColor
            border.width: Style.spacing.hairline
          }

          Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: Math.max(Style.spacing.hairline, Style.normalBorderWidth)
            height: Math.round(parent.height * 0.48)
            radius: Math.max(0, parent.radius - anchors.margins)
            gradient: Gradient {
              GradientStop {
                position: 0
                color: Util.alpha(root.foregroundColor, 0.06)
              }
              GradientStop {
                position: 1
                color: root.transparentColor
              }
            }
          }
        }

        MouseArea {
          anchors.fill: parent
          onClicked: function(mouse) { mouse.accepted = true }
        }

        Row {
          anchors.centerIn: parent
          spacing: Math.round(Style.space(10) * root.displayScale)
          visible: root.loading

          Rectangle {
            anchors.verticalCenter: parent.verticalCenter
            width: Math.round(Style.space(7) * root.displayScale)
            height: width
            radius: width / 2
            color: root.selectedTextColor

            SequentialAnimation on opacity {
              running: root.loading
              loops: Animation.Infinite
              NumberAnimation {
                from: 0.38
                to: 1
                duration: root.quickMotionDuration * 2
                easing.type: Easing.OutCubic
              }
              NumberAnimation {
                from: 1
                to: 0.38
                duration: root.quickMotionDuration * 2
                easing.type: Easing.InCubic
              }
            }
          }

          Text {
            text: "Loading windows…"
            color: root.foregroundColor
            font.family: Style.font.menuFamily
            font.pixelSize: Math.round(Style.font.title * root.displayScale)
            font.weight: Font.Medium
          }
        }

        Row {
          anchors.centerIn: parent
          spacing: Math.round(Style.space(12) * root.displayScale)
          visible: root.emptyState

          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: "󰍲"
            color: root.foregroundColor
            opacity: 0.82
            font.family: Style.font.menuFamily
            font.pixelSize: Math.round(Style.font.displayLarge * root.displayScale)
          }

          Column {
            anchors.verticalCenter: parent.verticalCenter
            spacing: Math.round(Style.space(2) * root.displayScale)

            Text {
              text: "No windows to switch"
              color: root.foregroundColor
              font.family: Style.font.menuFamily
              font.pixelSize: Math.round(Style.font.title * root.displayScale)
              font.weight: Font.DemiBold
            }

            Text {
              text: root.targetWorkspaceId > 0
                ? "Workspace " + root.targetWorkspaceId : "Current workspace"
              color: root.secondaryTextColor
              font.family: Style.font.menuFamily
              font.pixelSize: Math.round(Style.font.bodySmall * root.displayScale)
            }
          }
        }

        Row {
          anchors.centerIn: parent
          spacing: Math.round(Style.space(12) * root.displayScale)
          visible: root.errorState

          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: "󰅚"
            color: Color.urgent
            font.family: Style.font.menuFamily
            font.pixelSize: Math.round(Style.font.displayLarge * root.displayScale)
          }

          Column {
            anchors.verticalCenter: parent.verticalCenter
            spacing: Math.round(Style.space(2) * root.displayScale)

            Text {
              text: "Window list unavailable"
              color: root.foregroundColor
              font.family: Style.font.menuFamily
              font.pixelSize: Math.round(Style.font.title * root.displayScale)
              font.weight: Font.DemiBold
            }

            Text {
              text: root.modelError
              textFormat: Text.PlainText
              color: root.secondaryTextColor
              font.family: Style.font.menuFamily
              font.pixelSize: Math.round(Style.font.bodySmall * root.displayScale)
            }
          }
        }

        Rectangle {
          id: singleWindowCard
          visible: !root.loading && root.clients.length === 1
          anchors.fill: parent
          anchors.margins: root.panelPadding
          radius: root.cardRadius
          color: root.selectedColor
          border.color: root.selectedBorderColor
          border.width: Math.max(Style.spacing.hairline, Style.selectedBorderWidth)
          Accessible.role: Accessible.Button
          Accessible.name: root.clients.length === 1
            ? String(root.clients[0].appName || "Application") : "Application"
          Accessible.description: root.clients.length === 1
            ? String(root.clients[0].displayTitle || "") : ""
          Accessible.onPressAction: root.commit()

          Row {
            id: singleWindowContent
            anchors.fill: parent
            anchors.margins: root.cardPadding
            spacing: Math.round(Style.space(14) * root.displayScale)

            Item {
              width: root.singleIconSize
              height: parent.height

              Rectangle {
                anchors.horizontalCenter: parent.horizontalCenter
                anchors.bottom: parent.bottom
                anchors.bottomMargin: Math.round(Style.space(8) * root.displayScale)
                width: Math.round(root.singleIconSize * 0.7)
                height: Math.round(Style.space(10) * root.displayScale)
                radius: height / 2
                color: root.iconShadowColor
                opacity: 0.55
              }

              Image {
                id: singleAppIcon
                anchors.centerIn: parent
                width: root.singleIconSize
                height: width
                source: root.clients.length === 1
                  ? String(root.clients[0].iconSource || "") : ""
                fillMode: Image.PreserveAspectFit
                sourceSize.width: Math.round(width * Screen.devicePixelRatio)
                sourceSize.height: Math.round(height * Screen.devicePixelRatio)
                asynchronous: true
                smooth: true
              }

              Text {
                anchors.centerIn: parent
                visible: singleAppIcon.status !== Image.Ready
                text: "󰍲"
                color: root.selectedTextColor
                font.family: Style.font.menuFamily
                font.pixelSize: Math.round(root.singleIconSize * 0.54)
              }
            }

            Column {
              width: singleWindowContent.width - root.singleIconSize
                - singleWindowContent.spacing
              anchors.verticalCenter: parent.verticalCenter
              spacing: Math.round(Style.space(3) * root.displayScale)

              Text {
                width: parent.width
                text: root.clients.length === 1
                  ? String(root.clients[0].appName || "Application") : ""
                textFormat: Text.PlainText
                color: root.selectedTextColor
                elide: Text.ElideRight
                maximumLineCount: 1
                font.family: Style.font.menuFamily
                font.pixelSize: Math.round(Style.font.title * root.displayScale)
                font.weight: Font.DemiBold
              }

              Text {
                width: parent.width
                text: root.clients.length === 1
                  ? String(root.clients[0].displayTitle || "") : ""
                textFormat: Text.PlainText
                color: root.selectedSecondaryTextColor
                elide: Text.ElideRight
                maximumLineCount: 1
                font.family: Style.font.menuFamily
                font.pixelSize: Math.round(Style.font.bodySmall * root.displayScale)
              }
            }
          }

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: root.commit()
          }
        }

        ListView {
          id: strip
          visible: !root.loading && root.clients.length > 1
          anchors.fill: parent
          anchors.margins: root.panelPadding
          orientation: ListView.Horizontal
          spacing: root.cardSpacing
          clip: true
          model: root.clients
          currentIndex: root.selectedIndex
          boundsBehavior: Flickable.StopAtBounds
          highlightMoveDuration: root.selectionMotionDuration
          highlightMoveVelocity: -1

          add: Transition {
            NumberAnimation {
              property: "opacity"
              from: 0
              duration: root.entranceMotionDuration
              easing.type: Easing.OutCubic
            }
            NumberAnimation {
              property: "scale"
              from: 0.88
              duration: root.entranceMotionDuration
              easing.type: Easing.OutQuart
            }
          }

          highlight: Rectangle {
            radius: root.cardRadius
            color: root.selectedColor
            border.color: root.selectedBorderColor
            border.width: Math.max(Style.spacing.hairline, Style.selectedBorderWidth)
          }

          delegate: Rectangle {
            id: windowCard
            required property var modelData
            required property int index
            readonly property bool selected: index === root.selectedIndex
            readonly property bool hot: cardPointer.containsMouse

            width: root.cardWidth
            height: root.cardHeight
            radius: root.cardRadius
            color: selected ? root.transparentColor
              : hot ? root.hoverCardColor : root.idleCardColor
            border.color: selected ? root.transparentColor
              : hot ? root.hoverCardBorderColor : root.idleCardBorderColor
            border.width: Math.max(Style.spacing.hairline,
              hot ? Style.hoverBorderWidth : Style.normalBorderWidth)
            scale: selected ? 1 : hot ? 0.965 : 0.935
            y: selected ? 0 : Math.round(
              Style.space(hot ? 4 : 7) * root.displayScale)
            opacity: selected ? 1 : hot ? 0.86 : 0.72
            z: selected ? 2 : hot ? 1 : 0
            transformOrigin: Item.Center
            Accessible.role: Accessible.Button
            Accessible.name: String(windowCard.modelData.appName || "Application")
            Accessible.description: String(windowCard.modelData.displayTitle || "")
            Accessible.onPressAction: {
              root.selectedIndex = windowCard.index
              root.commit()
            }

            Behavior on scale {
              NumberAnimation {
                duration: root.selectionMotionDuration
                easing.type: Easing.OutQuart
              }
            }
            Behavior on y {
              NumberAnimation {
                duration: root.selectionMotionDuration
                easing.type: Easing.OutQuart
              }
            }
            Behavior on opacity {
              NumberAnimation {
                duration: root.quickMotionDuration
                easing.type: Easing.OutCubic
              }
            }
            Behavior on color {
              ColorAnimation { duration: root.quickMotionDuration }
            }
            Behavior on border.color {
              ColorAnimation { duration: root.quickMotionDuration }
            }

            Column {
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: root.cardPadding
              anchors.rightMargin: root.cardPadding
              spacing: Math.round(Style.space(4) * root.displayScale)

              Item {
                width: parent.width
                height: root.iconAreaHeight

                Rectangle {
                  anchors.horizontalCenter: parent.horizontalCenter
                  anchors.bottom: parent.bottom
                  anchors.bottomMargin: Math.round(Style.space(10) * root.displayScale)
                  width: Math.round(root.iconSize * 0.72)
                  height: Math.round(Style.space(13) * root.displayScale)
                  radius: height / 2
                  color: root.iconShadowColor
                  opacity: windowCard.selected ? 0.72 : 0.42
                  scale: windowCard.selected ? 1 : 0.82

                  Behavior on opacity {
                    NumberAnimation { duration: root.selectionMotionDuration }
                  }
                  Behavior on scale {
                    NumberAnimation {
                      duration: root.selectionMotionDuration
                      easing.type: Easing.OutQuart
                    }
                  }
                }

                Image {
                  id: appIcon
                  anchors.horizontalCenter: parent.horizontalCenter
                  y: Math.round((parent.height - height) / 2
                    - (windowCard.selected ? Style.space(4) * root.displayScale : 0))
                  width: root.iconSize
                  height: width
                  source: String(windowCard.modelData.iconSource || "")
                  fillMode: Image.PreserveAspectFit
                  sourceSize.width: Math.round(width * Screen.devicePixelRatio)
                  sourceSize.height: Math.round(height * Screen.devicePixelRatio)
                  asynchronous: true
                  smooth: true
                  opacity: windowCard.selected ? 1 : 0.84
                  scale: windowCard.selected ? 1.045 : 0.96

                  Behavior on y {
                    NumberAnimation {
                      duration: root.selectionMotionDuration
                      easing.type: Easing.OutQuart
                    }
                  }
                  Behavior on scale {
                    NumberAnimation {
                      duration: root.selectionMotionDuration
                      easing.type: Easing.OutQuart
                    }
                  }
                  Behavior on opacity {
                    NumberAnimation { duration: root.quickMotionDuration }
                  }
                }

                Text {
                  anchors.centerIn: parent
                  width: root.iconSize
                  height: root.iconSize
                  visible: appIcon.status !== Image.Ready
                  text: "󰍲"
                  color: windowCard.selected
                    ? root.selectedTextColor : root.foregroundColor
                  opacity: windowCard.selected ? 1 : 0.78
                  horizontalAlignment: Text.AlignHCenter
                  verticalAlignment: Text.AlignVCenter
                  font.family: Style.font.menuFamily
                  font.pixelSize: Math.max(
                    Style.font.displayLarge, Math.round(root.iconSize * 0.56))
                  scale: windowCard.selected ? 1.045 : 0.96

                  Behavior on scale {
                    NumberAnimation {
                      duration: root.selectionMotionDuration
                      easing.type: Easing.OutQuart
                    }
                  }
                  Behavior on opacity {
                    NumberAnimation { duration: root.quickMotionDuration }
                  }
                }
              }

              Text {
                width: parent.width
                text: String(windowCard.modelData.appName || "Application")
                textFormat: Text.PlainText
                color: windowCard.selected
                  ? root.selectedTextColor : root.foregroundColor
                horizontalAlignment: Text.AlignLeft
                elide: Text.ElideRight
                maximumLineCount: 1
                font.family: Style.font.menuFamily
                font.pixelSize: Math.round(Style.font.title * root.displayScale)
                font.weight: windowCard.selected ? Font.DemiBold : Font.Medium

                Behavior on color {
                  ColorAnimation { duration: root.quickMotionDuration }
                }
              }

              Text {
                width: parent.width
                visible: text.length > 0
                text: String(windowCard.modelData.displayTitle || "")
                textFormat: Text.PlainText
                color: windowCard.selected
                  ? root.selectedSecondaryTextColor : root.secondaryTextColor
                horizontalAlignment: Text.AlignLeft
                elide: Text.ElideRight
                maximumLineCount: 1
                font.family: Style.font.menuFamily
                font.pixelSize: Math.round(Style.font.bodySmall * root.displayScale)

                Behavior on color {
                  ColorAnimation { duration: root.quickMotionDuration }
                }
              }
            }

            MouseArea {
              id: cardPointer
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: {
                root.selectedIndex = windowCard.index
                root.commit()
              }
            }
          }
        }

        Rectangle {
          x: root.panelPadding
          y: root.panelPadding
          width: Math.round(Style.space(30) * root.displayScale)
          height: root.cardHeight
          z: 4
          opacity: !root.loading && !strip.atXBeginning ? 1 : 0
          gradient: Gradient {
            orientation: Gradient.Horizontal
            GradientStop { position: 0; color: root.surfaceBottomColor }
            GradientStop { position: 1; color: root.transparentColor }
          }

          Behavior on opacity {
            NumberAnimation { duration: root.quickMotionDuration }
          }
        }

        Rectangle {
          x: switcherPanel.width - root.panelPadding - width
          y: root.panelPadding
          width: Math.round(Style.space(30) * root.displayScale)
          height: root.cardHeight
          z: 4
          opacity: !root.loading && !strip.atXEnd ? 1 : 0
          gradient: Gradient {
            orientation: Gradient.Horizontal
            GradientStop { position: 0; color: root.transparentColor }
            GradientStop { position: 1; color: root.surfaceBottomColor }
          }

          Behavior on opacity {
            NumberAnimation { duration: root.quickMotionDuration }
          }
        }
      }
    }
  }
}
