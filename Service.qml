import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import "WindowModel.js" as WindowModel

Item {
  id: root

  property var shell: null
  property string omarchyPath: ""
  readonly property string ownerToken: "io.github.nobledoodle.omission-" + Date.now()
    + "-" + Math.random().toString(36).slice(2)
  // Commands resolve through root-owned directories only, never the PATH the
  // shell inherited, so nothing earlier in that PATH can stand in for them.
  readonly property string trustedPath: "/usr/local/bin:/usr/bin:/bin"
  readonly property var trustedEnvironment: ({ PATH: root.trustedPath })
  property bool applyQueued: false
  property bool shuttingDown: false

  readonly property string spacesStatePath: Quickshell.env("HOME")
    + "/.local/state/omarchy/omission-spaces.json"
  property var managedWorkspaceIds: []
  property bool spacesLoaded: false
  readonly property string spaceNamesPath: Quickshell.env("HOME")
    + "/.local/state/omarchy/omission-space-names.json"
  property var spaceNames: ({})
  property bool namesLoaded: false
  // The overview's settings panel writes these; every bar instance binds them.
  readonly property string settingsPath: Quickshell.env("HOME")
    + "/.local/state/omarchy/omission-settings.json"
  property var settings: WindowModel.normalizedSettings({})
  property bool settingsLoaded: false

  function normalizedManagedSpaces(values) {
    return WindowModel.workspaceIds([], -1, -1, values)
  }

  function loadManagedSpaces(raw) {
    var values = []
    try {
      var parsed = JSON.parse(String(raw || "[]"))
      if (Array.isArray(parsed)) values = parsed
    } catch (_error) { }
    var next = root.normalizedManagedSpaces(values)
    if (JSON.stringify(next) !== JSON.stringify(root.managedWorkspaceIds))
      root.managedWorkspaceIds = next
    root.spacesLoaded = true
  }

  function setManagedSpaces(values) {
    var next = root.normalizedManagedSpaces(values)
    if (JSON.stringify(next) !== JSON.stringify(root.managedWorkspaceIds))
      root.managedWorkspaceIds = next
    root.spacesLoaded = true
    spacesStateFile.setText(JSON.stringify(next) + "\n")
    return next
  }

  function normalizedSpaceNames(values) {
    var source = values && typeof values === "object" ? values : ({})
    var next = ({})
    for (var key in source) {
      var id = Math.floor(Number(key))
      var name = WindowModel.normalizedSpaceName(source[key], 32)
      if (id > 0 && id <= 10 && name) next[String(id)] = name
    }
    return next
  }

  function loadSpaceNames(raw) {
    var values = ({})
    try {
      var parsed = JSON.parse(String(raw || "{}"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        values = parsed
    } catch (_error) { }
    var next = root.normalizedSpaceNames(values)
    if (JSON.stringify(next) !== JSON.stringify(root.spaceNames))
      root.spaceNames = next
    root.namesLoaded = true
  }

  function setSpaceNames(values) {
    var next = root.normalizedSpaceNames(values)
    if (JSON.stringify(next) !== JSON.stringify(root.spaceNames))
      root.spaceNames = next
    root.namesLoaded = true
    spaceNamesFile.setText(JSON.stringify(next) + "\n")
    return next
  }

  function spaceName(workspaceId) {
    return String(root.spaceNames[String(Math.floor(Number(workspaceId)))] || "")
  }

  function setSpaceName(workspaceId, value) {
    var id = Math.floor(Number(workspaceId))
    if (id <= 0 || id > 10) return ""
    var next = JSON.parse(JSON.stringify(root.spaceNames || ({})))
    var name = WindowModel.normalizedSpaceName(value, 32)
    if (name) next[String(id)] = name
    else delete next[String(id)]
    root.setSpaceNames(next)
    return name
  }

  function remapNames(currentIds, desiredIds) {
    return root.setSpaceNames(
      WindowModel.remapSpaceNames(root.spaceNames, currentIds, desiredIds))
  }

  function loadSettings(raw) {
    var values = ({})
    try { values = JSON.parse(String(raw || "{}")) } catch (_error) { }
    var next = WindowModel.normalizedSettings(values)
    if (JSON.stringify(next) !== JSON.stringify(root.settings))
      root.settings = next
    root.settingsLoaded = true
  }

  function setSettings(changes) {
    var merged = JSON.parse(JSON.stringify(root.settings))
    for (var key in changes) merged[key] = changes[key]
    var next = WindowModel.normalizedSettings(merged)
    if (JSON.stringify(next) !== JSON.stringify(root.settings))
      root.settings = next
    root.settingsLoaded = true
    settingsFile.setText(JSON.stringify(next) + "\n")
    return next
  }

  function setBarStyle(style) {
    return root.setSettings({ barStyle: String(style || "") })
  }

  function setShowBarSpaces(shown) {
    return root.setSettings({ showBarSpaces: shown === true })
  }

  function removeGestureLua() {
    return [
      'hl.gesture({ fingers = 3, direction = "up", mods = "", scale = 1.0, action = "unset" })',
      'hl.gesture({ fingers = 3, direction = "down", mods = "", scale = 1.0, action = "unset" })'
    ].join("\n")
  }

  function applyLua() {
    return [
      'local owner = "' + root.ownerToken + '"',
      '_G.omission_owner = owner',
      'if not _G.omission_layer_rule then',
      '  hl.layer_rule({ match = { namespace = "^omission$" }, no_anim = true, animation = "none" })',
      '  _G.omission_layer_rule = true',
      'end',
      'hl.unbind("CTRL + UP")',
      'hl.unbind("CTRL + DOWN")',
      'hl.bind("CTRL + UP",',
      '  hl.dsp.exec_cmd("omarchy-shell -q shell summon io.github.nobledoodle.omission {}"),',
      '  { description = "Open Omission" })',
      'hl.bind("CTRL + DOWN",',
      '  hl.dsp.exec_cmd("omarchy-shell -q shell hide io.github.nobledoodle.omission"),',
      '  { description = "Close Omission" })',
      'hl.gesture({',
      '  fingers = 3,',
      '  direction = "up",',
      '  mods = "",',
      '  scale = 1.0,',
      '  action = function()',
      '    hl.exec_cmd("omarchy-shell -q shell summon io.github.nobledoodle.omission {}")',
      '  end',
      '})',
      'hl.gesture({',
      '  fingers = 3,',
      '  direction = "down",',
      '  mods = "",',
      '  scale = 1.0,',
      '  action = function()',
      '    hl.exec_cmd("omarchy-shell -q shell call io.github.nobledoodle.omission activateDisplayed ignored")',
      '  end',
      '})'
    ].join("\n")
  }

  function cleanupLua() {
    return [
      'local owner = "' + root.ownerToken + '"',
      'if _G.omission_owner == owner then',
      '  _G.omission_owner = nil',
      '  hl.unbind("CTRL + UP")',
      '  hl.unbind("CTRL + DOWN")',
      '  hl.gesture({ fingers = 3, direction = "up", mods = "", scale = 1.0, action = "unset" })',
      '  hl.gesture({ fingers = 3, direction = "down", mods = "", scale = 1.0, action = "unset" })',
      'end'
    ].join("\n")
  }

  function queueApply() {
    if (!root.shuttingDown) applyTimer.restart()
  }

  function applyBindings() {
    if (root.shuttingDown) return
    if (removeGestureProcess.running || applyProcess.running) {
      root.applyQueued = true
      return
    }

    root.applyQueued = false
    removeGestureProcess.command = ["hyprctl", "eval", root.removeGestureLua()]
    removeGestureProcess.running = true
  }

  function startApply() {
    if (root.shuttingDown) return
    applyProcess.command = ["hyprctl", "eval", root.applyLua()]
    applyProcess.running = true
  }

  Timer {
    id: applyTimer
    interval: 100
    repeat: false
    onTriggered: root.applyBindings()
  }

  Process {
    id: removeGestureProcess
    environment: root.trustedEnvironment
    onExited: root.startApply()
  }

  Process {
    id: applyProcess
    environment: root.trustedEnvironment
    stdout: StdioCollector { id: applyStdout; waitForEnd: true }
    stderr: StdioCollector { id: applyStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (root.shuttingDown) return
      if (exitCode !== 0) {
        var detail = String(applyStdout.text || applyStderr.text || "").trim()
        console.warn("io.github.nobledoodle.omission: failed to register shortcut and gesture (exit "
          + exitCode + ")" + (detail ? ": " + detail : ""))
      }
      if (root.applyQueued) root.queueApply()
    }
  }

  // Alt-Tab registration is delegated to a dedicated binding component.
  // On integrated teardown it launches nothing itself; the destruction
  // handler below sequences its cleanupScript with this service's own
  // cleanup and the single restoring reload in one detached command.
  AltTabService {
    id: altTabService
    shell: root.shell
    integrationMode: true
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (event && String(event.name) === "configreloaded") root.queueApply()
    }
  }

  Component.onCompleted: {
    root.queueApply()
  }

  FileView {
    id: spacesStateFile
    path: root.spacesStatePath
    watchChanges: true
    printErrors: false
    atomicWrites: true
    onLoaded: root.loadManagedSpaces(text())
    onLoadFailed: if (!root.spacesLoaded) {
      root.managedWorkspaceIds = []
      root.spacesLoaded = true
    }
    onFileChanged: reload()
  }

  FileView {
    id: spaceNamesFile
    path: root.spaceNamesPath
    watchChanges: true
    printErrors: false
    atomicWrites: true
    onLoaded: root.loadSpaceNames(text())
    onLoadFailed: if (!root.namesLoaded) {
      root.spaceNames = ({})
      root.namesLoaded = true
    }
    onFileChanged: reload()
  }

  FileView {
    id: settingsFile
    path: root.settingsPath
    watchChanges: true
    printErrors: false
    atomicWrites: true
    onLoaded: root.loadSettings(text())
    onLoadFailed: if (!root.settingsLoaded) {
      root.settings = WindowModel.normalizedSettings({})
      root.settingsLoaded = true
    }
    onFileChanged: reload()
  }

  IpcHandler {
    target: "io.github.nobledoodle.omission-state"

    function get(): string {
      return JSON.stringify(root.managedWorkspaceIds)
    }

    function set(ids: string): string {
      var raw = String(ids || "").trim()
      var values = raw ? raw.split(":") : []
      for (var i = 0; i < values.length; i++) {
        if (!/^\d+$/.test(values[i])) return "invalid"
        values[i] = Number(values[i])
      }
      return JSON.stringify(root.setManagedSpaces(values))
    }

    function names(): string {
      return JSON.stringify(root.spaceNames)
    }

    function name(id: string): string {
      return root.spaceName(id)
    }

    function rename(id: string, value: string): string {
      return root.setSpaceName(id, value)
    }

    function clearName(id: string): string {
      return root.setSpaceName(id, "")
    }

    function clearNames(): string {
      return JSON.stringify(root.setSpaceNames(({})))
    }

    function settings(): string {
      return JSON.stringify(root.settings)
    }

    function barStyle(style: string): string {
      if (WindowModel.BAR_STYLES.indexOf(String(style)) < 0) return "invalid"
      return JSON.stringify(root.setBarStyle(style))
    }

    function showBarSpaces(shown: string): string {
      if (shown !== "true" && shown !== "false") return "invalid"
      return JSON.stringify(root.setShowBarSpaces(shown === "true"))
    }
  }

  Component.onDestruction: {
    root.shuttingDown = true
    applyTimer.stop()
    if (removeGestureProcess.running) removeGestureProcess.running = false
    if (applyProcess.running) applyProcess.running = false
    // One sequential detached command: Alt-Tab cleanup, then this
    // service's cleanup, then the single restoring reload. Sequencing —
    // never a timed delay — guarantees no Alt-Tab unbind lands after the
    // reload has restored configured bindings.
    Quickshell.execDetached({
      command: [
        "sh", "-c",
        'hyprctl eval "$1" >/dev/null 2>&1; hyprctl eval "$2" >/dev/null 2>&1; hyprctl reload >/dev/null 2>&1',
        "omission-cleanup",
        altTabService.cleanupScript,
        root.cleanupLua()
      ],
      environment: root.trustedEnvironment
    })
  }
}
