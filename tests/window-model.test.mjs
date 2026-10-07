import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import Module from "node:module"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

// Compile the real WindowModel.js through Node's CommonJS compiler so V8
// attributes coverage to the plugin file itself. `.pragma library` is a QML
// directive; blank it out (keeping the line) so line numbers stay aligned.
const modelUrl = new URL("../WindowModel.js", import.meta.url)
const modelPath = fileURLToPath(modelUrl)
const exported = [
  "MAX_SELECTED_GRID_CAPTURES", "MAX_WORKSPACE_THUMBNAIL_CAPTURES",
  "numberOr", "valuesOf", "metadata", "workspaceId", "monitorId",
  "historyRank", "stableAddress", "isVisibleToplevel", "visibleToplevels",
  "desktopToplevels", "boundedFront", "boundedBackStack",
  "selectedGridCaptureModel", "workspaceThumbnailCaptureModel",
  "workspaceThumbnailRect", "workspaceIds", "gridColumns",
  "nextGridIndex", "nextFreeWorkspaceId", "moveArrayValue", "reassignPlan",
  "removalNeighbor", "remapWorkspaceIds", "normalizedSpaceName",
  "remapSpaceNames", "spaceCardIndexAt", "shortenedTitle",
  "spatialNeighborIndex", "BAR_STYLES", "normalizedSettings", "nextBarStyle", "hyprBorderGradient", "hyprGradientLine", "hyprOuterRadius", "superellipseRectPath", "hyprBorderPath"
]

const source = readFileSync(modelUrl, "utf8")
  .replace(/^\.pragma library\r?$/m, "")
  + `\nmodule.exports = { ${exported.join(", ")} }\n`

const compiled = new Module(modelPath, null)
compiled.filename = modelPath
compiled.paths = Module._nodeModulePaths(dirname(modelPath))
compiled._compile(source, modelPath)

const model = compiled.exports

function toplevel(address, workspace, monitor, focusHistoryID, overrides = {}) {
  return {
    address,
    wayland: {},
    workspace: { id: workspace },
    monitor: { id: monitor },
    lastIpcObject: {
      mapped: true,
      hidden: false,
      acceptsInput: true,
      focusHistoryID,
      ...overrides
    }
  }
}

test("normalizes raw IPC fallback metadata", () => {
  assert.equal(model.numberOr("7", -1), 7)
  assert.equal(model.numberOr("not-a-number", -1), -1)
  assert.deepEqual(model.valuesOf({ values: [1, 2] }), [1, 2])
  assert.equal(Object.keys(model.metadata(null)).length, 0)

  assert.equal(model.workspaceId({ lastIpcObject: { workspace: { id: "4" } } }), 4)
  assert.equal(model.workspaceId(null), -1)
  assert.equal(model.monitorId({ lastIpcObject: { monitor: "7" } }), 7)
  assert.equal(model.historyRank({ focusHistoryID: 2 }), 2)
  assert.equal(model.historyRank({ focusHistoryID: -1 }), 2147483647)
  assert.equal(model.stableAddress({ lastIpcObject: { address: "0xa" } }), "0xa")
  assert.equal(model.stableAddress({ lastIpcObject: { stableId: 42 } }), "42")
  assert.equal(model.stableAddress(null), "")
})

test("uses stable addresses when focus history ties", () => {
  const windows = [
    toplevel("0xb", 1, 7, 1),
    toplevel("0xa", 1, 7, 1)
  ]
  assert.deepEqual(
    Array.from(model.visibleToplevels(windows, 1, 7), window => window.address),
    ["0xa", "0xb"]
  )
  assert.deepEqual(
    Array.from(model.desktopToplevels(windows, 1, 7), window => window.address),
    ["0xa", "0xb"]
  )
})

test("filters live toplevels by workspace and monitor and orders them by MRU", () => {
  const windows = [
    toplevel("0x3", 1, 7, 3),
    toplevel("0x1", 1, 7, 0),
    toplevel("0x2", 2, 7, 1),
    toplevel("0x4", 1, 8, 2),
    toplevel("0x5", 1, 7, 1, { hidden: true }),
    { ...toplevel("0x6", 1, 7, 2), wayland: null },
    toplevel("0x7", 1, 7, -1)
  ]

  const result = model.visibleToplevels(windows, 1, 7)
  assert.deepEqual(Array.from(result, window => window.address), ["0x1", "0x3", "0x7"])
})

