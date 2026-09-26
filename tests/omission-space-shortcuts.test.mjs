import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const qml = readFileSync(new URL("../Overview.qml", import.meta.url), "utf8")
const adjacentWorkspace = qml.match(
  /function selectAdjacentWorkspace\(direction\)\s*\{[\s\S]*?\n  \}/,
)?.[0] || ""

test("Control arrows preview the adjacent space without closing Omission", () => {
  assert.match(qml, /Qt\.Key_Left && \(event\.modifiers & Qt\.ControlModifier\)\)\s*\{\s*root\.selectAdjacentWorkspace\(-1\)/)
  assert.match(qml, /Qt\.Key_Right && \(event\.modifiers & Qt\.ControlModifier\)\)\s*\{\s*root\.selectAdjacentWorkspace\(1\)/)
  assert.match(adjacentWorkspace, /root\.workspaceIds\.indexOf\(root\.selectedWorkspaceId\)/)
  assert.match(adjacentWorkspace, /root\.selectWorkspace\(root\.workspaceIds\[target\]\)/)
  assert.doesNotMatch(adjacentWorkspace, /activateWorkspace|close\(\)|finishClose/)
})

test("Shift arrows retain explicit space reordering", () => {
  assert.match(qml, /Qt\.Key_Left && \(event\.modifiers & Qt\.ShiftModifier\)\)\s*\{\s*root\.nudgeSelectedWorkspace\(-1\)/)
  assert.match(qml, /Qt\.Key_Right && \(event\.modifiers & Qt\.ShiftModifier\)\)\s*\{\s*root\.nudgeSelectedWorkspace\(1\)/)
  assert.ok(
    qml.indexOf("Qt.Key_Left && (event.modifiers & Qt.ShiftModifier)")
      < qml.indexOf("Qt.Key_Left && (event.modifiers & Qt.ControlModifier)"),
    "Shift must retain precedence when both modifiers are pressed",
  )
})
