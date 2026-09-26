import QtQuick
import Quickshell
import qs.Commons
import "plugin" as Plugin

ShellRoot {
  id: root

  property bool failed: false
  property var overlay: null
  property var shellStub: ({
    marker: "runtime-shell-stub",
    appLibrary: null,
    serviceFor: function () { return null }
  })
  property var manifestStub: ({ id: "io.github.nobledoodle.omission", version: "4.0.0" })
  property var originalShellValues: null
  property var originalThemeShellValues: null
  property var originalUserShellValues: null
  property color originalBackground: "transparent"

  function fail(message) {
    if (root.failed) return
    root.failed = true
    console.error("OMISSION_RUNTIME_SMOKE_FAIL: " + message)
  }

  function check(condition, message) {
    if (!condition) root.fail(message)
  }

  function parsedSwitcherStatus() {
    try { return JSON.parse(root.overlay.switcherStatus("")) }
    catch (error) { root.fail("switcherStatus returned invalid JSON: " + error); return ({}) }
  }

  function parsedStatus() {
    try { return JSON.parse(root.overlay.status("")) }
    catch (error) { root.fail("status returned invalid JSON: " + error); return ({}) }
  }

  Component {
    id: overlayFactory
    Plugin.Overlay {}
  }

  Component.onCompleted: {
    root.overlay = overlayFactory.createObject(root, {
      shell: root.shellStub,
      manifest: root.manifestStub
    })
    root.check(root.overlay !== null, "production Overlay failed to instantiate")
    if (!root.overlay) return

    var overview = root.overlay.overview
    var switcher = root.overlay.switcher
    root.check(overview !== null && switcher !== null,
      "Overlay must expose overview and switcher child references")
    if (!overview || !switcher) return

    // Host injection is forwarded to both surfaces.
    root.check(overview.shell && overview.shell.marker === "runtime-shell-stub"
      && switcher.shell && switcher.shell.marker === "runtime-shell-stub",
      "shell was not forwarded to both surfaces")
    root.check(overview.manifest && overview.manifest.id === "io.github.nobledoodle.omission"
      && switcher.manifest && switcher.manifest.version === "4.0.0",
      "manifest was not forwarded to both surfaces")
    root.check(switcher.omarchyPath === root.overlay.omarchyPath,
      "omarchyPath was not forwarded to the switcher")

    // Both forwarded public API groups exist.
    for (var name of ["open", "toggle", "close", "status", "interactionGeometry",
      "advance", "commit", "cancel", "switcherStatus"]) {
      root.check(typeof root.overlay[name] === "function",
        "Overlay." + name + " must be a callable function")
    }

    // Inactive by construction: neither surface may open.
    root.check(root.overlay.opened === false, "fresh Overlay must be closed")
    var closedSwitcher = root.parsedSwitcherStatus()
    root.check(closedSwitcher.open === false, "initial switcher state must be closed")
    var closedControl = root.parsedStatus()
    root.check(closedControl.open === false, "initial Omission state must be closed")
    root.check(Array.isArray(closedControl.workspaceIds),
      "Omission status must publish workspaceIds")

    // Forwarding is verbatim, not a re-encoding.
    root.check(root.overlay.switcherStatus("x") === switcher.status("x"),
      "switcherStatus must forward the switcher status verbatim")
    root.check(root.overlay.status("x") === overview.status("x"),
      "status must forward the Omission status verbatim")

    // Zero-client state.
    switcher.clients = []
    switcher.loading = false
    switcher.modelError = ""
    root.check(root.parsedSwitcherStatus().state === "empty", "zero-client state must be empty")

    // Loading state.
    switcher.loading = true
    root.check(root.parsedSwitcherStatus().state === "loading", "loading flag must surface")
    switcher.loading = false

    // Single-client state.
    switcher.clients = [{ stableId: "1", appName: "One", displayTitle: "Window" }]
    switcher.selectedIndex = 0
    var single = root.parsedSwitcherStatus()
    root.check(single.state === "single" && single.selectedStableId === "1",
      "single-client state or stable identity is wrong")

    // Many-client state.
    switcher.clients = [
      { stableId: "1", appName: "One", displayTitle: "First" },
      { stableId: "2", appName: "Two", displayTitle: "Second" }
    ]
    switcher.selectedIndex = 1
    var multiple = root.parsedSwitcherStatus()
    root.check(multiple.state === "multiple" && multiple.selectedStableId === "2",
      "many-client state or selection is wrong")

    // Model failure must not render as empty.
    switcher.modelError = "synthetic failure"
    var errored = root.parsedSwitcherStatus()
    root.check(errored.state === "error" && errored.error === "synthetic failure",
      "model failure must surface as the error state")
    switcher.modelError = ""

    // Safe dismissal paths keep the overlay inactive.
    root.overlay.close()
    root.overlay.cancel("smoke")
    root.overlay.commit("0")
    root.check(root.parsedSwitcherStatus().open === false, "cancel did not keep switcher closed")
    root.check(root.parsedStatus().open === false, "close did not keep Omission closed")

    themeTimer.start()
  }

  Timer {
    id: themeTimer
    interval: 500
    repeat: false
    onTriggered: {
      root.originalShellValues = Color.shellValues
      root.originalThemeShellValues = Color.themeShellValues
      root.originalUserShellValues = Color.userShellValues
      root.originalBackground = Color.background
      Color.themeShellValues = ({ "menu.background": "#123456" })
      Color.userShellValues = ({})
      Color.mergeShell()
      Qt.callLater(root.finishThemeCheck)
    }
  }

  function finishThemeCheck() {
    var switcherColor = String(root.overlay.switcher.backgroundColor).toLowerCase()
    var controlColor = String(root.overlay.overview.backgroundColor).toLowerCase()
    root.check(switcherColor.indexOf("123456") >= 0,
      "switcher background did not react to theme token mutation (got " + switcherColor + ")")
    root.check(controlColor.indexOf("123456") >= 0,
      "Omission background did not react to theme token mutation (got " + controlColor + ")")
    Color.background = root.originalBackground
    Color.themeShellValues = root.originalThemeShellValues || ({})
    Color.userShellValues = root.originalUserShellValues || ({})
    Color.mergeShell()
    root.overlay.cancel("theme-check")
    root.check(root.parsedSwitcherStatus().open === false, "cancel did not close switcher")
    if (!root.failed) console.log("OMISSION_RUNTIME_SMOKE_PASS")
  }
}