test("accepts Quickshell's array-like object models", () => {
  const first = toplevel("0x1", 1, 7, 0)
  const second = toplevel("0x2", 1, 7, 1)
  const qmlList = { 0: first, 1: second, length: 2 }

  assert.deepEqual(
    Array.from(model.visibleToplevels(qmlList, 1, 7), window => window.address),
    ["0x1", "0x2"]
  )
})

test("builds back-to-front desktop stacks and includes pinned windows", () => {
  const windows = [
    toplevel("0x1", 1, 7, 0),
    toplevel("0x2", 1, 7, 3),
    toplevel("0x3", 2, 7, 1, { pinned: true }),
    toplevel("0x4", 2, 7, 2),
    toplevel("0x5", 1, 8, 4)
  ]

  assert.deepEqual(
    Array.from(model.desktopToplevels(windows, 1, 7), window => window.address),
    ["0x2", "0x3", "0x1"]
  )
})

test("bounds selected-grid captures and retains a preferred selection", () => {
  const windows = Array.from({ length: 15 }, (_, index) =>
    toplevel("0x" + index.toString(16), 1, 7, index))
  const ordinary = model.selectedGridCaptureModel(windows, 1, 7, "")
  assert.equal(ordinary.items.length, 12)
  assert.equal(ordinary.totalCount, 15)
  assert.equal(ordinary.omittedCount, 3)
  assert.deepEqual(Array.from(ordinary.items, window => window.address),
    windows.slice(0, 12).map(window => window.address))

  const preferred = model.selectedGridCaptureModel(windows, 1, 7, "0xe")
  assert.equal(preferred.items.length, 12)
  assert.equal(preferred.items[11].address, "0xe")
})

test("workspace thumbnail cap keeps the frontmost back-to-front suffix and counts pins", () => {
  const windows = Array.from({ length: 6 }, (_, index) =>
    toplevel("0x" + index.toString(16), 1, 7, index))
  windows.push(toplevel("0xf", 2, 7, 6, { pinned: true }))

  const preview = model.workspaceThumbnailCaptureModel(windows, 1, 7)
  assert.equal(preview.items.length, 4)
  assert.equal(preview.totalCount, 7)
  assert.equal(preview.omittedCount, 3)
  assert.deepEqual(Array.from(preview.items, window => window.address),
    ["0x3", "0x2", "0x1", "0x0"])
  assert.equal(model.MAX_SELECTED_GRID_CAPTURES
    + 10 * model.MAX_WORKSPACE_THUMBNAIL_CAPTURES, 52)
})

test("scales client geometry into a workspace thumbnail", () => {
  const window = toplevel("0x1", 1, 7, 0, {
    at: [200, 100],
    size: [500, 250]
  })
  const rect = JSON.parse(JSON.stringify(model.workspaceThumbnailRect(
    window, { x: 100, y: 50, width: 1000, height: 500 }, 200, 100
  )))

  assert.deepEqual(rect, { x: 20, y: 10, width: 100, height: 50 })
  // A frame wider than the monitor keeps one scale and crops top and bottom.
  const wide = JSON.parse(JSON.stringify(model.workspaceThumbnailRect(
    window, { x: 100, y: 50, width: 1000, height: 500 }, 300, 100
  )))
  assert.deepEqual(wide, { x: 30, y: -10, width: 150, height: 75 })
  // Padding shrinks the scale; a gap trims each side by half of it.
  const padded = JSON.parse(JSON.stringify(model.workspaceThumbnailRect(
    window, { x: 100, y: 50, width: 1000, height: 500 }, 220, 120, 10, 4
  )))
  assert.deepEqual(padded, { x: 32, y: 22, width: 96, height: 46 })
  const tiny = JSON.parse(JSON.stringify(model.workspaceThumbnailRect(
    window, { x: 100, y: 50, width: 1000, height: 500 }, 20, 10, 0, 40
  )))
  assert.deepEqual(tiny, { x: 4.5, y: 2.25, width: 5, height: 2.5 })
  assert.equal(model.workspaceThumbnailRect(window, { width: 0, height: 500 }, 200, 100), null)
  assert.equal(model.workspaceThumbnailRect(
    toplevel("0x2", 1, 7, 0), { width: 1000, height: 500 }, 200, 100
  ), null)
})

