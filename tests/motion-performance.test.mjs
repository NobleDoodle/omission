import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const qml = readFileSync(new URL("../Overview.qml", import.meta.url), "utf8")

test("overview reveal uses one bounded cubic motion timeline", () => {
  assert.match(qml, /Behavior on revealProgress\s*\{[\s\S]*?root\.closing \? root\.closeDuration : root\.openDuration/)
  assert.match(qml, /easing\.type:\s*root\.closing \? Easing\.InOutCubic : Easing\.OutCubic/)
  assert.doesNotMatch(qml, /Easing\.OutBack/)
  assert.doesNotMatch(qml, /gridOrigin\.mapToItem|sourceCenter|stagger/)
  assert.match(qml, /opacity:\s*root\.revealProgress/)
})

test("window thumbnails start at open in bounded batches; live preview waits for motion", () => {
  assert.match(qml, /id:\s*preview[\s\S]*?live:\s*root\.opened && \(!hasContent/)
  assert.match(qml, /if \(!wasVisible\) \{[\s\S]*?root\.windowCapturesEnabled = true\s*root\.thumbnailWorkspaceBudget = 1/)
  assert.match(qml, /id:\s*thumbnailCaptureBatchTimer[\s\S]*?interval:\s*34[\s\S]*?thumbnailWorkspaceBudget \+= 1/)
  assert.match(qml, /captureSource:\s*root\.windowCapturesEnabled[\s\S]*?workspaceChip\.index < root\.thumbnailWorkspaceBudget[\s\S]*?live:\s*false/)
  assert.match(qml, /function finishClose\(\)[\s\S]*?root\.windowCapturesEnabled = false/)
  // Only the video wallpaper keeps the 270 ms deferral, and it must not reset
  // the window batches when it fires.
  assert.match(qml, /id:\s*thumbnailCaptureTimer[\s\S]*?interval:\s*270/)
  assert.doesNotMatch(qml, /root\.thumbnailCapturesEnabled = true\s*root\.thumbnailWorkspaceBudget = 0/)
})

test("video wallpaper sampling is deferred and one-shot", () => {
  assert.match(qml, /source:\s*root\.opened && root\.thumbnailCapturesEnabled[\s\S]*?backgroundKind === "video"/)
  assert.match(qml, /ShaderEffectSource\s*\{[\s\S]*?sourceItem:\s*root\.opened && root\.thumbnailCapturesEnabled[\s\S]*?live:\s*false[\s\S]*?scheduleUpdate\(\)/)
})

test("close freezes the composed scene until the exit animation finishes", () => {
  assert.match(qml, /function close\(\)[\s\S]*?root\.closing = true[\s\S]*?root\.revealProgress = 0[\s\S]*?closeAnimationTimer\.restart\(\)/)
  assert.match(qml, /id:\s*closeAnimationTimer[\s\S]*?interval:\s*root\.closeDuration \+ 24[\s\S]*?root\.finishClose\(\)/)
  assert.match(qml, /function finishClose\(\)[\s\S]*?root\.windows = \[\]/)
})
