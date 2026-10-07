import QtQuick
import QtQuick.Layouts
import Quickshell.Hyprland
import Quickshell.Io
import qs.Commons
import qs.Ui
import "WindowModel.js" as WindowModel

// Bar counterpart of the Omission overview. The stock Workspaces
// widget always paints slots 1-5; this one shows exactly the spaces that
// exist: the managed spaces recorded by the overview (which persist across
// Hyprland restarts even while empty) plus every live workspace, so adding
// or removing a space in Omission reshapes the bar immediately.
BarWidget {
  id: root
  moduleName: "io.github.nobledoodle.omission"

  readonly property var spaceService: root.bar && root.bar.shell
    && typeof root.bar.shell.serviceFor === "function"
    ? root.bar.shell.serviceFor("io.github.nobledoodle.omission") : null
  readonly property var managedIds: spaceService && spaceService.spacesLoaded
    ? spaceService.managedWorkspaceIds : []

  function workspaceById(id) {
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) {
      if (values[i].id === id) return values[i]
    }

    return null
  }

  // One service owns the saved set. Every bar instance and the overview bind
  // to the exact same array, then merge in any live Hyprland workspace.
  readonly property var spaceIds: WindowModel.workspaceIds(
    Hyprland.workspaces.values, -1,
    Hyprland.focusedWorkspace ? Hyprland.focusedWorkspace.id : -1,
    root.managedIds)

  function spaceName(workspaceId) {
    return root.spaceService && typeof root.spaceService.spaceName === "function"
      ? root.spaceService.spaceName(workspaceId) : ""
  }


  // In-process, no shell: only a workspace number reaches the dispatch.
  function focusWorkspace(id) {
    var workspace = Math.floor(Number(id))
    if (!(workspace > 0 && workspace <= 10)) return
    Hyprland.dispatch('hl.dsp.focus({ workspace = "' + workspace + '" })')
  }

  function interactionRect(item) {
    if (!item) return null
    var point = item.mapToGlobal(0, 0)
    return {
      x: point.x,
      y: point.y,
      width: item.width,
      height: item.height,
      centerX: point.x + item.width / 2,
      centerY: point.y + item.height / 2
    }
  }

  function interactionGeometry() {
    var spaces = []
    for (var i = 0; i < workspaceButtons.count; i++) {
      var button = workspaceButtons.itemAt(i)
      if (!button) continue
      spaces.push({
        index: i,
        id: Number(button.modelData),
        name: root.spaceName(button.modelData),
        rect: root.interactionRect(button)
      })
    }
    return JSON.stringify({ spaces: spaces })
  }

  readonly property real trailingGap: root.vertical ? 0 : Style.spaceReal(1.5)

  // Style and visibility come from the overview's settings panel, through
  // the service, so every bar instance follows one saved choice. Nothing is
  // drawn until those settings load, so a saved style never flashes numbers.
  readonly property var omissionSettings: root.spaceService
    ? (root.spaceService.settingsLoaded ? root.spaceService.settings : null)
    : WindowModel.normalizedSettings({})
  readonly property string barStyle: omissionSettings ? omissionSettings.barStyle : "numbers"
  readonly property bool showSpaces: !!omissionSettings && omissionSettings.showBarSpaces
  readonly property var shownIds: showSpaces ? spaceIds : []
  readonly property bool numbered: barStyle === "numbers"
  // Dots and lines carry their gap inside each button, as Workspace Dots does.
  readonly property real cellGap: barStyle === "pills" ? Style.spaceReal(4) : Style.spaceReal(6)

  visible: shownIds.length > 0
  implicitWidth: shownIds.length > 0 ? grid.implicitWidth + trailingGap : 0
  implicitHeight: shownIds.length > 0 ? grid.implicitHeight : 0

  GridLayout {
    id: grid
    anchors.fill: parent
    anchors.rightMargin: root.trailingGap
    columns: root.vertical ? 1 : Math.max(1, root.shownIds.length)
    columnSpacing: root.vertical || !root.numbered ? 0 : Style.space(1)
    rowSpacing: root.vertical && root.numbered ? Style.space(2) : 0

    Repeater {
      id: workspaceButtons
      model: root.shownIds

      WidgetButton {
        id: spaceButton
        required property int modelData

        readonly property var workspace: root.workspaceById(modelData)
        readonly property bool occupied: workspace !== null && workspace.toplevels.values.length > 0
        readonly property bool focused: Hyprland.focusedWorkspace !== null && Hyprland.focusedWorkspace.id === modelData
        readonly property string customName: root.spaceService
          && root.spaceService.namesLoaded
          ? String(root.spaceService.spaceNames[String(modelData)] || "") : ""
        readonly property string numberLabel: modelData === 10 ? "0" : String(modelData)
        // Grows the focused mark only after creation, so it animates in.
        property bool ready: false
        Component.onCompleted: ready = true

        bar: root.bar
        text: root.numbered
          ? (customName || (focused ? "\uDB85\uDCFB" : numberLabel)) : ""
        labelVisible: root.numbered
        hasVisualContent: true
        tooltipText: root.numbered || root.barStyle === "pills" ? ""
          : (customName || "Space " + numberLabel)
        opacity: !root.numbered || customName || occupied || focused ? 1 : 0.5
        horizontalMargin: 6
        verticalPadding: 6
        fixedWidth: root.vertical ? root.barSize
          : !root.numbered ? mark.implicitWidth + root.cellGap
          : (customName
            ? Math.min(Style.space(96), Math.max(Style.space(20),
              Style.space(12 + customName.length * 7)))
            : Style.space(20))
        fixedHeight: root.vertical && !root.numbered
          ? mark.implicitHeight + root.cellGap : root.barSize
        onPressed: function() { root.focusWorkspace(modelData) }

        SpaceMark {
          id: mark
          anchors.centerIn: parent
          visible: !root.numbered
          style: root.numbered ? "dots" : root.barStyle
          focused: spaceButton.focused && spaceButton.ready
          occupied: spaceButton.occupied
          label: spaceButton.customName || spaceButton.numberLabel
          foreground: root.bar ? root.bar.barForeground : Color.foreground
          fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
          vertical: root.vertical
        }
      }
    }
  }


  IpcHandler {
    target: "io.github.nobledoodle.omission-spaces"
    function geometry(): string { return root.interactionGeometry() }
  }
}
