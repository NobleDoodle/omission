import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const qml = readFileSync(new URL("../Overview.qml", import.meta.url), "utf8")
const activateWindow = qml.match(
  /function activateWindow\(index\)\s*\{[\s\S]*?\n  \}\n\n  function activateSelected/,
)?.[0] || ""

test("clicking a Omission card activates that exact card", () => {
  assert.match(qml, /onClicked:\s*if \(!moved\) root\.activateWindow\(windowCell\.index\)/)
  assert.match(qml, /function activateSelected\(\)\s*\{\s*root\.activateWindow\(root\.selectedIndex\)/)
})

test("window activation revalidates identity and uses the Alt-Tab focus path", () => {
  assert.match(qml, /stableId:\s*String\(toplevel\.stableId \|\| metadata\.stableId \|\| ""\)/)
  assert.match(activateWindow, /SwitcherModel\.findSwitchableByStableId\(\s*Hyprland\.toplevels\.values, selectedStableId/)
  assert.match(activateWindow, /root\.close\(\)/)
  assert.match(activateWindow, /hl\.dsp\.focus\(\{ window = "stableid:/)
  assert.match(activateWindow, /hl\.dsp\.window\.bring_to_top\(\)/)
  assert.doesNotMatch(activateWindow, /captureSource|\.activate\(\)/)
})
