import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { test } from "node:test"
import {
  prepareVisualOutput,
  SENTINEL,
  SENTINEL_CONTENT
} from "./live/output-path.mjs"

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "omission-output-"))
  await mkdir(resolve(root, "tests/live"), { recursive: true })
  return root
}

async function withFixture(run) {
  const root = await fixture()
  try { await run(root) }
  finally { await rm(root, { recursive: true, force: true }) }
}

test("default output creates a unique owned child without deleting neighbors", async () => {
  await withFixture(async root => {
    const allowed = resolve(root, "tests/live/output")
    await mkdir(allowed, { recursive: true })
    const neighbor = resolve(allowed, "keep.txt")
    await writeFile(neighbor, "keep")

    const result = await prepareVisualOutput(root, "", "run-safe")
    assert.equal(result.outputDir, resolve(allowed, "run-safe"))
    assert.equal(await readFile(result.sentinel, "utf8"), SENTINEL_CONTENT)
    assert.equal(await readFile(neighbor, "utf8"), "keep")
    assert.equal(result.sentinel, resolve(result.outputDir, SENTINEL))
  })
})

test("rejects arbitrary, root, nested, and existing output paths without deletion", async () => {
  await withFixture(async root => {
    const allowed = resolve(root, "tests/live/output")
    await mkdir(allowed, { recursive: true })
    const foreign = resolve(allowed, "foreign")
    await mkdir(foreign)
    const marker = resolve(foreign, "valuable.txt")
    await writeFile(marker, "valuable")

    for (const candidate of [
      root,
      allowed,
      resolve(root, "outside"),
      resolve(allowed, "nested/run"),
      foreign
    ]) {
      await assert.rejects(() => prepareVisualOutput(root, candidate, "ignored"))
    }
    assert.equal(await readFile(marker, "utf8"), "valuable")
  })
})

test("rejects a symlinked allowed root and leaves its target untouched", async () => {
  await withFixture(async root => {
    const outside = resolve(root, "outside")
    const live = resolve(root, "tests/live")
    await mkdir(outside)
    await writeFile(resolve(outside, "valuable.txt"), "valuable")
    await symlink(outside, resolve(live, "output"))

    await assert.rejects(() => prepareVisualOutput(root, "", "run-safe"), /real directory/)
    assert.equal(await readFile(resolve(outside, "valuable.txt"), "utf8"), "valuable")
  })
})

test("rejects a symlink candidate without following or deleting it", async () => {
  await withFixture(async root => {
    const allowed = resolve(root, "tests/live/output")
    const outside = resolve(root, "outside")
    await mkdir(allowed, { recursive: true })
    await mkdir(outside)
    await writeFile(resolve(outside, "valuable.txt"), "valuable")
    const candidate = resolve(allowed, "run-link")
    await symlink(outside, candidate)

    await assert.rejects(() => prepareVisualOutput(root, candidate, "ignored"), /already exists/)
    assert.equal(await readFile(resolve(outside, "valuable.txt"), "utf8"), "valuable")
  })
})
