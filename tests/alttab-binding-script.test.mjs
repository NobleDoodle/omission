import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"

const source = readFileSync(new URL("../AltTabBindingScript.js", import.meta.url), "utf8")
  .replace(/^\.pragma library\s*/m, "")
const bindingScript = {}
vm.createContext(bindingScript)
vm.runInContext(source, bindingScript, { filename: "AltTabBindingScript.js" })

const OWNER = "io.github.nobledoodle.omission-alt-tab-1756213000000-a1b2c3"
const STOCK_CHORDS = ["ALT + TAB", "ALT + SHIFT + TAB"]
const apply = bindingScript.generateApply({ ownerToken: OWNER })
const cleanup = bindingScript.generateCleanup({ ownerToken: OWNER })

function luaStrings(script) {
  return Array.from(script.matchAll(/"([^"\n]*)"/g), match => match[1])
}

test("generator is pure and deterministic for identical options", () => {
  assert.equal(bindingScript.generateApply({ ownerToken: OWNER }), apply)
  assert.equal(bindingScript.generateCleanup({ ownerToken: OWNER }), cleanup)
  assert.match(source, /never interpolates client data/)
  assert.doesNotMatch(source, /Date\.now|Math\.random|Quickshell|import Qt/)
})

test("rejects owner tokens that could inject Lua", () => {
  const hostile = [
    "",
    'a"; hl.exec_cmd("boom") --',
    "a\nlocal x = 1",
    "has space",
    "tab\tchar",
    "a".repeat(200),
    null,
    42
  ]
  for (const token of hostile) {
    assert.throws(() => bindingScript.generateApply({ ownerToken: token }), /ownerToken/)
    assert.throws(() => bindingScript.generateCleanup({ ownerToken: token }), /ownerToken/)
  }
})

test("interpolates only a fixed inventory of validated Lua string literals", () => {
  const allowed = new Set([
    OWNER,
    "omission-alt-tab",
    "omission_alt_tab_owner",
    "omission_alt_tab_active",
    "omission_alt_tab_binds",
    "omarchy-shell -q shell call io.github.nobledoodle.omission ",
    "reset",
    "table",
    "userdata",
    "HL.Keybind(expired)",
    "oneshot",
    " ",
    "",
    "advance",
    "commit",
    "cancel",
    "ignored",
    "Alt_L",
    "Alt_R",
    "ALT + TAB",
    "ALT + SHIFT + TAB",
    "LEFT",
    "RIGHT",
    "ESCAPE",
    "RETURN",
    "Alt-Tab",
    "Alt-Tab (reverse)",
    "Alt-Tab: next",
    "Alt-Tab: previous",
    "Alt-Tab: cancel",
    "Alt-Tab: select"
  ])
  for (const script of [apply, cleanup]) {
    for (const literal of luaStrings(script)) {
      assert.ok(allowed.has(literal), `unexpected Lua literal: ${JSON.stringify(literal)}`)
    }
  }
})

test("clamps timing options to bounded values", () => {
  const sloppy = bindingScript.generateApply({
    ownerToken: OWNER,
    coalesceMs: 99999,
    pollIntervalMs: "garbage",
    maxPollTicks: 1e9,
    commitDelayMs: -50
  })
  assert.match(sloppy, /local coalesce_ms = 500\n/)
  assert.match(sloppy, /local poll_ms = 16\n/)
  assert.match(sloppy, /local max_poll_ticks = 5000\n/)
  assert.match(sloppy, /local commit_delay_ms = 0\n/)
  assert.match(apply, /local max_poll_ticks = (\d+)\n/)
  const ticks = Number(apply.match(/local max_poll_ticks = (\d+)\n/)[1])
  assert.ok(ticks >= 10 && ticks <= 5000)
})

