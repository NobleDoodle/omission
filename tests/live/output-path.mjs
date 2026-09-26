import { lstat, mkdir, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

export const SENTINEL = ".omission-visual-output"
export const SENTINEL_CONTENT = "owned-by-omission-visual-test\n"

function strictChild(parent, candidate) {
  const rel = relative(parent, candidate)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes("/")
}

async function pathExists(path) {
  try { await lstat(path); return true }
  catch (error) {
    if (error && error.code === "ENOENT") return false
    throw error
  }
}

export async function prepareVisualOutput(repoRoot, requested = "", runId = "") {
  const allowedRoot = resolve(repoRoot, "tests/live/output")
  await mkdir(allowedRoot, { recursive: true })
  const allowedInfo = await lstat(allowedRoot)
  if (!allowedInfo.isDirectory() || allowedInfo.isSymbolicLink())
    throw new Error("visual output root must be a real directory")
  const canonicalRoot = await realpath(allowedRoot)
  if (canonicalRoot !== allowedRoot)
    throw new Error("visual output root must not traverse symlinks")

  const suffix = runId || `run-${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${process.pid}`
  const candidate = resolve(requested || resolve(allowedRoot, suffix))
  if (!strictChild(allowedRoot, candidate))
    throw new Error(`visual output must be a new direct child of ${allowedRoot}`)
  if (await pathExists(candidate))
    throw new Error("visual output directory already exists; refusing to delete or reuse it")

  await mkdir(candidate, { recursive: false })
  await writeFile(resolve(candidate, SENTINEL), SENTINEL_CONTENT, { flag: "wx" })
  return { outputDir: candidate, allowedRoot, sentinel: resolve(candidate, SENTINEL) }
}
