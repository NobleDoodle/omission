import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import "AltTabBindingScript.js" as BindingScript

// Alt-Tab half of the merged plugin's bindings. The host Service.qml
// injects `shell`, sequences this component's cleanup with its own, and
// owns the single Hyprland reload on teardown; this component only
// registers, re-arms, and retires the Alt-Tab chords and its temporary
// submap.
Item {
  id: root

  property var shell: null
  // Integration mode: on teardown this component launches nothing. The
  // host Service evals `cleanupScript` ahead of its own cleanup and the
  // single restoring reload in one sequential detached command, so no
  // Alt-Tab unbind can race past that reload.
  property bool integrationMode: false

  // Generated compositor-side cleanup for this instance's owner token.
  // The integrated host reads this instead of racing an independent
  // teardown process against the component; standalone teardown evals it.
  readonly property string cleanupScript: BindingScript.generateCleanup({
    ownerToken: root.ownerToken
  })

  readonly property string ownerToken: "io.github.nobledoodle.omission-alt-tab-" + Date.now()
    + "-" + Math.random().toString(36).slice(2)
  // Commands resolve through root-owned directories only, never the PATH the
  // shell inherited, so nothing earlier in that PATH can stand in for them.
  readonly property string trustedPath: "/usr/local/bin:/usr/bin:/bin"
  readonly property var trustedEnvironment: ({ PATH: root.trustedPath })
  property bool applyQueued: false
  property bool shuttingDown: false
  property int applyAttempts: 0
  property bool registrationFailed: false

  function queueApply() {
    if (root.shuttingDown) return
    root.applyAttempts = 0
    root.registrationFailed = false
    applyTimer.restart()
  }

  function applyBindings() {
    if (root.shuttingDown) return
    if (applyProcess.running) {
      root.applyQueued = true
      return
    }
    root.applyQueued = false
    applyProcess.command = ["hyprctl", "eval",
      BindingScript.generateApply({ ownerToken: root.ownerToken })]
    applyProcess.running = true
  }

  function notifyRegistrationFailure() {
    Quickshell.execDetached({
      command: [
        "notify-send", "-u", "critical", "-a", "Omission",
        "Omission Alt-Tab registration failed",
        "Alt-Tab bindings could not be registered after "
          + BindingScript.REGISTRATION_RETRY.maxAttempts
          + " attempts. Run hyprctl reload to retry."
      ],
      environment: root.trustedEnvironment
    })
  }

  Timer {
    id: applyTimer
    interval: 100
    repeat: false
    onTriggered: root.applyBindings()
  }

  Timer {
    id: retryTimer
    repeat: false
    onTriggered: root.applyBindings()
  }

  Process {
    id: applyProcess
    environment: root.trustedEnvironment
    onExited: function(exitCode) {
      if (root.shuttingDown) return
      if (exitCode === 0) {
        root.applyAttempts = 0
        root.registrationFailed = false
      } else {
        root.applyAttempts += 1
        if (root.applyAttempts < BindingScript.REGISTRATION_RETRY.maxAttempts) {
          retryTimer.interval = BindingScript.REGISTRATION_RETRY.baseDelayMs
            * Math.pow(2, root.applyAttempts - 1)
          retryTimer.restart()
          return
        }
        if (!root.registrationFailed) {
          root.registrationFailed = true
          console.warn("io.github.nobledoodle.omission: Alt-Tab registration failed after "
            + root.applyAttempts + " attempts")
          root.notifyRegistrationFailure()
        }
      }
      if (root.applyQueued) root.queueApply()
    }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (!event || String(event.name) !== "configreloaded") return
      if (root.shell && typeof root.shell.callIfLoaded === "function")
        root.shell.callIfLoaded(BindingScript.SHELL_TARGET, "cancel", "config-reload")
      root.queueApply()
    }
  }

  Component.onCompleted: root.queueApply()

  Component.onDestruction: {
    root.shuttingDown = true
    applyTimer.stop()
    retryTimer.stop()
    if (applyProcess.running) applyProcess.running = false
    // Integrated teardown is owned by the host Service, which sequences
    // this component's cleanupScript with its own cleanup and the single
    // restoring reload; launching anything here would race that reload.
    if (root.integrationMode) return
    Quickshell.execDetached({
      command: [
        "sh", "-c",
        'hyprctl eval "$1" >/dev/null 2>&1; hyprctl reload >/dev/null 2>&1',
        "omission-alt-tab-cleanup",
        root.cleanupScript
      ],
      environment: root.trustedEnvironment
    })
  }
}
