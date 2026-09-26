import QtQuick
import Quickshell

// Composite overlay entry for io.github.nobledoodle.omission. The shell host loads
// exactly one overlay per plugin and injects `shell` and `manifest`, so both
// surfaces live here as children of a single loader item. Omission
// keeps its long-standing IPC surface (`open`, `toggle`, `close`, `status`,
// `interactionGeometry`); the Alt-Tab switcher answers through `advance`,
// `commit`, `cancel`, and `switcherStatus`. Only one surface is ever open:
// every opening path closes the other first, and `close` (also used by the
// host's hide) dismisses both.
Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null
  readonly property bool opened: overviewSurface.opened || switcherSurface.opened

  // Child references for diagnostics and for the runtime smoke, which drives
  // surface state directly instead of through the host loader.
  readonly property var overview: overviewSurface
  readonly property var switcher: switcherSurface

  Overview {
    id: overviewSurface
    shell: root.shell
    manifest: root.manifest
  }

  WindowSwitcher {
    id: switcherSurface
    omarchyPath: root.omarchyPath
    shell: root.shell
    manifest: root.manifest
  }

  function open(argument) {
    if (switcherSurface.opened) switcherSurface.cancel()
    return overviewSurface.open(argument)
  }

  function toggle(argument) {
    if (switcherSurface.opened) switcherSurface.cancel()
    return overviewSurface.toggle(argument)
  }

  function close() {
    overviewSurface.close()
    switcherSurface.cancel()
  }

  // Three-finger swipe down: go to the space the overview is showing, like
  // Enter with nothing selected. With no overview up it does what hiding does,
  // so a swipe on the bare desktop never switches workspace.
  function activateDisplayed(argument) {
    if (overviewSurface.opened && !overviewSurface.closing) {
      switcherSurface.cancel()
      overviewSurface.activateWorkspace()
      return "activated"
    }
    close()
    return "closed"
  }

  function status(argument) {
    return overviewSurface.status(argument)
  }

  function interactionGeometry(argument) {
    return overviewSurface.interactionGeometry(argument)
  }

  function advance(delta) {
    if (overviewSurface.opened) overviewSurface.close()
    return switcherSurface.advance(delta)
  }

  function commit(argument) {
    switcherSurface.commit(argument)
  }

  function cancel(argument) {
    switcherSurface.cancel()
  }

  function switcherStatus(argument) {
    return switcherSurface.status(argument)
  }
}