test("lists only positive workspaces on the target monitor and retains selection", () => {
  const workspaces = [
    { id: 4, monitor: { id: 7 } },
    { id: 2, monitor: { id: 7 } },
    { id: 3, monitor: { id: 8 } },
    { id: -99, monitor: { id: 7 } },
    { id: 11, monitor: { id: 7 } }
  ]

  assert.deepEqual(Array.from(model.workspaceIds(workspaces, 7, 1)), [1, 2, 4])
  assert.deepEqual(Array.from(model.workspaceIds(workspaces, 7, 4)), [2, 4])
  assert.deepEqual(Array.from(model.workspaceIds(workspaces, 7, 1, [3, 5])), [1, 2, 3, 4, 5])
  assert.deepEqual(Array.from(model.workspaceIds(workspaces, -1, 1, [5])), [1, 2, 3, 4, 5])
})

test("chooses an adaptive grid for normal and ultrawide monitors", () => {
  assert.equal(model.gridColumns(0, 1920, 1080), 0)
  assert.equal(model.gridColumns(1, 1920, 1080), 1)
  assert.equal(model.gridColumns(5, 1920, 1080), 3)
  assert.equal(model.gridColumns(5, 7680, 1600), 5)
  assert.equal(model.gridColumns(4, 800, 1200), 2)
})

test("keyboard navigation wraps and preserves columns across short rows", () => {
  assert.equal(model.nextGridIndex(4, 1, 0, 3, 5), 0)
  assert.equal(model.nextGridIndex(0, -1, 0, 3, 5), 4)
  assert.equal(model.nextGridIndex(1, 0, 1, 3, 5), 4)
  assert.equal(model.nextGridIndex(2, 0, 1, 3, 5), 4)
  assert.equal(model.nextGridIndex(4, 0, 1, 3, 5), 1)
  assert.equal(model.nextGridIndex(-1, 0, 0, 3, 5), 0)
  assert.equal(model.nextGridIndex(0, 1, 0, 0, 0), -1)
})

test("finds the lowest free workspace id within the cap", () => {
  assert.equal(model.nextFreeWorkspaceId([1, 2, 4], 10), 3)
  assert.equal(model.nextFreeWorkspaceId([2, 3], 10), 1)
  assert.equal(model.nextFreeWorkspaceId([1, 2, 3], 3), -1)
  assert.equal(model.nextFreeWorkspaceId([], 10), 1)
  assert.equal(model.nextFreeWorkspaceId([-5, 0, "x"], 10), 1)
})

test("moves a value between positions without mutating the source", () => {
  const ids = [1, 2, 3, 4]
  assert.deepEqual(Array.from(model.moveArrayValue(ids, 0, 2)), [2, 3, 1, 4])
  assert.deepEqual(Array.from(model.moveArrayValue(ids, 3, 0)), [4, 1, 2, 3])
  assert.deepEqual(Array.from(ids), [1, 2, 3, 4])
  assert.equal(model.moveArrayValue(ids, 1, 1), null)
  assert.equal(model.moveArrayValue(ids, 0, 9), null)
  assert.equal(model.moveArrayValue([], 0, 0), null)
})

test("plans a collision-free two-phase workspace renumber", () => {
  const plan = JSON.parse(JSON.stringify(model.reassignPlan([1, 2, 3, 4], [3, 1, 2, 4], 100)))
  assert.deepEqual(plan, [
    { workspace: 3, id: 100 },
    { workspace: 1, id: 101 },
    { workspace: 2, id: 102 },
    { workspace: 100, id: 1 },
    { workspace: 101, id: 2 },
    { workspace: 102, id: 3 }
  ])
  const sparsePlan = JSON.parse(JSON.stringify(
    model.reassignPlan([1, 2, 3], [1, 3, 2], 200, [1, 3])
  ))
  assert.deepEqual(sparsePlan, [
    { workspace: 3, id: 200 },
    { workspace: 200, id: 2 }
  ])
  assert.deepEqual(Array.from(model.reassignPlan([1, 2], [1, 2], 100)), [])
  assert.deepEqual(Array.from(model.reassignPlan([1], [1, 2], 100)), [])
  assert.deepEqual(Array.from(model.reassignPlan([1, 2], [2, 1], 0)), [])
})

test("remaps managed space ids after content reordering", () => {
  assert.deepEqual(
    Array.from(model.remapWorkspaceIds([2, 4], [1, 2, 3, 4], [3, 1, 4, 2])),
    [3, 4]
  )
  assert.deepEqual(Array.from(model.remapWorkspaceIds([], [1, 2], [2, 1])), [])
  assert.deepEqual(Array.from(model.remapWorkspaceIds([1], [1], [1, 2])), [])
})

