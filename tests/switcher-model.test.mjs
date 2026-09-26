import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"

const source = readFileSync(new URL("../SwitcherModel.js", import.meta.url), "utf8")
  .replace(/^\.pragma library\s*/m, "")
const model = {}
vm.createContext(model)
vm.runInContext(source, model, { filename: "SwitcherModel.js" })

test("filters to switchable windows on one monitor and orders them by MRU", () => {
  const clients = [
    { address: "0x3", monitor: 1, mapped: true, acceptsInput: true, focusHistoryID: 3 },
    { address: "0x1", monitor: 1, mapped: true, acceptsInput: true, focusHistoryID: 0 },
    { address: "0x2", monitor: 2, mapped: true, acceptsInput: true, focusHistoryID: 1 },
    { address: "0x4", monitor: 1, mapped: false, acceptsInput: true, focusHistoryID: 2 },
    { address: "0x5", monitor: 1, mapped: true, acceptsInput: false, focusHistoryID: 1 },
    { address: "0x6", monitor: 1, mapped: true, acceptsInput: true, focusHistoryID: -1 }
  ]

  const result = model.switchableClients(clients, 1)
  assert.deepEqual(Array.from(result, client => client.address), ["0x1", "0x3", "0x6"])
})

test("excludes hidden clients from the current view", () => {
  const clients = [
    { address: "0x1", monitor: 1, workspace: { id: 2 }, mapped: true,
      hidden: true, acceptsInput: true, focusHistoryID: 0 },
    { address: "0x2", monitor: 1, workspace: { id: 2 }, mapped: true,
      hidden: false, acceptsInput: true, focusHistoryID: 1 }
  ]
  assert.deepEqual(
    Array.from(model.switchableClients(clients, 1, 2), client => client.address),
    ["0x2"])
})

test("restricts cycling to the active workspace on the focused monitor", () => {
  const clients = [
    { address: "0x1", monitor: 1, workspace: { id: 3 }, mapped: true, acceptsInput: true, focusHistoryID: 1 },
    { address: "0x2", monitor: 1, workspace: { id: 5 }, mapped: true, acceptsInput: true, focusHistoryID: 0 },
    { address: "0x3", monitor: 2, workspace: { id: 3 }, mapped: true, acceptsInput: true, focusHistoryID: 2 },
    { address: "0x4", monitor: 1, workspace: { id: -99 }, mapped: true, acceptsInput: true, focusHistoryID: 3 }
  ]

  const scoped = model.switchableClients(clients, 1, 3)
  assert.deepEqual(Array.from(scoped, client => client.address), ["0x1"])
  const special = model.switchableClients(clients, 1, -99)
  assert.deepEqual(Array.from(special, client => client.address), ["0x4"])
  const unscoped = model.switchableClients(clients, 1)
  assert.deepEqual(Array.from(unscoped, client => client.address), ["0x2", "0x1", "0x4"])
})

test("normalizes native toplevels and caps candidates", () => {
  const clients = Array.from({ length: 300 }, (_, index) => ({
    address: "0x" + (index + 1).toString(16),
    workspace: { id: 4 },
    monitor: { id: 7 },
    lastIpcObject: {
      address: "0x" + (index + 1).toString(16),
      stableId: String(index + 100),
      mapped: true,
      hidden: false,
      acceptsInput: true,
      focusHistoryID: index
    }
  }))
  const result = model.switchableClients({ values: clients }, 7, 4)
  assert.equal(result.length, 256)
  assert.equal(model.stableId(result[0]), "100")
  assert.equal(model.stableId(result[255]), "355")
  const qmlList = { 0: clients[0], length: 1 }
  assert.equal(model.switchableClients(qmlList, 7, 4).length, 1)
})

test("revalidates stable identity and current scope", () => {
  const client = {
    address: "0x1",
    workspace: { id: 3 },
    monitor: { id: 2 },
    lastIpcObject: {
      stableId: "42", mapped: true, hidden: false, acceptsInput: true
    }
  }
  assert.equal(model.findSwitchableByStableId([client], "42", 2, 3), client)
  assert.equal(model.findSwitchableByStableId([client], "42", 2, 4), null)
  assert.equal(model.findSwitchableByStableId([client], "0x2a", 2, 3), null)
})

test("restricts untrusted icon fallbacks to theme identifiers", () => {
  assert.equal(model.safeIconName("com.example.App-1"), "com.example.App-1")
  assert.equal(model.safeIconName("file:///tmp/bomb.svg"), "application-x-executable")
  assert.equal(model.safeIconName("image://provider/payload"), "application-x-executable")
  assert.equal(model.safeIconName("/tmp/bomb.svg"), "application-x-executable")
  assert.equal(model.safeIconName("https://example.test/icon"), "application-x-executable")
})

test("prefers class identity before title fallback", () => {
  const rows = [
    { entry: { id: "discord", name: "Discord", icon: "discord" } },
    { entry: { id: "com.mitchellh.ghostty", name: "Ghostty", icon: "ghostty" } },
    { entry: { id: "Zoom", name: "Zoom", icon: "zoom" } }
  ]
  assert.equal(
    model.desktopEntry(rows, "com.mitchellh.ghostty", "com.mitchellh.ghostty", "Discord").name,
    "Ghostty")
  assert.equal(model.desktopEntry(rows, "", "unknown-app", "Zoom").name, "Zoom")
})

test("starts on the next MRU window and wraps in both directions", () => {
  assert.equal(model.initialIndex(1, 4), 1)
  assert.equal(model.initialIndex(-1, 4), 3)
  assert.equal(model.initialIndex(1, 1), 0)
  assert.equal(model.initialIndex(1, 0), -1)
  assert.equal(model.nextIndex(3, 1, 4), 0)
  assert.equal(model.nextIndex(0, -1, 4), 3)
})

test("turns application classes into readable fallback labels", () => {
  assert.equal(model.classLabel("com.mitchellh.ghostty"), "Ghostty")
  assert.equal(model.classLabel("org.example.my_app"), "My App")
  assert.equal(model.classLabel(""), "Application")
})

test("normalizes titles without breaking short labels", () => {
  assert.equal(model.shortenedTitle("  A   useful title  ", 20), "A useful title")
  assert.equal(model.shortenedTitle("A very long window title", 10), "A very lo…")
})

test("truncates by Unicode code point", () => {
  assert.equal(model.shortenedTitle("😀😀😀", 2), "😀…")
})

test("matches desktop entries by StartupWMClass and executable name", () => {
  const rows = [
    { id: "userapp-Floorp-Z2YEW3", name: "Chat", startupClass: "chrome-chat.example-Default", icon: "chat" },
    { id: "org.example.Tool", name: "Tool", command: ["/usr/bin/tooltip"], icon: "tool" },
  ]
  assert.equal(model.desktopEntry(rows, "chrome-chat.example-Default", "", "").icon, "chat")
  assert.equal(model.desktopEntry(rows, "", "tooltip", "").icon, "tool")
  assert.equal(model.safeIconName("Foot"), "foot")
})
