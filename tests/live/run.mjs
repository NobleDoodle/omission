import { execFile as execFileCallback, spawn } from "node:child_process"
import { access, chmod, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { basename, resolve } from "node:path"
import { prepareVisualOutput } from "./output-path.mjs"

const execFile = promisify(execFileCallback)
const root = resolve(new URL("../..", import.meta.url).pathname)
const requestedOutput = process.env.OMISSION_VISUAL_OUTPUT || process.argv[2] || ""
let outputDir = ""
const inputHelper = resolve(process.env.OMISSION_UINPUT || `${root}/.build/omission-uinput`)
const statePath = `${process.env.HOME}/.local/state/omarchy/omission-spaces.json`
const results = []
const screenshots = []
const fixtures = []
let shotNumber = 0
let originalState = null
let originalNames = ({})
let stateExisted = false
let stateBackedUp = false
let desktopBackedUp = false
let sessionStarted = false
let originalWorkspace = 1
let originalCursor = { x: 0, y: 0 }
let fixtureA = -1
let fixtureB = -1

const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
const normalizeAddress = value => String(value || "").replace(/^0x/i, "").toLowerCase()
const html = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
})[character])

async function command(program, args = [], options = {}) {
  try {
    return await execFile(program, args, {
      cwd: root,
      timeout: options.timeout || 30000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...(options.env || {}) }
    })
  } catch (error) {
    if (options.allowFailure) return { stdout: error.stdout || "", stderr: error.stderr || "", error }
    throw new Error(`${program} ${args.join(" ")} failed: ${(error.stderr || error.message).trim()}`)
  }
}

async function shellCommand(args, options = {}) {
  let lastResult = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await command("omarchy-shell", args, { ...options, allowFailure: true })
    if (!result.error) return result
    lastResult = result
    const detail = String(result.stderr || result.error.message)
    if (!detail.includes("not responding") && !detail.includes("not running"))
      break
    await sleep(250)
  }
  if (options.allowFailure) return lastResult
  throw new Error(`omarchy-shell ${args.join(" ")} failed: ${String(
    lastResult?.stderr || lastResult?.error?.message || "unknown error").trim()}`)
}

async function jsonCommand(program, args) {
  const { stdout } = await command(program, args)
  return JSON.parse(stdout)
}

async function shellCall(method, argument = "{}") {
  const { stdout } = await shellCommand([
    "shell", "call", "io.github.nobledoodle.omission", method, String(argument)
  ])
  const value = stdout.trim()
  if (value === "error" || value === "unknown" || value === "unloaded")
    throw new Error(`Omission ${method} returned ${value}`)
  return value
}
async function status() {
  return JSON.parse(await shellCall("status"))
}

async function geometry() {
  return JSON.parse(await shellCall("interactionGeometry"))
}

async function barGeometry() {
  const { stdout } = await shellCommand([
    "io.github.nobledoodle.omission-spaces", "geometry"
  ])
  const value = stdout.trim()
  if (!value || value === "error") throw new Error(`bar geometry returned ${value || "empty output"}`)
  return JSON.parse(value)
}

async function waitFor(probe, timeout = 12000, interval = 80) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(interval)
  }
  if (lastError) throw lastError
  throw new Error(`condition did not become true within ${timeout}ms`)
}