test("normalizes user-defined space names", () => {
  assert.equal(model.normalizedSpaceName("  Deep   Work  "), "Deep Work")
  assert.equal(model.normalizedSpaceName("   "), "")
  assert.equal(model.normalizedSpaceName("abcdefghijkl", 6), "abcdef")
  assert.equal(model.normalizedSpaceName(null), "")
  assert.equal(model.normalizedSpaceName("<img src=https://example.test/x>"), "img src=https://example.test/x")
})

test("remaps names with workspace content while preserving outside spaces", () => {
  const remapped = JSON.parse(JSON.stringify(model.remapSpaceNames(
    { 1: "Work", 2: "Chat", 3: "   ", 9: "Outside", bad: "Ignored" },
    [1, 2, 3],
    [2, 1, 3]
  )))
  assert.deepEqual(remapped, { 1: "Chat", 2: "Work", 9: "Outside" })

  const unchanged = JSON.parse(JSON.stringify(
    model.remapSpaceNames({ 1: "Work" }, [1], [1, 2])
  ))
  assert.deepEqual(unchanged, { 1: "Work" })
})

test("picks an adjacent neighbor for workspace removal", () => {
  assert.equal(model.removalNeighbor([1, 2, 3], 2), 1)
  assert.equal(model.removalNeighbor([1, 2, 3], 1), 2)
  assert.equal(model.removalNeighbor([1, 2, 3], 3), 2)
  assert.equal(model.removalNeighbor([1], 1), -1)
  assert.equal(model.removalNeighbor([1, 2], 9), -1)
})

test("maps space row pointer hits to card indexes and rejects gaps and out-of-bounds", () => {
  const width = 144
  const height = 58
  const spacing = 10

  // Cards cover [0,144), [154,298), [308,452).
  assert.equal(model.spaceCardIndexAt(0, 29, 3, width, height, spacing), 0)
  assert.equal(model.spaceCardIndexAt(72, 0, 3, width, height, spacing), 0)
  assert.equal(model.spaceCardIndexAt(226, 57.5, 3, width, height, spacing), 1)
  assert.equal(model.spaceCardIndexAt(308, 29, 3, width, height, spacing), 2)
  assert.equal(model.spaceCardIndexAt(451.9, 29, 3, width, height, spacing), 2)

  // Gaps between cards and both edges of the row reject.
  assert.equal(model.spaceCardIndexAt(150, 29, 3, width, height, spacing), -1)
  assert.equal(model.spaceCardIndexAt(300, 29, 3, width, height, spacing), -1)
  assert.equal(model.spaceCardIndexAt(460, 29, 3, width, height, spacing), -1)
  assert.equal(model.spaceCardIndexAt(-0.5, 29, 3, width, height, spacing), -1)

  // Half-open card edges: right edge of any card rejects.
  assert.equal(model.spaceCardIndexAt(144, 29, 3, width, height, spacing), -1)
  assert.equal(model.spaceCardIndexAt(452, 29, 3, width, height, spacing), -1)
  assert.equal(model.spaceCardIndexAt(462, 29, 3, width, height, spacing), -1)

  // Vertical bounds follow the same half-open rule.
  assert.equal(model.spaceCardIndexAt(72, -1, 3, width, height, spacing), -1)
  assert.equal(model.spaceCardIndexAt(72, 58, 3, width, height, spacing), -1)
})

test("rejects empty space rows, degenerate geometry, and invalid coordinates", () => {
  assert.equal(model.spaceCardIndexAt(72, 29, 0, 144, 58, 10), -1)
  assert.equal(model.spaceCardIndexAt(72, 29, [], 144, 58, 10), -1)
  assert.equal(model.spaceCardIndexAt(72, 29, { length: 0 }, 144, 58, 10), -1)
  assert.equal(model.spaceCardIndexAt(72, 29, -3, 144, 58, 10), -1)

  assert.equal(model.spaceCardIndexAt(72, 29, 3, 0, 58, 10), -1)
  assert.equal(model.spaceCardIndexAt(72, 29, 3, 144, -1, 10), -1)

  assert.equal(model.spaceCardIndexAt(NaN, 29, 3, 144, 58, 10), -1)
  assert.equal(model.spaceCardIndexAt(72, undefined, 3, 144, 58, 10), -1)
})

