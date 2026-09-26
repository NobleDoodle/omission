import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const root = new URL("../", import.meta.url)
const rootPath = fileURLToPath(root)
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"))
const shippedFiles = readdirSync(rootPath, { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(?:js|json|md|qml)$/.test(entry.name))
  .map(entry => ({
    name: entry.name,
    source: readFileSync(new URL(entry.name, root), "utf8"),
  }))

// Mission Control's identifiers, which Omission was derived from. Only the
// README may name them (to say how to switch over); nothing that runs may.
// Built from pieces so this file does not contain them either.
const upstreamId = ["bitr0t", "omarchy-mission-control"].join(".")
const upstreamDashNamespace = ["bitr0t", "omarchy-mission-control"].join("-")
const upstreamLuaNamespace = ["bitr0t", "omarchy_mission_control"].join("_")

test("package uses one public plugin identity", () => {
  assert.equal(manifest.id, "io.github.nobledoodle.omission")
  assert.equal(manifest.name, "Omission")
  assert.equal(manifest.version, "1.0.0")
  assert.equal(manifest.author, "NobleDoodle")
  assert.equal(manifest.license, "MIT")
  for (const file of shippedFiles) {
    if (file.name !== "README.md")
      assert.ok(!file.source.includes(upstreamId), `${file.name} contains Mission Control's plugin id`)
    assert.ok(!file.source.includes(upstreamDashNamespace), `${file.name} contains Mission Control's IPC namespace`)
    assert.ok(!file.source.includes(upstreamLuaNamespace), `${file.name} contains Mission Control's Lua namespace`)
  }
})

test("plugin service never rewrites shell configuration", () => {
  const service = readFileSync(new URL("Service.qml", root), "utf8")
  assert.doesNotMatch(service, /mutateShellConfig|barMigration|shellConfig|bar\.layout/)
})

test("the package documents explicit install, switching over, and removal", () => {
  const readme = readFileSync(new URL("README.md", root), "utf8")
  assert.match(readme, /omarchy plugin add https:\/\/github\.com\/NobleDoodle\/omission --enable/)
  assert.match(readme, /omarchy plugin update io\.github\.nobledoodle\.omission/)
  assert.match(readme, /omarchy plugin remove io\.github\.nobledoodle\.omission/)
  assert.match(readme, /omarchy plugin disable bitr0t\.omarchy-mission-control/)
  assert.match(readme, /omarchy plugin remove bitr0t\.omarchy-mission-control --yes/)
  assert.match(readme, /never edits `~\/\.config\/omarchy\/shell\.json` or `bar\.layout` itself/)
  assert.match(readme, /\[MIT\]\(LICENSE\)/)
})

test("the license keeps the original author's copyright alongside ours", () => {
  const license = readFileSync(new URL("LICENSE", root), "utf8")
  assert.match(license, /^MIT License/)
  assert.match(license, /Copyright \(c\) 2026 NobleDoodle/)
  assert.match(license, /Copyright \(c\) 2026 Ryan Macy/)
  const readme = readFileSync(new URL("README.md", root), "utf8")
  assert.match(readme, /Ryan Macy/)
  assert.match(readme, /rmacy\/omarchy-mission-control/)
})
