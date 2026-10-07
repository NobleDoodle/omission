import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"

const root = new URL("../", import.meta.url)
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"))

test("manifest publishes the Omission v1.2.0 plugin", () => {
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.id, "io.github.nobledoodle.omission")
  assert.equal(manifest.version, "1.2.0")
  assert.deepEqual(manifest.kinds, ["overlay", "service", "bar-widget"])
  assert.equal(manifest.keepLoaded, true)
  assert.equal(manifest.barWidget.defaultSection, "left")
  assert.match(manifest.description, /Alt-Tab switcher/i)
  assert.match(manifest.description, /active workspace/i)
  assert.equal(manifest.entryPoints.overlay, "Overlay.qml")
  assert.equal(manifest.entryPoints.service, "Service.qml")
  assert.equal(manifest.entryPoints.barWidget, "BarWidget.qml")
  for (const entryPoint of Object.values(manifest.entryPoints)) {
    assert.ok(!entryPoint.startsWith("/") && !entryPoint.includes(".."))
    assert.ok(existsSync(new URL(entryPoint, root)), `missing entry point ${entryPoint}`)
  }
})

test("marketplace review artifacts are committed at root", () => {
  for (const file of ["README.md", "LICENSE"]) {
    assert.ok(existsSync(new URL(file, root)), `missing ${file}`)
  }
  assert.match(readFileSync(new URL("LICENSE", root), "utf8"), /^MIT License/)
  assert.match(readFileSync(new URL("README.md", root), "utf8"), /Capability disclosure/)
})