test("resolves single cards and Quickshell array-like counts", () => {
  assert.equal(model.spaceCardIndexAt(143, 29, 1, 144, 58, 10), 0)
  assert.equal(model.spaceCardIndexAt(144, 29, 1, 144, 58, 10), -1)
  assert.equal(model.spaceCardIndexAt(200, 29, 1, 144, 58, 10), -1)

  const qmlIds = { 0: 1, 1: 2, length: 2 }
  assert.equal(model.spaceCardIndexAt(0, 29, qmlIds, 144, 58, 10), 0)
  assert.equal(model.spaceCardIndexAt(160, 29, qmlIds, 144, 58, 10), 1)
  assert.equal(model.spaceCardIndexAt(150, 29, qmlIds, 144, 58, 10), -1)
})

test("normalizes titles without breaking short labels", () => {
  assert.equal(model.shortenedTitle("  A   useful title  ", 20), "A useful title")
  assert.equal(model.shortenedTitle("A very long window title", 10), "A very lo…")
})

test("arrow keys move through the tiled layout by geometry", () => {
  // Dwindle: a wide left window, the right half split top and bottom, and the
  // bottom split again into left and right.
  const left = { x: 0, y: 0, width: 960, height: 1040 }
  const topRight = { x: 968, y: 0, width: 952, height: 516 }
  const bottomLeft = { x: 968, y: 524, width: 472, height: 516 }
  const bottomRight = { x: 1448, y: 524, width: 472, height: 516 }
  const rects = [left, topRight, bottomLeft, bottomRight]
  assert.equal(model.spatialNeighborIndex(rects, 0, 1, 0), 1)
  assert.equal(model.spatialNeighborIndex(rects, 1, 0, 1), 2)
  assert.equal(model.spatialNeighborIndex(rects, 2, 1, 0), 3)
  assert.equal(model.spatialNeighborIndex(rects, 3, 0, -1), 1)
  assert.equal(model.spatialNeighborIndex(rects, 2, -1, 0), 0)
  assert.equal(model.spatialNeighborIndex(rects, 0, -1, 0), 0, "an edge stays put")
  assert.equal(model.spatialNeighborIndex(rects, 3, 1, 0), 3, "no wrapping")
  assert.equal(model.spatialNeighborIndex(rects, -1, 1, 0), 0, "nothing selected picks the first")
  assert.equal(model.spatialNeighborIndex([], 0, 1, 0), -1)
  assert.equal(model.spatialNeighborIndex(rects, 1, 0, 0), 1)
})

test("settings fall back to the numbered indicator, shown", () => {
  const defaults = { barStyle: "numbers", showBarSpaces: true }
  assert.deepEqual(Array.from(model.BAR_STYLES), ["numbers", "dots", "pills", "lines"])
  for (const raw of [undefined, null, "dots", [], {}, { barStyle: "stars" }, { barStyle: 3 }])
    assert.deepEqual({ ...model.normalizedSettings(raw) }, defaults)
  assert.deepEqual({ ...model.normalizedSettings({ barStyle: " Dots ", showBarSpaces: false }) },
    { barStyle: "dots", showBarSpaces: false })
  assert.equal(model.normalizedSettings({ showBarSpaces: "false" }).showBarSpaces, true)
  assert.equal(model.normalizedSettings({ showBarSpaces: 0 }).showBarSpaces, true)
  assert.equal("extra" in model.normalizedSettings({ barStyle: "lines", extra: 1 }), false)
})

test("bar styles cycle in order and wrap both ways", () => {
  assert.equal(model.nextBarStyle("numbers", 1), "dots")
  assert.equal(model.nextBarStyle("lines", 1), "numbers")
  assert.equal(model.nextBarStyle("numbers", -1), "lines")
  assert.equal(model.nextBarStyle("pills", 6), "numbers")
  assert.equal(model.nextBarStyle("dots", 0), "dots")
  assert.equal(model.nextBarStyle("unknown", 1), "dots")
  assert.equal(model.nextBarStyle("dots", "x"), "dots")
})

