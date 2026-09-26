import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"

const qml = readFileSync(new URL("../WindowSwitcher.qml", import.meta.url), "utf8")
const overviewQml = readFileSync(new URL("../Overview.qml", import.meta.url), "utf8")
const switcherSource = readFileSync(new URL("../SwitcherModel.js", import.meta.url), "utf8")
  .replace(/^\.pragma library\s*/m, "")
const switcherModel = {}
vm.createContext(switcherModel)
vm.runInContext(switcherSource, switcherModel, { filename: "SwitcherModel.js" })

test("client-derived labels are always rendered as plain text", () => {
  const plainTextBindings = qml.match(/textFormat:\s*Text\.PlainText/g) || []
  assert.ok(plainTextBindings.length >= 5, "expected every dynamic label and error label to be PlainText")
  assert.match(qml,
    /text:\s*root\.clients\.length === 1[\s\S]{0,120}?appName[\s\S]{0,120}?textFormat:\s*Text\.PlainText/)
  assert.match(qml,
    /text:\s*root\.clients\.length === 1[\s\S]{0,120}?displayTitle[\s\S]{0,120}?textFormat:\s*Text\.PlainText/)
  assert.match(qml,
    /text:\s*String\(windowCard\.modelData\.appName[\s\S]{0,120}?textFormat:\s*Text\.PlainText/)
  assert.match(qml,
    /text:\s*String\(windowCard\.modelData\.displayTitle[\s\S]{0,120}?textFormat:\s*Text\.PlainText/)
  assert.doesNotMatch(qml, /textFormat:\s*Text\.(?:AutoText|RichText|StyledText|MarkdownText)/)
})

test("Omission renders workspace and client labels as plain text", () => {
  assert.match(overviewQml,
    /text:\s*workspaceChip\.displayName\s*\n\s*textFormat:\s*Text\.PlainText/)
  assert.match(overviewQml,
    /text:\s*String\(windowCell\.modelData\.appName[\s\S]{0,100}?textFormat:\s*Text\.PlainText/)
  assert.match(overviewQml,
    /text:\s*WindowModel\.shortenedTitle\(String\([\s\S]{0,160}?windowCell\.modelData\.title[\s\S]{0,40}?textFormat:\s*Text\.PlainText/)
})

test("window discovery uses the bounded native Hyprland model", () => {
  assert.match(qml, /SwitcherModel\.switchableClients\(Hyprland\.toplevels/)
  assert.match(qml, /SwitcherModel\.MAX_CLIENTS/)
  assert.doesNotMatch(qml, /hyprctl["']?\s*,\s*["']-j["']\s*,\s*["']clients/)
  assert.doesNotMatch(qml, /StdioCollector/)
})

test("commit revalidates and focuses stable identity", () => {
  assert.match(qml, /findSwitchableByStableId\(Hyprland\.toplevels/)
  assert.match(qml, /window = "stableid:/)
  assert.doesNotMatch(qml, /window = "address:/)
})

test("class fallback icons pass through the strict model sanitizer", () => {
  assert.match(qml, /SwitcherModel\.safeIconName\(fallbackClass\)/)
})

test("single and multi cards expose accessible button actions", () => {
  assert.equal((qml.match(/Accessible\.role:\s*Accessible\.Button/g) || []).length, 2)
  assert.equal((qml.match(/Accessible\.onPressAction/g) || []).length, 2)
})

test("Omission client-metadata fallback icons are sanitized before resolution", () => {
  assert.match(overviewQml,
    /var iconName = entry \? String\(entry\.icon \|\| ""\)\s*\n\s*: SwitcherModel\.safeIconName\(metadata\.initialClass \|\| metadata\.class\)/)
  assert.match(overviewQml, /root\.resolveIcon\(iconName\)/)
  assert.match(overviewQml, /Quickshell\.iconPath\(name, true\)/)
  assert.doesNotMatch(overviewQml,
    /(?:iconSource|iconPath)\(String\(metadata\.(?:initialClass|class)/)
  assert.doesNotMatch(overviewQml, /safeIconName\(entry\.icon/)

  const fallbackFor = metadata =>
    switcherModel.safeIconName(metadata.initialClass || metadata.class)
  assert.equal(fallbackFor({ initialClass: "file:///tmp/bomb.svg" }),
    "application-x-executable")
  assert.equal(fallbackFor({ initialClass: "/tmp/bomb.svg" }),
    "application-x-executable")
  assert.equal(fallbackFor({ initialClass: "https://example.test/icon" }),
    "application-x-executable")
  assert.equal(fallbackFor({ initialClass: "image://provider/payload" }),
    "application-x-executable")
  assert.equal(fallbackFor({ initialClass: "", class: "org.example.Chromium" }),
    "org.example.Chromium")
  assert.equal(fallbackFor({}), "application-x-executable")
})

test("every launched command resolves through a pinned, root-owned PATH", () => {
  for (const file of ["Service.qml", "AltTabService.qml", "Overview.qml", "WindowSwitcher.qml"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    assert.match(source, /readonly property string trustedPath: "\/usr\/local\/bin:\/usr\/bin:\/bin"/, file)
    // The object itself, not an expression continued onto the next line.
    assert.match(source, /readonly property var trustedEnvironment: \(\{ PATH: root\.trustedPath \}\)\n(?!\s*\+)/, file)
    const processes = source.match(/\n  Process \{[\s\S]*?\n  \}/g) || []
    for (const block of processes)
      assert.match(block, /environment: root\.trustedEnvironment/, `${file}: ${block.slice(0, 60)}`)
    assert.doesNotMatch(source, /execDetached\(\[/, `${file} launches without a pinned PATH`)
    const detached = source.match(/execDetached\(\{[\s\S]*?\n\s*\}\)/g) || []
    for (const call of detached)
      assert.match(call, /environment: root\.trustedEnvironment/, file)
  }
})

test("the bar focuses spaces in process, from a bounded workspace number", () => {
  const bar = readFileSync(new URL("../BarWidget.qml", import.meta.url), "utf8")
  assert.doesNotMatch(bar, /bar\.run\(/)
  assert.match(bar, /var workspace = Math\.floor\(Number\(id\)\)\s*\n\s*if \(!\(workspace > 0 && workspace <= 10\)\) return\s*\n\s*Hyprland\.dispatch\('hl\.dsp\.focus\(\{ workspace = "' \+ workspace \+ '" \}\)'\)/)
})

test("only a hex window address is spliced into workspace Lua", () => {
  assert.match(overviewQml, /if \(!\/\^\[0-9A-Fa-f\]\{1,16\}\$\/\.test\(address\)\) address = ""/)
})
