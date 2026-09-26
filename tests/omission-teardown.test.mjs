import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const service = readFileSync(new URL("../Service.qml", import.meta.url), "utf8")
const altTab = readFileSync(new URL("../AltTabService.qml", import.meta.url), "utf8")

const serviceTeardown = service.match(/Component\.onDestruction:\s*\{([\s\S]*?)\n  \}\n\}/)?.[1] || ""
const altTabTeardown = altTab.match(/Component\.onDestruction:\s*\{([\s\S]*?)\n  \}\n\}/)?.[1] || ""
const hostCleanup = service.match(/function cleanupLua\(\)\s*\{([\s\S]*?)\n  \}\n\n  function queueApply/)?.[1] || ""

// The detached sh script is the only single-quoted string starting with
// hyprctl in each handler.
const hostScript = serviceTeardown.match(/'(hyprctl[^']*)'/)?.[1] || ""
const standaloneScript = altTabTeardown.match(/'(hyprctl[^']*)'/)?.[1] || ""
test("host teardown sequences Alt-Tab cleanup, host cleanup, then the final reload", () => {
  const altTabEval = hostScript.indexOf('hyprctl eval "$1"')
  const hostEval = hostScript.indexOf('hyprctl eval "$2"')
  const reload = hostScript.indexOf("hyprctl reload")
  assert.ok(altTabEval > -1, "Alt-Tab cleanup eval must be staged first")
  assert.ok(hostEval > altTabEval, "host cleanup eval must follow the Alt-Tab cleanup eval")
  assert.ok(reload > hostEval, "hyprctl reload must be the final stage")
  const argOrder = serviceTeardown.indexOf("altTabService.cleanupScript")
    - serviceTeardown.indexOf("root.cleanupLua()")
  assert.ok(argOrder < 0, "$1 must bind the Alt-Tab cleanup and $2 the host cleanup")
})

test("integrated teardown issues exactly one reload, and it lives in the host only", () => {
  assert.equal((hostScript.match(/hyprctl reload/g) || []).length, 1)
  assert.equal((service.match(/hyprctl reload/g) || []).length, 1)
  assert.doesNotMatch(hostCleanup, /reload/, "host cleanup Lua must not reload; the host script owns the single reload")
})

test("teardown ordering is sequential, never sleep-based", () => {
  assert.doesNotMatch(service, /\bsleep\b/)
  assert.doesNotMatch(altTab, /\bsleep\b/)
})

test("integrationMode launches no independent cleanup", () => {
  const guard = altTabTeardown.indexOf("if (root.integrationMode) return")
  const launch = altTabTeardown.indexOf("Quickshell.execDetached")
  assert.ok(guard > -1, "teardown must early-return in integration mode")
  assert.ok(launch > guard, "the detached cleanup must only be reachable standalone")
  assert.equal((altTabTeardown.match(/Quickshell\.execDetached/g) || []).length, 1)
})
test("integrated child is identified and instantiated in integration mode", () => {
  assert.match(service, /AltTabService \{\s*\n\s*id: altTabService\s*\n\s*shell: root\.shell\s*\n\s*integrationMode: true\s*\n\s*\}/)
})

test("AltTabService exposes its generated cleanup for the host to sequence", () => {
  assert.match(altTab,
    /readonly property string cleanupScript: BindingScript\.generateCleanup\(\{\s*\n\s*ownerToken: root\.ownerToken\s*\n\s*\}\)/)
})

test("standalone teardown keeps cleanup-then-reload in one sequential command", () => {
  const cleanupEval = standaloneScript.indexOf('hyprctl eval "$1"')
  const reload = standaloneScript.indexOf("hyprctl reload")
  assert.ok(cleanupEval > -1 && reload > cleanupEval, "standalone cleanup must precede its reload")
  assert.equal((standaloneScript.match(/hyprctl reload/g) || []).length, 1)
  assert.match(altTabTeardown, /root\.cleanupScript/, "standalone path evals the exposed cleanup string")
})