test("Hyprland border colors keep every gradient stop and the angle", () => {
  const plain = (value) => ({ ...model.hyprBorderGradient(value), colors: Array.from(model.hyprBorderGradient(value).colors) })
  assert.deepEqual(plain("ffb8603d 0deg"), { colors: ["#ffb8603d"], angle: 0 })
  assert.deepEqual(plain("ee33ccff ee00ff99 45deg"), { colors: ["#ee33ccff", "#ee00ff99"], angle: 45 })
  assert.deepEqual(plain("rgba(33ccffee) rgb(00FF99) -90.5deg"),
    { colors: ["#ee33ccff", "#ff00ff99"], angle: -90.5 })
  assert.deepEqual(plain("0xff123456 abcdef"), { colors: ["#ff123456", "#ffabcdef"], angle: 0 })
  assert.deepEqual(plain(""), { colors: [], angle: 0 })
  assert.deepEqual(plain(null), { colors: [], angle: 0 })
  assert.deepEqual(plain("red 12 rgba(zz) 1234567"), { colors: [], angle: 0 })
  assert.equal(model.hyprBorderGradient(Array(12).fill("ff000000").join(" ")).colors.length, 10)
})

// Hyprland's shader: progress = sin(a) * y/h + (1 - sin(a)) * x/w for a in
// 0-90 degrees, mirrored for the other quadrants.
function hyprProgress(x, y, w, h, angle) {
  let a = ((angle % 360) + 360) % 360
  let nx = x / w, ny = y / h
  if (a > 270) { ny = 1 - ny; a = 360 - a }
  else if (a > 180) { nx = 1 - nx; ny = 1 - ny; a = a - 180 }
  else if (a > 90) { nx = 1 - nx; a = 180 - a }
  const s = Math.sin(a * Math.PI / 180)
  return ny * s + nx * (1 - s)
}

test("the border gradient line reproduces Hyprland's progress at every angle", () => {
  const w = 941, h = 508
  for (const angle of [0, 30, 45, 90, 135, 180, 225, 270, 300, 359, -45, 405]) {
    const line = model.hyprGradientLine(w, h, angle)
    const dx = line.x2 - line.x1, dy = line.y2 - line.y1
    for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h], [300, 120], [w / 2, h / 2]]) {
      const ours = ((x - line.x1) * dx + (y - line.y1) * dy) / (dx * dx + dy * dy)
      assert.ok(Math.abs(ours - hyprProgress(x, y, w, h, angle)) < 1e-9, `angle ${angle} at ${x},${y}`)
    }
  }
  assert.ok(isFinite(model.hyprGradientLine(0, 0, "x").x2))
})

test("the outer border radius follows Hyprland's rounding_power correction", () => {
  assert.equal(model.hyprOuterRadius(9, 4, 2), 13)
  assert.equal(model.hyprOuterRadius(13.5, 4, 3), 17.5)
  assert.ok(Math.abs(model.hyprOuterRadius(6.75, 4, 1.5) - (10.75 - 4 * (Math.SQRT2 - 1) * 0.5)) < 1e-9)
  assert.equal(model.hyprOuterRadius(0, 4, 1.5), 0, "square windows keep a square border")
  assert.equal(model.hyprOuterRadius(-1, "x", undefined), 0)
})

test("superellipse corners sit on |x|^p + |y|^p = r^p", () => {
  assert.equal(model.superellipseRectPath(1, 2, 10, 20, 0, 2), "M 1 2 H 11 V 22 H 1 Z")
  const path = model.superellipseRectPath(0, 0, 100, 60, 10, 1.5)
  const points = [...path.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])])
  assert.equal(points.length, 68)
  for (const [x, y] of points.filter(([x, y]) => x <= 10 && y <= 10)) {
    const value = Math.pow(Math.abs(10 - x) / 10, 1.5) + Math.pow(Math.abs(10 - y) / 10, 1.5)
    assert.ok(Math.abs(value - 1) < 0.01, `${x},${y}`)
  }
  assert.match(model.superellipseRectPath(0, 0, 10, 10, 50, 2), /^M 5 0 L/, "radius clamps to half the side")
})

test("the border ring is the outer and inner outline as one even-odd path", () => {
  assert.equal(model.hyprBorderPath(100, 60, 9, 0, 2), "")
  assert.equal(model.hyprBorderPath(8, 60, 9, 4, 2), "")
  const ring = model.hyprBorderPath(100, 60, 9, 4, 2)
  assert.equal((ring.match(/Z/g) || []).length, 2)
  assert.ok(ring.startsWith(model.superellipseRectPath(0, 0, 100, 60, 13, 2)))
  assert.ok(ring.endsWith(model.superellipseRectPath(4, 4, 92, 52, 9, 2)))
})