test("bind inventory: submap chords plus navigation keys, all handle-tracked", () => {
  assert.equal((apply.match(/hl\.bind\(/g) || []).length, 8)
  assert.equal((apply.match(/track\(hl\.bind\(/g) || []).length, 8)
  const [insideSubmap, globalPart = ""] = apply.split("\nend)\n")
  const submapBinds = Array.from(
    insideSubmap.matchAll(/track\(hl\.bind\("([^"]+)", function\(\)/g), m => m[1])
  assert.deepEqual(submapBinds,
    ["ALT + TAB", "ALT + SHIFT + TAB", "LEFT", "RIGHT", "ESCAPE", "RETURN"])
  const globalBinds = Array.from(
    globalPart.matchAll(/track\(hl\.bind\("([^"]+)", function\(\)/g), m => m[1])
  assert.deepEqual(globalBinds, STOCK_CHORDS)
  assert.ok(apply.indexOf("hl.define_submap(submap, function()") > -1)
  // No modifier release binds and no inhibitor bypass anywhere.
  assert.doesNotMatch(apply, /release\s*=\s*true/)
  assert.doesNotMatch(apply, /dont_inhibit/)
  assert.doesNotMatch(cleanup, /dont_inhibit/)
})

test("every keybind callback is owner-guarded before acting", () => {
  const guardedCallbacks = apply.match(
    /hl\.bind\("[^"]+", function\(\)\s+if not owned\(\) then return end\s+(?:push_advance|settle|begin)\(/g) || []
  assert.equal(guardedCallbacks.length, 8)
  assert.match(apply,
    /local function settle\(method, apply_pending\)\s+if not owned\(\) then return end/)
  assert.match(apply, /local function begin\(direction\)\s+if not owned\(\) then return end\s+if live\(\) then return end/)
  assert.match(apply, /local function push_advance\(delta\)\s+if not live\(\) then/)
  assert.match(apply, /local function flush_delta\(\)\s+flush_scheduled = false\s+if not live\(\) then/)
  assert.match(apply, /watch_alt = function\(\)\s+if not live\(\) then/)
  assert.match(apply, /local argument = apply_pending and tostring\(final_delta\) or "ignored"/)
  assert.match(apply, /hl\.timer\(function\(\)\s+if owned\(\) then shell_call\(method, argument\) end/)
})

test("reapply retires exact tracked handles before creating new binds", () => {
  const resetCall = apply.indexOf("\nreset_our_submap()\n")
  const disableLoop = apply.indexOf("disable(previous[index])")
  const registry = apply.indexOf("_G.omission_alt_tab_binds = {}")
  const ownerSet = apply.indexOf("_G.omission_alt_tab_owner = owner")
  const firstBind = apply.indexOf("hl.bind(")
  for (const index of [resetCall, disableLoop, registry, ownerSet, firstBind]) {
    assert.ok(index > -1)
  }
  assert.ok(resetCall < disableLoop, "submap reset must precede handle teardown")
  assert.ok(disableLoop < ownerSet, "old handles disabled before state is rewritten")
  assert.ok(ownerSet < firstBind, "state written before new binds exist")
  assert.equal((apply.match(/set_enabled\(false\)/g) || []).length, 1)
  assert.match(apply, /pcall\(function\(\) handle:set_enabled\(false\) end\)/)
})

test("submap reset only ever targets the plugin submap, never foreign ones", () => {
  for (const script of [apply, cleanup]) {
    const guarded = script.match(
      /if hl\.get_current_submap\(\) == submap then\s+hl\.dispatch\(hl\.dsp\.submap\("reset"\)\)\s+end/)
    assert.ok(guarded, "reset must be guarded by a current-submap check")
    assert.equal((script.match(/hl\.dsp\.submap\("reset"\)/g) || []).length, 1,
      "exactly one reset dispatch per script")
    assert.equal((script.match(/hl\.get_current_submap\(\) == submap/g) || []).length, 1)
  }
  // Only the two stock chords are ever string-unbound; generic and
  // modifier keys are untouched so foreign binds survive.
  for (const script of [apply, cleanup]) {
    const unbound = Array.from(script.matchAll(/hl\.unbind\("([^"]+)"\)/g), m => m[1])
    assert.deepEqual(unbound, STOCK_CHORDS)
  }
  const altLines = apply.split("\n").filter(line => line.includes('"Alt_L"') || line.includes('"Alt_R"'))
  assert.ok(altLines.length > 0)
  for (const line of altLines) assert.match(line, /is_key_down/)
})

test("polling is the sole Alt-release path and has a maximum lifetime", () => {
  assert.doesNotMatch(apply, /while true|repeat\s/)
  assert.match(apply, /poll_ticks = poll_ticks \+ 1/)
  assert.match(apply, /if poll_ticks >= max_poll_ticks then\s+settle\("commit", true\)/)
  assert.match(apply,
    /if not hl\.is_key_down\("Alt_L"\) and not hl\.is_key_down\("Alt_R"\) then\s+settle\("commit", true\)/)
  assert.match(apply, /hl\.timer\(watch_alt, \{ timeout = poll_ms, type = "oneshot" \}\)/)
})

test("rapid advances coalesce into one signed delta IPC call", () => {
  assert.match(apply, /pending_delta = pending_delta \+ delta/)
  assert.match(apply,
    /if not flush_scheduled then\s+flush_scheduled = true\s+hl\.timer\(flush_delta, \{ timeout = coalesce_ms, type = "oneshot" \}\)/)
  const advanceCalls = apply.match(/shell_call\("advance", tostring\(/g) || []
  assert.equal(advanceCalls.length, 2, "one immediate first call plus one coalesced flush")
  assert.match(apply, /shell_call\("advance", tostring\(direction\)\)/)
  assert.match(apply, /shell_call\("advance", tostring\(pending_delta\)\)\s+pending_delta = 0/)
  const beginArgs = Array.from(apply.matchAll(/begin\((-?\d+)\)/g), m => m[1])
  assert.deepEqual(beginArgs, ["1", "-1"], "session opens with sign-only direction")
})

test("emitted shell methods are exactly advance, commit and cancel", () => {
  assert.equal((apply.match(/hl\.exec_cmd/g) || []).length, 1, "single pcall-wrapped exec site")
  assert.match(apply, /pcall\(hl\.exec_cmd, "omarchy-shell -q shell call io\.github\.nobledoodle\.omission "/)
  const shellMethods = Array.from(apply.matchAll(/shell_call\("([a-z]+)"/g), m => m[1])
  const settleMethods = Array.from(apply.matchAll(/settle\("([a-z]+)", (?:true|false)\)/g), m => m[1])
  for (const method of [...shellMethods, ...settleMethods]) {
    assert.ok(["advance", "commit", "cancel"].includes(method), `unexpected method ${method}`)
  }
  assert.ok(settleMethods.includes("commit") && settleMethods.includes("cancel"))
})

test("registration retry policy is bounded", () => {
  const policy = bindingScript.REGISTRATION_RETRY
  assert.ok(Number.isInteger(policy.maxAttempts))
  assert.ok(policy.maxAttempts >= 1 && policy.maxAttempts <= 10)
  assert.ok(Number.isInteger(policy.baseDelayMs))
  assert.ok(policy.baseDelayMs >= 1 && policy.baseDelayMs <= 5000)
})

test("cleanup disables tracked handles and clears state without side effects", () => {
  assert.doesNotMatch(cleanup, /hl\.bind\(|hl\.timer\(|pending_delta|watch_alt/)
  assert.equal((cleanup.match(/set_enabled\(false\)/g) || []).length, 1)
  assert.match(cleanup, /_G\.omission_alt_tab_binds = nil/)
  const ownerGate = cleanup.indexOf("if _G.omission_alt_tab_owner == owner then")
  const ownerClear = cleanup.indexOf("_G.omission_alt_tab_owner = nil")
  assert.ok(ownerGate > -1 && ownerGate < ownerClear)
})

test("expired handles are skipped before any method call, in apply and cleanup", () => {
  // Hyprland 0.56 null-dereferences inside every keybind method once the
  // handle's bind is gone, and pcall cannot catch that segfault. Only
  // __tostring checks the weak reference, so it must gate set_enabled.
  for (const [name, script] of [["apply", apply], ["cleanup", cleanup]]) {
    const define = script.indexOf("local function disable(handle)")
    const guard = script.indexOf('if tostring(handle) == "HL.Keybind(expired)" then return end')
    const call = script.indexOf("handle:set_enabled(false)")
    assert.ok(define > -1 && guard > -1 && call > -1, name + ": disable() pieces present")
    assert.ok(define < guard && guard < call, name + ": liveness guard precedes set_enabled")
    assert.equal((script.match(/HL\.Keybind\(expired\)/g) || []).length, 1, name + ": one guard")
  }
})
