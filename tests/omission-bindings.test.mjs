import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const service = readFileSync(new URL("../Service.qml", import.meta.url), "utf8")
const apply = service.match(/function applyLua\(\)\s*\{([\s\S]*?)\n  \}\n\n  function cleanupLua/)?.[1] || ""
const cleanup = service.match(/function cleanupLua\(\)\s*\{([\s\S]*?)\n  \}\n\n  function queueApply/)?.[1] || ""

test("Control-Up only opens and Control-Down only closes Omission", () => {
  assert.match(apply, /hl\.bind\("CTRL \+ UP"/)
  assert.match(apply, /shell summon io\.github\.nobledoodle\.omission/)
  assert.match(apply, /description = "Open Omission"/)
  assert.match(apply, /hl\.bind\("CTRL \+ DOWN"/)
  assert.match(apply, /shell hide io\.github\.nobledoodle\.omission/)
  assert.match(apply, /description = "Close Omission"/)
  assert.doesNotMatch(apply, /CTRL \+ UP[\s\S]{0,220}?shell toggle io\.github\.nobledoodle\.omission/)
})

test("three-finger gestures open upward and go to the shown space downward", () => {
  assert.match(apply, /direction = "up"/)
  assert.match(apply, /action = function\(\)[\s\S]*?shell summon io\.github\.nobledoodle\.omission/)
  assert.match(apply, /direction = "down"[\s\S]*?shell call io\.github\.nobledoodle\.omission activateDisplayed/)
})

test("cleanup retires both global shortcuts and gestures", () => {
  assert.match(cleanup, /hl\.unbind\("CTRL \+ UP"\)/)
  assert.match(cleanup, /hl\.unbind\("CTRL \+ DOWN"\)/)
  assert.match(cleanup, /direction = "up"[\s\S]*?action = "unset"/)
  assert.match(cleanup, /direction = "down"[\s\S]*?action = "unset"/)
})