function record(name, pass, details = "", image = null, statusValue = "pass") {
  results.push({ name, status: pass ? statusValue : "fail", details: String(details || ""), image })
  process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name}${details ? ` — ${details}` : ""}\n`)
  return pass
}

async function capture(slug, label) {
  shotNumber += 1
  const filename = `${String(shotNumber).padStart(2, "0")}-${slug}.png`
  const path = `${outputDir}/${filename}`
  await command("grim", [path], { timeout: 20000 })
  const info = await stat(path)
  if (info.size < 1024) throw new Error(`${filename} is unexpectedly small`)
  screenshots.push({ filename, label })
  return filename
}

async function ensureOpen(workspaceId = null) {
  const desired = workspaceId === null
    ? (await jsonCommand("hyprctl", ["-j", "activeworkspace"])).id
    : Number(workspaceId)
  const payload = JSON.stringify({ workspace: desired })
  const current = await status().catch(() => ({ open: false }))
  if (!current.open)
    await shellCommand(["shell", "summon", "io.github.nobledoodle.omission", payload])
  else
    await shellCall("open", payload)
  return await waitFor(async () => {
    const next = await status()
    return next.open && next.workspace === desired ? next : null
  }, 15000)
}

async function ensureClosed() {
  await shellCommand(["shell", "hide", "io.github.nobledoodle.omission"], { allowFailure: true })
  await waitFor(async () => !(await status()).open)
}

async function injectUntilOpen(args, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await input(...args)
    const opened = await waitFor(async () => {
      const value = await status()
      return value.open ? value : null
    }, 3000).catch(() => null)
    if (opened) return opened
    await ensureClosed().catch(() => {})
    await sleep(250)
  }
  return null
}

async function selectionInteraction(name, inputArgs, slug) {
  let before = await ensureOpen(fixtureA)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await input(...inputArgs)
    const after = await waitFor(async () => {
      const value = await status()
      return value.open && value.selectedIndex >= 0
        && value.selectedIndex !== before.selectedIndex ? value : null
    }, 2500).catch(() => null)
    if (after) {
      record(name, true, `${before.selectedIndex} -> ${after.selectedIndex}`,
        await capture(slug, name))
      return after
    }
    before = await ensureOpen(fixtureA)
  }
  record(name, false, `selection stayed ${before.selectedIndex}`, await capture(slug, name))
  return null
}

async function input(...args) {
  await command(inputHelper, args.map(String), { timeout: 15000 })
}

async function moveCursor(x, y) {
  await command("hyprctl", ["dispatch", `hl.dsp.cursor.move({ x = ${Math.round(x)}, y = ${Math.round(y)} })`])
  await input("move", 1, 0, 1, 12)
}

async function clickRect(rect) {
  await moveCursor(rect.centerX, rect.centerY)
  await input("click")
}

async function doubleClickRect(rect) {
  await moveCursor(rect.centerX, rect.centerY)
  await input("double-click")
}

async function dragRects(fromRect, toRect, duration = 480) {
  const desiredX = toRect.centerX - fromRect.centerX
  const desiredY = toRect.centerY - fromRect.centerY
  await moveCursor(fromRect.centerX, fromRect.centerY)
  const start = await jsonCommand("hyprctl", ["-j", "cursorpos"])
  await input("move", Math.round(desiredX), Math.round(desiredY), 30, duration)
  const measured = await jsonCommand("hyprctl", ["-j", "cursorpos"])
  const actualX = measured.x - start.x
  const actualY = measured.y - start.y
  const denominator = desiredX * desiredX + desiredY * desiredY
  const scale = denominator > 0
    ? (actualX * desiredX + actualY * desiredY) / denominator : 1
  const correction = Number.isFinite(scale) && scale > 0.1 ? scale : 1

  await moveCursor(fromRect.centerX, fromRect.centerY)
  await input("drag", Math.round(desiredX / correction),
    Math.round(desiredY / correction), 30, duration)
}

async function synchronizedSpaceState() {
  const normalize = values => [...new Set(values.map(Number))]
    .filter(Number.isInteger).sort((a, b) => a - b)
  const managed = normalize(await managedIds())
  const mission = normalize((await status()).workspaceIds)
  const bar = normalize((await barGeometry()).spaces.map(space => space.id))
  return {
    managed,
    mission,
    bar,
    synchronized: JSON.stringify(managed) === JSON.stringify(mission)
      && JSON.stringify(managed) === JSON.stringify(bar)
  }
}

async function hyprClients() {
  return await jsonCommand("hyprctl", ["-j", "clients"])
}

async function fixtureClients() {
  const clients = await hyprClients()
  return clients.filter(client => String(client.class || "").startsWith("omission-visual-"))
}

async function clientByAddress(address) {
  const wanted = normalizeAddress(address)
  return (await hyprClients()).find(client => normalizeAddress(client.address) === wanted) || null
}

async function focusWorkspace(workspaceId) {
  await command("hyprctl", ["dispatch", `hl.dsp.focus({ workspace = "${workspaceId}" })`])
  await waitFor(async () => (await jsonCommand("hyprctl", ["-j", "activeworkspace"])).id === workspaceId)
}

async function moveWindow(address, workspaceId) {
  const normalized = String(address).startsWith("0x") ? address : `0x${address}`
  await command("hyprctl", ["eval",
    `hl.dispatch(hl.dsp.window.move({ window = "address:${normalized}", workspace = "${workspaceId}", follow = false }))`])
  await waitFor(async () => (await clientByAddress(normalized))?.workspace?.id === workspaceId)
}

async function managedIds() {
  const { stdout } = await shellCommand([
    "io.github.nobledoodle.omission-state", "get"
  ])
  const parsed = JSON.parse(stdout)
  return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : []
}

async function setManagedIds(ids) {
  const normalized = [...new Set(ids.map(Number).filter(Number.isInteger))]
    .filter(id => id > 0 && id <= 10).sort((a, b) => a - b)
  const { stdout } = await shellCommand([
    "io.github.nobledoodle.omission-state", "set", normalized.join(":")
  ])
  if (stdout.trim() === "invalid") throw new Error("workspace state service rejected IDs")
  await waitFor(async () =>
    JSON.stringify(await managedIds()) === JSON.stringify(normalized))
}

async function spaceNames() {
  const { stdout } = await shellCommand([
    "io.github.nobledoodle.omission-state", "names"
  ])
  const parsed = JSON.parse(stdout)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : ({})
}

async function renameSpace(workspaceId, name) {
  if (name)
    await shellCommand([
      "io.github.nobledoodle.omission-state", "rename", String(workspaceId), String(name)
    ])
  else
    await shellCommand([
      "io.github.nobledoodle.omission-state", "clearName", String(workspaceId)
    ])
  await waitFor(async () => {
    const names = await spaceNames()
    return name ? names[String(workspaceId)] === name
      : !Object.prototype.hasOwnProperty.call(names, String(workspaceId))
  })
}
async function restoreSpaceNames(names) {
  await shellCommand(["io.github.nobledoodle.omission-state", "clearNames"])
  for (const [workspaceId, name] of Object.entries(names || {}))
    await renameSpace(workspaceId, name)
}

async function launchFixtures(count) {
  await focusWorkspace(fixtureA)
  for (let index = 0; index < count; index += 1) {
    const appId = `omission-visual-${process.pid}-${index}`
    const title = `Omission Visual Fixture ${index}`
    const child = spawn("foot", [
      `--app-id=${appId}`,
      `--title=${title}`,
      "sh", "-lc",
      `printf '\\033[2J\\033[H${title}\\n\\nFixture window ${index}\\n'; exec sleep 600`
    ], { stdio: "ignore", env: process.env, detached: true })
    fixtures.push(child)
  }
  const clients = await waitFor(async () => {
    const value = await fixtureClients()
    return value.length >= count ? value : null
  }, 12000, 150)
  clients.sort((left, right) => String(left.class).localeCompare(String(right.class)))
  return clients
}

async function writeReports() {
  const report = {
    generatedAt: new Date().toISOString(),
    plugin: "io.github.nobledoodle.omission",
    display: process.env.HYPRLAND_INSTANCE_SIGNATURE || "",
    summary: {
      pass: results.filter(result => result.status === "pass").length,
      fail: results.filter(result => result.status === "fail").length,
      skip: results.filter(result => result.status === "skip").length
    },
    results
  }
  await writeFile(`${outputDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`)

  const cards = results.map(result => `
    <article class="${html(result.status)}">
      <h2>${html(result.status.toUpperCase())}: ${html(result.name)}</h2>
      <p>${html(result.details)}</p>
      ${result.image ? `<a href="${html(result.image)}"><img src="${html(result.image)}" alt="${html(result.name)}"></a>` : ""}
    </article>`).join("\n")
  await writeFile(`${outputDir}/index.html`, `<!doctype html>
<meta charset="utf-8"><title>Omission visual interaction report</title>
<style>body{font:15px system-ui;background:#111;color:#eee;margin:24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px}article{border:1px solid #555;border-radius:10px;padding:12px;background:#1b1b1b}.fail{border-color:#d44}.skip{border-color:#ca3}img{width:100%;height:auto;border-radius:6px}h1,h2{margin:.2em 0}</style>
<h1>Omission visual interaction report</h1><p>${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.skip} skipped.</p><main>${cards}</main>\n`)

  if (screenshots.length > 0) {
    const files = screenshots.map(screenshot => `${outputDir}/${screenshot.filename}`)
    await command("magick", ["montage", ...files, "-thumbnail", "960x270", "-tile", "2x", "-geometry", "+12+12", `${outputDir}/contact-sheet.png`], { timeout: 120000 })
  }
}

function signalFixture(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try { process.kill(-child.pid, signal) }
  catch {
    try { child.kill(signal) } catch { }
  }
}

async function cleanup() {
  if (!sessionStarted) return
  await shellCommand(["shell", "hide", "io.github.nobledoodle.omission"], { allowFailure: true })
  for (const child of fixtures) signalFixture(child, "SIGTERM")
  await sleep(250)
  for (const child of fixtures) signalFixture(child, "SIGKILL")
  if (stateBackedUp) {
    let originalIds = []
    try {
      const parsed = JSON.parse(originalState.toString("utf8"))
      if (Array.isArray(parsed)) originalIds = parsed
    } catch { }
    await setManagedIds(originalIds)
    if (!stateExisted) await unlink(statePath).catch(() => {})
  }
  await restoreSpaceNames(originalNames)
  if (desktopBackedUp) {
    await command("hyprctl", ["dispatch", `hl.dsp.focus({ workspace = "${originalWorkspace}" })`], { allowFailure: true })
    await command("hyprctl", ["dispatch", `hl.dsp.cursor.move({ x = ${originalCursor.x}, y = ${originalCursor.y} })`], { allowFailure: true })
  }
  await sleep(300)
}

async function main() {
  const required = ["omarchy-shell", "hyprctl", "grim", "magick", "foot", "jq"]
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) throw new Error("visual tests require an active Hyprland session")
  if (process.env.OMISSION_VISUAL_ALLOW_ACTIVE_SESSION !== "1")
    throw new Error("visual tests control the active desktop; rerun with OMISSION_VISUAL_ALLOW_ACTIVE_SESSION=1")
  for (const binary of required) await command("which", [binary])
  await access(inputHelper, fsConstants.X_OK)
  await access("/dev/uinput", fsConstants.W_OK)
  await shellCommand(["shell", "ping"])
  const preparedOutput = await prepareVisualOutput(root, requestedOutput)
  outputDir = preparedOutput.outputDir

  try {
    originalState = await readFile(statePath)
    stateExisted = true
  } catch {
    originalState = Buffer.from("[]\n")
    stateExisted = false
  }
  stateBackedUp = true
  originalNames = await spaceNames()
  originalWorkspace = (await jsonCommand("hyprctl", ["-j", "activeworkspace"])).id
  originalCursor = await jsonCommand("hyprctl", ["-j", "cursorpos"])
  desktopBackedUp = true
  sessionStarted = true

  const used = new Set([...(await managedIds()), ...(await jsonCommand("hyprctl", ["-j", "workspaces"])).map(workspace => workspace.id)])
  let adjacent = null
  for (let lower = 8; lower >= 4; lower -= 1) {
    if (!used.has(lower) && !used.has(lower + 1)) {
      adjacent = [lower + 1, lower]
      break
    }
  }
  if (!adjacent) throw new Error("visual tests need two adjacent free workspace IDs from 4-9")
  ;[fixtureA, fixtureB] = adjacent

  const clients = await launchFixtures(7)
  await moveWindow(clients[6].address, fixtureB)
  await focusWorkspace(fixtureA)

  // Open/toggle/hotkey/gesture.
  await ensureClosed()
  const hotkeyOpen = await injectUntilOpen(["chord", "ctrl", "up"])
  record("Global Control+Up opens Omission", !!hotkeyOpen,
    hotkeyOpen ? `workspace ${hotkeyOpen.workspace}` : "hotkey did not open after 3 attempts",
    hotkeyOpen ? await capture("hotkey-open", "Control+Up opens Omission") : null)
  if (!hotkeyOpen) throw new Error("Control+Up failed to open Omission")

  await input("chord", "ctrl", "down")
  const closingState = await waitFor(async () => {
    const value = await status()
    return value.closing ? value : null
  }, 1000).catch(() => null)
  const hotkeyClosed = await waitFor(async () => !(await status()).open)
  const closeImage = await capture("hotkey-close", "Control+Down closes Omission")
  record("Control+Down starts the exit animation", !!closingState,
    closingState ? `progress ${closingState.revealProgress}` : "closing state not observed", closeImage)
  record("Global Control+Down closes Omission", hotkeyClosed,
    "closed", closeImage)

  await ensureOpen(fixtureA)
  await input("chord", "ctrl", "down")
  await sleep(50)
  await input("chord", "ctrl", "up")
  const interruptedClose = await waitFor(async () => {
    const value = await status()
    return value.open && !value.closing && value.revealProgress > 0.9 ? value : null
  })
  record("Control+Up reverses an in-flight close animation", !!interruptedClose,
    `progress ${interruptedClose.revealProgress}`,
    await capture("close-interrupted", "Close animation interrupted by Control+Up"))

  await ensureClosed()
  const gestureProbe = await command(inputHelper, ["swipe-up"], { allowFailure: true, timeout: 15000 })
  if (gestureProbe.error) {
    record("Three-finger upward gesture opens Omission", true,
      `virtual touchpad unavailable; manual confirmation required: ${(gestureProbe.stderr || gestureProbe.error.message).trim()}`, null, "skip")
  } else {
    let gestureOpen = await waitFor(async () => (await status()).open ? await status() : null, 3000)
      .catch(() => null)
    if (!gestureOpen) gestureOpen = await injectUntilOpen(["swipe-up"], 2)
    record("Three-finger upward gesture opens Omission", !!gestureOpen,
      gestureOpen ? "virtual touchpad event accepted" : "gesture did not open after retries",
      gestureOpen ? await capture("gesture-open", "Three-finger gesture") : null)
    if (!gestureOpen) throw new Error("three-finger swipe-up failed to open Omission")
  }

  await ensureClosed()
  await shellCommand(["shell", "toggle", "io.github.nobledoodle.omission", "{}"])
  await waitFor(async () => (await status()).open)
  await shellCommand(["shell", "toggle", "io.github.nobledoodle.omission", "{}"])
  record("IPC toggle opens and closes", await waitFor(async () => !(await status()).open),
    "two toggles restore closed state", await capture("ipc-toggle-close", "IPC toggle closes"))

  // Keyboard matrix.
  await focusWorkspace(fixtureA)
  await selectionInteraction("Vim L selects right", ["key", "l"], "vim-l")
  await selectionInteraction("Vim H selects left", ["key", "h"], "vim-h")
  await selectionInteraction("Vim J selects down", ["key", "j"], "vim-j")
  await selectionInteraction("Vim K selects up", ["key", "k"], "vim-k")
  for (const [key, label] of [
    ["right", "Right arrow"],
    ["left", "Left arrow"],
    ["down", "Down arrow"],
    ["up", "Up arrow"],
    ["tab", "Tab"]
  ]) {
    await selectionInteraction(`${label} changes selection`, ["key", key], `key-${key}`)
  }
  await selectionInteraction("Shift+Tab changes selection in reverse",
    ["chord", "shift", "tab"], "shift-tab")

  await input("key", "q")
  record("Q closes Omission", await waitFor(async () => !(await status()).open), "closed", await capture("vim-q-close", "Q closes"))
  await ensureOpen()
  await input("key", "escape")
  record("Escape closes Omission", await waitFor(async () => !(await status()).open),
    "closed", await capture("escape-close", "Escape closes"))

  // Number preview and Shift+number move.
  await focusWorkspace(fixtureA)
  await ensureOpen(fixtureA)
  await input("key", String(fixtureB))
  let previewed = await waitFor(async () => (await status()).workspace === fixtureB, 1500)
    .catch(() => false)
  if (!previewed) {
    await ensureOpen(fixtureA)
    await input("key", String(fixtureB))
    previewed = await waitFor(async () => (await status()).workspace === fixtureB, 3000)
      .catch(() => false)
  }
  record("Number key previews a space", !!previewed, `previewed ${fixtureB}`,
    await capture("number-preview", "Number previews space"))
  if (!previewed) throw new Error(`number key did not preview fixture space ${fixtureB}`)
  await input("key", String(fixtureA))
  await waitFor(async () => (await status()).workspace === fixtureA)
  const selectedBeforeMove = await status()
  const movedAddress = selectedBeforeMove.selectedAddress
  await input("chord", "shift", String(fixtureB))
  const moved = await waitFor(async () => (await clientByAddress(movedAddress))?.workspace?.id === fixtureB)
  const activeAfterMove = (await jsonCommand("hyprctl", ["-j", "activeworkspace"])).id
  record("Shift+number moves selected window silently", !!moved && activeAfterMove === fixtureA,
    `${movedAddress} -> ${fixtureB}, focus stayed ${activeAfterMove}`, await capture("shift-number-move", "Shift+number moves window"))
  await moveWindow(movedAddress, fixtureA)

  await focusWorkspace(fixtureB)
  await ensureOpen(fixtureB)
  await input("chord", "ctrl", "right")
  const controlRightPreview = await waitFor(async () => {
    const s = await status()
    return s.open && s.workspace === fixtureA ? s : null
  })
  const activeAfterCtrlRight = (await jsonCommand("hyprctl", ["-j", "activeworkspace"])).id
  record("Control+Right previews next space without closing", !!controlRightPreview && activeAfterCtrlRight === fixtureB,
    `previewed ${fixtureA}, active ${activeAfterCtrlRight}, open ${!!controlRightPreview?.open}`,
    await capture("control-right-preview", "Control+Right previews next space"))

  await input("chord", "ctrl", "left")
  const controlLeftPreview = await waitFor(async () => {
    const s = await status()
    return s.open && s.workspace === fixtureB ? s : null
  })
  const activeAfterCtrlLeft = (await jsonCommand("hyprctl", ["-j", "activeworkspace"])).id
  record("Control+Left previews previous space without closing", !!controlLeftPreview && activeAfterCtrlLeft === fixtureB,
    `previewed ${fixtureB}, active ${activeAfterCtrlLeft}, open ${!!controlLeftPreview?.open}`,
    await capture("control-left-preview", "Control+Left previews previous space"))

  const keyboardAddressA = (await fixtureClients())
    .find(client => client.workspace.id === fixtureA)?.address
  const keyboardAddressB = (await fixtureClients())
    .find(client => client.workspace.id === fixtureB)?.address
  await focusWorkspace(fixtureA)
  await ensureOpen(fixtureA)
  await input("chord", "shift", "left")
  const keyboardSwap = await waitFor(async () => {
    const movedA = keyboardAddressA ? await clientByAddress(keyboardAddressA) : null
    const movedB = keyboardAddressB ? await clientByAddress(keyboardAddressB) : null
    return movedA?.workspace?.id === fixtureB && movedB?.workspace?.id === fixtureA
  })
  record("Shift+Left reorders selected space", keyboardSwap,
    `A -> ${fixtureB}, B -> ${fixtureA}`,
    await capture("shift-left-space-reorder", "Shift+Left space reorder"))
  await input("chord", "shift", "right")
  const keyboardRestore = await waitFor(async () => {
    const movedA = keyboardAddressA ? await clientByAddress(keyboardAddressA) : null
    const movedB = keyboardAddressB ? await clientByAddress(keyboardAddressB) : null
    return movedA?.workspace?.id === fixtureA && movedB?.workspace?.id === fixtureB
  })
  record("Shift+Right restores selected space position", keyboardRestore,
    `A -> ${fixtureA}, B -> ${fixtureB}`,
    await capture("shift-right-space-restore", "Shift+Right space restore"))

  // Pointer geometry and background close.
  await ensureOpen()
  let geo = await geometry()
  const geometryImage = await capture("interaction-geometry", "Interaction geometry")
  record("Interaction geometry exposes spaces and windows",
    geo.spaces.length >= 2 && geo.windows.length >= 5,
    `${geo.spaces.length} spaces, ${geo.windows.length} windows`, geometryImage)
  const initialSync = await synchronizedSpaceState()
  record("Omission and bar start with identical space IDs",
    initialSync.synchronized, JSON.stringify(initialSync), geometryImage)
  await moveCursor(geo.backgroundPoint.x, geo.backgroundPoint.y)
  await input("click")
  record("Background click closes Omission",
    await waitFor(async () => !(await status()).open), "closed",
    await capture("background-close", "Background click closes"))

  // Space click/double click.
  await focusWorkspace(fixtureA)
  await ensureOpen()
  geo = await geometry()
  const targetSpace = geo.spaces.find(space => space.id === fixtureB)
  await clickRect(targetSpace.rect)
  record("Space click previews destination", await waitFor(async () => (await status()).workspace === fixtureB), `previewed ${fixtureB}`, await capture("space-click", "Space click"))
  geo = await geometry()
  const originSpace = geo.spaces.find(space => space.id === fixtureA)
  await doubleClickRect(originSpace.rect)
  const doubleClosed = await waitFor(async () => !(await status()).open)
  const doubleWorkspace = (await jsonCommand("hyprctl", ["-j", "activeworkspace"])).id
  record("Space double-click switches and closes", doubleClosed && doubleWorkspace === fixtureA,
    `active ${doubleWorkspace}`, await capture("space-double-click", "Space double-click"))

  const barGeo = await barGeometry()
  const barTarget = barGeo.spaces.find(space => space.id === fixtureB)
  const barOrigin = barGeo.spaces.find(space => space.id === fixtureA)
  await clickRect(barTarget.rect)
  const barFocused = await waitFor(async () =>
    (await jsonCommand("hyprctl", ["-j", "activeworkspace"])).id === fixtureB)
  record("Dynamic bar click focuses space", barFocused, `active ${fixtureB}`,
    await capture("bar-click", "Dynamic bar workspace click"))
  await clickRect(barOrigin.rect)
  await waitFor(async () =>
    (await jsonCommand("hyprctl", ["-j", "activeworkspace"])).id === fixtureA)


  await ensureOpen(fixtureA)
  geo = await geometry()
  let renameSpaceGeometry = geo.spaces.find(space => space.id === fixtureA)
  await moveCursor(renameSpaceGeometry.rect.centerX, renameSpaceGeometry.rect.centerY)
  await sleep(120)
  geo = await geometry()
  renameSpaceGeometry = geo.spaces.find(space => space.id === fixtureA)
  await clickRect(renameSpaceGeometry.renameRect)
  for (const key of ["h", "j", "k", "l", "1"]) await input("key", key)
  await input("key", "enter")
  const renamed = await waitFor(async () =>
    (await spaceNames())[String(fixtureA)] === "hjkl1")
  geo = await geometry()
  const missionNamed = geo.spaces.find(space => space.id === fixtureA)?.name
  const barNamed = (await barGeometry()).spaces.find(space => space.id === fixtureA)?.name
  const renameImage = await capture("space-rename", "Rename space")
  record("Inline editor names a space", renamed && missionNamed === "hjkl1",
    `Omission: ${missionNamed}`, renameImage)
  record("Named space synchronizes to Omarchy bar", barNamed === "hjkl1",
    `bar: ${barNamed}`, renameImage)
  await renameSpace(fixtureA, "")
  // Add and remove controls, including bar state.
  await ensureOpen()
  geo = await geometry()
  const idsBeforeAdd = await managedIds()
  await clickRect(geo.addRect)
  const idsAfterAdd = await waitFor(async () => {
    const ids = await managedIds()
    return ids.length === idsBeforeAdd.length + 1 ? ids : null
  })
  const addedId = idsAfterAdd.find(id => !idsBeforeAdd.includes(id))
  const addImage = await capture("space-add", "Add space")
  record("Add button creates managed space", Number.isInteger(addedId), `added ${addedId}`, addImage)
  const shellLayout = await jsonCommand("jq", ["-c", ".bar.layout.left | map(.id)", `${process.env.HOME}/.config/omarchy/shell.json`])
    .catch(() => [])
  record("Dynamic bar widget reflects managed spaces",
    Array.isArray(shellLayout) && shellLayout.includes("io.github.nobledoodle.omission"),
    `${JSON.stringify(shellLayout)}; managed ${JSON.stringify(idsAfterAdd)}`, addImage)
  const addSync = await synchronizedSpaceState()
  record("Created space synchronizes to every switcher",
    addSync.synchronized && addSync.managed.includes(addedId),
    JSON.stringify(addSync), addImage)

  await shellCommand(["shell", "summon", "io.github.nobledoodle.omission", JSON.stringify({ workspace: addedId })])
  await sleep(250)
  geo = await geometry()
  const addedSpace = geo.spaces.find(space => space.id === addedId)
  await moveCursor(addedSpace.rect.centerX, addedSpace.rect.centerY)
  await sleep(120)
  geo = await geometry()
  const hoveredAdded = geo.spaces.find(space => space.id === addedId)
  await clickRect(hoveredAdded.removeRect)
  const removed = await waitFor(async () => !(await managedIds()).includes(addedId))
  const removeImage = await capture("space-remove", "Remove space")
  record("Remove button deletes managed space", removed, `removed ${addedId}`, removeImage)
  record("Dynamic bar reflects space removal", removed,
    `managed ${JSON.stringify(await managedIds())}`, removeImage)
  const removeSync = await synchronizedSpaceState()
  record("Removed space disappears from every switcher",
    removeSync.synchronized && !removeSync.managed.includes(addedId),
    JSON.stringify(removeSync), removeImage)

  // Window hover, invalid drag, valid animated drag.
  await focusWorkspace(fixtureA)
  await ensureOpen()
  geo = await geometry()
  const fixtureAddresses = new Set((await fixtureClients()).filter(client => client.workspace.id === fixtureA).map(client => normalizeAddress(client.address)))
  let fixtureWindow = geo.windows.find(windowItem => fixtureAddresses.has(normalizeAddress(windowItem.address)))
  await moveCursor(fixtureWindow.rect.centerX - 2, fixtureWindow.rect.centerY)
  await input("move", 4, 0, 2, 30)
  record("Window hover selects card",
    await waitFor(async () => (await status()).selectedIndex === fixtureWindow.index),
    `selected ${fixtureWindow.index}`, await capture("window-hover", "Window hover"))

  const invalidBefore = (await clientByAddress(fixtureWindow.address)).workspace.id
  await dragRects(fixtureWindow.rect, { centerX: geo.backgroundPoint.x, centerY: geo.backgroundPoint.y })
  await sleep(350)
  record("Invalid window drag cancels move", (await clientByAddress(fixtureWindow.address)).workspace.id === invalidBefore,
    `remained ${invalidBefore}`, await capture("window-drag-cancel", "Invalid window drag"))

  await ensureOpen()
  geo = await geometry()
  fixtureWindow = geo.windows.find(windowItem => normalizeAddress(windowItem.address) === normalizeAddress(fixtureWindow.address))
  const destinationSpace = geo.spaces.find(space => space.id === fixtureB)
  await dragRects(fixtureWindow.rect, destinationSpace.rect)
  const dragAnimationImage = await capture("window-drop-animation", "Window drop animation")
  const validMoved = await waitFor(async () => (await clientByAddress(fixtureWindow.address))?.workspace?.id === fixtureB)
  const activeAfterDrag = (await jsonCommand("hyprctl", ["-j", "activeworkspace"])).id
  record("Window drag animates and moves to space", !!validMoved && activeAfterDrag === fixtureA,
    `${fixtureWindow.address} -> ${fixtureB}, focus stayed ${activeAfterDrag}`, dragAnimationImage)
  await moveWindow(fixtureWindow.address, fixtureA)

  // Space drag swap and restore.
  await ensureOpen()
  geo = await geometry()
  const spaceA = geo.spaces.find(space => space.id === fixtureA)
  const spaceB = geo.spaces.find(space => space.id === fixtureB)
  const addressA = (await fixtureClients()).find(client => client.workspace.id === fixtureA)?.address
  const addressB = (await fixtureClients()).find(client => client.workspace.id === fixtureB)?.address
  await dragRects(spaceB.rect, spaceA.rect)
  await sleep(600)
  const swappedA = addressA ? (await clientByAddress(addressA))?.workspace?.id : -1
  const swappedB = addressB ? (await clientByAddress(addressB))?.workspace?.id : -1
  const reorderImage = await capture("space-reorder", "Space reorder")
  record("Space drag swaps positions and renumbers",
    swappedA === fixtureB && swappedB === fixtureA,
    `A ${swappedA}, B ${swappedB}`, reorderImage)
  const reorderGeometry = await geometry()
  const renderedA = reorderGeometry.spaces.find(space => space.id === fixtureA)
  const renderedB = reorderGeometry.spaces.find(space => space.id === fixtureB)
  record("Reordered desktop thumbnails keep rendering windows",
    renderedA?.renderedWindowCount > 0 && renderedB?.renderedWindowCount > 0,
    `A ${renderedA?.renderedWindowCount || 0}/${renderedA?.windowCount || 0}, `
      + `B ${renderedB?.renderedWindowCount || 0}/${renderedB?.windowCount || 0}`,
    reorderImage)
  const reorderSync = await synchronizedSpaceState()
  record("Reordered space IDs stay synchronized everywhere",
    reorderSync.synchronized, JSON.stringify(reorderSync),
    await capture("space-reorder-sync", "Space reorder synchronization"))
  await ensureOpen()
  geo = await geometry()
  await dragRects(geo.spaces.find(space => space.id === fixtureB).rect,
    geo.spaces.find(space => space.id === fixtureA).rect)
  await sleep(600)
  const restoredA = addressA ? (await clientByAddress(addressA))?.workspace?.id : -1
  const restoredB = addressB ? (await clientByAddress(addressB))?.workspace?.id : -1
  record("Reverse space drag restores positions", restoredA === fixtureA && restoredB === fixtureB,
    `A ${restoredA}, B ${restoredB}`, await capture("space-reorder-restore", "Space reorder restored"))

  // Mouse click activation and fixture-only close button.
  await focusWorkspace(fixtureA)
  await ensureOpen()
  geo = await geometry()
  fixtureWindow = geo.windows.find(windowItem => fixtureAddresses.has(normalizeAddress(windowItem.address)))
  await clickRect(fixtureWindow.rect)
  const clickClosed = await waitFor(async () => !(await status()).open)
  const activeWindow = await jsonCommand("hyprctl", ["-j", "activewindow"])
  record("Window click activates and closes", clickClosed && normalizeAddress(activeWindow.address) === normalizeAddress(fixtureWindow.address),
    activeWindow.address, await capture("window-click", "Window click activation"))

  await ensureOpen()
  geo = await geometry()
  fixtureWindow = geo.windows.find(windowItem => fixtureAddresses.has(normalizeAddress(windowItem.address)))
  await moveCursor(fixtureWindow.rect.centerX, fixtureWindow.rect.centerY)
  await sleep(120)
  geo = await geometry()
  fixtureWindow = geo.windows.find(windowItem => normalizeAddress(windowItem.address) === normalizeAddress(fixtureWindow.address))
  await clickRect(fixtureWindow.closeRect)
  record("Window close control closes fixture only", await waitFor(async () => !(await clientByAddress(fixtureWindow.address))),
    fixtureWindow.address, await capture("window-close", "Fixture window close"))

  // Enter activation is last because it closes the overlay.
  await focusWorkspace(fixtureA)
  await ensureOpen()
  const enterStatus = await status()
  await input("key", "enter")
  const enterClosed = await waitFor(async () => !(await status()).open)
  const enterActive = await jsonCommand("hyprctl", ["-j", "activewindow"])
  record("Enter activates selected window", enterClosed && normalizeAddress(enterActive.address) === normalizeAddress(enterStatus.selectedAddress),
    enterActive.address, await capture("enter-activate", "Enter activates"))

  await ensureClosed()
}

let fatal = null
try {
  await main()
} catch (error) {
  fatal = error
  record("Visual runner completed", false, error.stack || error.message)
} finally {
  if (sessionStarted) {
    try {
      await cleanup()
      record("Cleanup restored desktop", true, "managed spaces, active workspace, cursor, and fixtures restored")
    } catch (error) {
      record("Cleanup restored desktop", false, error.message)
    }
  }
  await writeReports().catch(error => {
    process.stderr.write(`failed to write visual report: ${error.stack || error.message}\n`)
    if (!fatal) fatal = error
  })
}

const failures = results.filter(result => result.status === "fail")
process.stdout.write(`Evidence: ${outputDir}/index.html\n`)
if (fatal || failures.length > 0) process.exitCode = 1
