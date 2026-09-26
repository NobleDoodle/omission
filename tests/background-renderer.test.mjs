import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const qml = readFileSync(new URL("../Overview.qml", import.meta.url), "utf8")

test("workspace cards support both resolved image and video sources", () => {
  assert.match(qml, /backgroundResolverPath/)
  assert.match(qml, /backgroundKind === "image"/)
  assert.match(qml, /backgroundKind === "video"/)
  assert.match(qml, /source:\s*visible \? Util\.fileUrl\(root\.backgroundPath\) : ""/)
})

test("all workspace cards share exactly one muted video decoder", () => {
  assert.equal((qml.match(/\bMediaPlayer\s*\{/g) || []).length, 1)
  assert.equal((qml.match(/\bVideoOutput\s*\{/g) || []).length, 1)
  assert.match(qml, /audioOutput:\s*AudioOutput\s*\{[\s\S]*?muted:\s*true[\s\S]*?volume:\s*0/)
  assert.match(qml, /loops:\s*MediaPlayer\.Infinite/)
  assert.match(qml, /ShaderEffectSource\s*\{[\s\S]*?sourceItem:[\s\S]*?sharedVideoOutput/)
})

test("video work stops and resolver polling is bounded by overlay lifecycle", () => {
  assert.match(qml, /function finishClose\(\)\s*\{[\s\S]*?sharedVideoPlayer\.stop\(\)/)
  assert.match(qml, /function finishClose\(\)\s*\{[\s\S]*?backgroundPollTimer\.stop\(\)/)
  assert.match(qml, /id:\s*backgroundPollTimer[\s\S]*?interval:\s*5000[\s\S]*?repeat:\s*true/)
  assert.match(qml, /if \(!root\.opened[\s\S]*?backgroundSourceProcess\.running\) return/)
})
