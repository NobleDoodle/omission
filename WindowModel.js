.pragma library

var MAX_SELECTED_GRID_CAPTURES = 12
var MAX_WORKSPACE_THUMBNAIL_CAPTURES = 4

function numberOr(value, fallback) {
  var parsed = Number(value)
  return isFinite(parsed) ? parsed : fallback
}

function valuesOf(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value !== "string" && typeof value.length === "number") return value
  if (value && Array.isArray(value.values)) return value.values
  return []
}

function metadata(toplevel) {
  return toplevel && toplevel.lastIpcObject ? toplevel.lastIpcObject : ({})
}

function workspaceId(toplevel) {
  if (toplevel && toplevel.workspace)
    return numberOr(toplevel.workspace.id, -1)

  var data = metadata(toplevel)
  if (data.workspace) return numberOr(data.workspace.id, -1)
  return -1
}

function monitorId(toplevel) {
  if (toplevel && toplevel.monitor)
    return numberOr(toplevel.monitor.id, -1)

  return numberOr(metadata(toplevel).monitor, -1)
}

function historyRank(toplevel) {
  var data = metadata(toplevel)
  var rank = numberOr(data.focusHistoryID,
    numberOr(toplevel && toplevel.focusHistoryID, 2147483647))
  return rank >= 0 ? rank : 2147483647
}

function stableAddress(toplevel) {
  var data = metadata(toplevel)
  return String((toplevel && toplevel.address) || data.address || data.stableId || "")
}

function isVisibleToplevel(toplevel) {
  if (!toplevel || !toplevel.wayland) return false

  var data = metadata(toplevel)
  if (data.mapped === false || data.hidden === true || data.acceptsInput === false) return false
  return workspaceId(toplevel) > 0 && monitorId(toplevel) >= 0
}

function visibleToplevels(toplevels, wantedWorkspaceId, wantedMonitorId) {
  var source = valuesOf(toplevels)
  var workspace = numberOr(wantedWorkspaceId, -1)
  var monitor = numberOr(wantedMonitorId, -1)
  var result = []

  for (var i = 0; i < source.length; i++) {
    var toplevel = source[i]
    if (!isVisibleToplevel(toplevel)) continue
    if (workspaceId(toplevel) !== workspace) continue
    if (monitorId(toplevel) !== monitor) continue
    result.push(toplevel)
  }

  result.sort(function(left, right) {
    var byHistory = historyRank(left) - historyRank(right)
    if (byHistory !== 0) return byHistory

    var leftAddress = stableAddress(left)
    var rightAddress = stableAddress(right)
    return leftAddress < rightAddress ? -1 : (leftAddress > rightAddress ? 1 : 0)
  })
  return result
}

function desktopToplevels(toplevels, wantedWorkspaceId, wantedMonitorId) {
  var source = valuesOf(toplevels)
  var workspace = numberOr(wantedWorkspaceId, -1)
  var monitor = numberOr(wantedMonitorId, -1)
  var result = []

  for (var i = 0; i < source.length; i++) {
    var toplevel = source[i]
    if (!isVisibleToplevel(toplevel) || monitorId(toplevel) !== monitor) continue
    if (workspaceId(toplevel) !== workspace && metadata(toplevel).pinned !== true) continue
    result.push(toplevel)
  }

  result.sort(function(left, right) {
    var byHistory = historyRank(right) - historyRank(left)
    if (byHistory !== 0) return byHistory
    var leftAddress = stableAddress(left)
    var rightAddress = stableAddress(right)
    return leftAddress < rightAddress ? -1 : (leftAddress > rightAddress ? 1 : 0)
  })
  return result
}

function boundedFront(values, limit, preferredAddress) {
  var source = valuesOf(values)
  var maximum = Math.max(0, Math.floor(numberOr(limit, 0)))
  if (maximum === 0) return []
  if (source.length <= maximum) return Array.prototype.slice.call(source)
  var result = Array.prototype.slice.call(source, 0, maximum)
  var wanted = String(preferredAddress || "")
  if (!wanted) return result
  for (var i = maximum; i < source.length; i++) {
    if (stableAddress(source[i]) === wanted) {
      result[result.length - 1] = source[i]
      break
    }
  }
  return result
}

function boundedBackStack(values, limit) {
  var source = valuesOf(values)
  var maximum = Math.max(0, Math.floor(numberOr(limit, 0)))
  if (maximum === 0) return []
  return Array.prototype.slice.call(source, Math.max(0, source.length - maximum))
}

function selectedGridCaptureModel(toplevels, workspaceId, monitorId, preferredAddress) {
  var all = visibleToplevels(toplevels, workspaceId, monitorId)
  var items = boundedFront(all, MAX_SELECTED_GRID_CAPTURES, preferredAddress)
  return {
    items: items,
    totalCount: all.length,
    omittedCount: Math.max(0, all.length - items.length)
  }
}

function workspaceThumbnailCaptureModel(toplevels, workspaceId, monitorId) {
  var all = desktopToplevels(toplevels, workspaceId, monitorId)
  var items = boundedBackStack(all, MAX_WORKSPACE_THUMBNAIL_CAPTURES)
  return {
    items: items,
    totalCount: all.length,
    omittedCount: Math.max(0, all.length - items.length)
  }
}

function workspaceThumbnailRect(toplevel, monitor, frameWidth, frameHeight, padding, gap) {
  var data = metadata(toplevel)
  var at = valuesOf(data.at)
  var size = valuesOf(data.size)
  var monitorWidth = numberOr(monitor && monitor.width, 0)
  var monitorHeight = numberOr(monitor && monitor.height, 0)
  var width = numberOr(frameWidth, 0)
  var height = numberOr(frameHeight, 0)
  if (at.length < 2 || size.length < 2 || monitorWidth <= 0 || monitorHeight <= 0
      || width <= 0 || height <= 0) return null

  // One scale for both axes, cropped and centered in the frame less its
  // padding. Stretching the axes separately would make each capture, which
  // keeps its own aspect ratio, shrink inside its slot and open wide gaps
  // between neighboring windows. Each window then gives up gap / 2 per side.
  var inset = Math.max(0, numberOr(padding, 0))
  var spacing = Math.max(0, numberOr(gap, 0)) / 2
  var scale = Math.max(Math.max(1, width - 2 * inset) / monitorWidth,
    Math.max(1, height - 2 * inset) / monitorHeight)
  var offsetX = (width - monitorWidth * scale) / 2
  var offsetY = (height - monitorHeight * scale) / 2
  var scaledWidth = numberOr(size[0], 1) * scale
  var scaledHeight = numberOr(size[1], 1) * scale
  return {
    x: offsetX + (numberOr(at[0], 0) - numberOr(monitor && monitor.x, 0)) * scale
      + Math.min(spacing, scaledWidth / 4),
    y: offsetY + (numberOr(at[1], 0) - numberOr(monitor && monitor.y, 0)) * scale
      + Math.min(spacing, scaledHeight / 4),
    width: Math.max(1, scaledWidth - 2 * Math.min(spacing, scaledWidth / 4)),
    height: Math.max(1, scaledHeight - 2 * Math.min(spacing, scaledHeight / 4))
  }
}




function workspaceIds(workspaces, wantedMonitorId, selectedWorkspaceId, managedIds) {
  var source = valuesOf(workspaces)
  var monitor = numberOr(wantedMonitorId, -1)
  var selected = numberOr(selectedWorkspaceId, -1)
  var ids = []

  function include(id) {
    if (id > 0 && id <= 10 && ids.indexOf(id) === -1) ids.push(id)
  }

  include(selected)
  var managed = valuesOf(managedIds)
  for (var i = 0; i < managed.length; i++) include(numberOr(managed[i], -1))

  for (var j = 0; j < source.length; j++) {
    var workspace = source[j]
    if (!workspace) continue

    var workspaceMonitor = workspace.monitor
      ? numberOr(workspace.monitor.id, -1)
      : numberOr(workspace.lastIpcObject && workspace.lastIpcObject.monitor, -1)
    if (monitor >= 0 && workspaceMonitor !== monitor) continue
    include(numberOr(workspace.id, -1))
  }

  ids.sort(function(left, right) { return left - right })
  return ids
}

// A Hyprland border color as `hyprctl getoption` reports it ("ffb8603d
// ff33ccff 45deg"), or as written in config (rgba(33ccffee), rgb(33ccff),
// 0xff33ccff): every color stop as "#AARRGGBB" and the angle in degrees.
// Up to ten stops, the most Omarchy's border overlay draws.
function hyprBorderGradient(value) {
  var tokens = String(value || "").trim().split(/\s+/)
  var colors = []
  var angle = 0
  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i]
    var degrees = /^(-?\d+(?:\.\d+)?)deg$/i.exec(token)
    if (degrees) { angle = Number(degrees[1]); continue }
    var hex = ""
    var wrapped = /^rgba?\(([0-9a-f]{6}|[0-9a-f]{8})\)$/i.exec(token)
    if (wrapped) {
      hex = wrapped[1].length === 6 ? "ff" + wrapped[1]
        : wrapped[1].slice(6) + wrapped[1].slice(0, 6)
    } else {
      var plain = /^(?:0x)?([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(token)
      if (plain) hex = plain[1].length === 6 ? "ff" + plain[1] : plain[1]
    }
    if (hex && colors.length < 10) colors.push("#" + hex.toLowerCase())
  }
  return { colors: colors, angle: angle }
}

// The line a QML LinearGradient needs to reproduce Hyprland's border
// gradient over a w x h border box. Hyprland's shader does not project a
// geometric angle: for an angle in 0-90 degrees it takes
// progress = sin(a) * y/h + (1 - sin(a)) * x/w, mirroring x, y or both for the
// other quadrants. That is linear in x and y, so one gradient line holds it.
function hyprGradientLine(w, h, angle) {
  var width = Math.max(1, numberOr(w, 1))
  var height = Math.max(1, numberOr(h, 1))
  var degrees = ((numberOr(angle, 0) % 360) + 360) % 360
  var flipX = degrees > 90 && degrees <= 270
  var flipY = degrees > 180
  var finalAngle = degrees > 270 ? 360 - degrees
    : degrees > 180 ? degrees - 180
    : degrees > 90 ? 180 - degrees : degrees
  var sine = Math.sin(finalAngle * Math.PI / 180)
  // progress = c0 + cx * x + cy * y
  var cx = (1 - sine) / width * (flipX ? -1 : 1)
  var cy = sine / height * (flipY ? -1 : 1)
  var c0 = (flipX ? 1 - sine : 0) + (flipY ? sine : 0)
  var norm = cx * cx + cy * cy
  var x1 = -c0 * cx / norm
  var y1 = -c0 * cy / norm
  return { x1: x1, y1: y1, x2: x1 + cx / norm, y2: y1 + cy / norm }
}

// Hyprland's outer border radius: rounding + border_size, less the
// correction it applies when rounding_power is under 2. Square stays square.
function hyprOuterRadius(innerRadius, thickness, power) {
  var inner = Math.max(0, numberOr(innerRadius, 0))
  var border = Math.max(0, numberOr(thickness, 0))
  if (inner <= 0) return 0
  var correction = border * (Math.SQRT2 - 1) * Math.max(2 - numberOr(power, 2), 0)
  return Math.max(0, inner + border - correction)
}

// An SVG rounded rectangle whose corners follow Hyprland's rounding_power:
// |x|^p + |y|^p = r^p (2 is a circle, larger is a squircle).
function superellipseRectPath(x, y, w, h, radius, power) {
  var r = Math.max(0, Math.min(numberOr(radius, 0), w / 2, h / 2))
  var exponent = 2 / Math.max(1, Math.min(10, numberOr(power, 2)))
  function n(value) { return Math.round(value * 1000) / 1000 }
  if (r <= 0)
    return "M " + n(x) + " " + n(y) + " H " + n(x + w) + " V " + n(y + h)
      + " H " + n(x) + " Z"
  var corners = [
    [x + w - r, y + r, -90], [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 90], [x + r, y + r, 180]
  ]
  var steps = 16
  var parts = []
  for (var c = 0; c < corners.length; c++) {
    for (var k = 0; k <= steps; k++) {
      var t = (corners[c][2] + 90 * k / steps) * Math.PI / 180
      var cos = Math.cos(t)
      var sin = Math.sin(t)
      var px = corners[c][0] + r * (cos < 0 ? -1 : 1) * Math.pow(Math.abs(cos), exponent)
      var py = corners[c][1] + r * (sin < 0 ? -1 : 1) * Math.pow(Math.abs(sin), exponent)
      parts.push((parts.length === 0 ? "M " : "L ") + n(px) + " " + n(py))
    }
  }
  return parts.join(" ") + " Z"
}

// The ring Hyprland paints around a window, as one even-odd SVG path over the
// border box: the outer edge border_size out from the window, the inner edge
// on the window's own rounded outline.
function hyprBorderPath(w, h, innerRadius, thickness, power) {
  var border = Math.max(0, numberOr(thickness, 0))
  var width = Math.max(0, numberOr(w, 0))
  var height = Math.max(0, numberOr(h, 0))
  if (border <= 0 || width <= 2 * border || height <= 2 * border) return ""
  return superellipseRectPath(0, 0, width, height,
      hyprOuterRadius(innerRadius, border, power), power)
    + " " + superellipseRectPath(border, border, width - 2 * border,
      height - 2 * border, innerRadius, power)
}

var BAR_STYLES = ["numbers", "dots", "pills", "lines"]

// Omission's own settings (omission-settings.json), chosen in the overview:
// the bar indicator's style and whether it shows at all. Anything missing or
// unknown falls back to the original numbered indicator, shown.
function normalizedSettings(values) {
  var source = values && typeof values === "object" && !Array.isArray(values)
    ? values : {}
  var style = String(source.barStyle || "").trim().toLowerCase()
  return {
    barStyle: BAR_STYLES.indexOf(style) >= 0 ? style : BAR_STYLES[0],
    showBarSpaces: source.showBarSpaces !== false
  }
}

// The style `step` places after `style` in BAR_STYLES, wrapping both ways.
function nextBarStyle(style, step) {
  var index = BAR_STYLES.indexOf(String(style))
  if (index < 0) index = 0
  var count = BAR_STYLES.length
  return BAR_STYLES[((index + Math.trunc(numberOr(step, 0))) % count + count) % count]
}

function gridColumns(count, width, height) {
  var size = Math.max(0, Math.floor(numberOr(count, 0)))
  if (size <= 1) return size

  var availableWidth = Math.max(1, numberOr(width, 1))
  var availableHeight = Math.max(1, numberOr(height, 1))
  var aspect = Math.max(0.5, Math.min(6, availableWidth / availableHeight))
  var columns = Math.ceil(Math.sqrt(size * aspect * 0.95))
  return Math.max(1, Math.min(size, columns))
}

function nextGridIndex(index, horizontal, vertical, columns, count) {
  var size = Math.max(0, Math.floor(numberOr(count, 0)))
  if (size === 0) return -1

  var current = Math.floor(numberOr(index, 0))
  if (current < 0 || current >= size) current = 0

  var horizontalStep = Math.sign(numberOr(horizontal, 0))
  if (horizontalStep !== 0)
    return ((current + horizontalStep) % size + size) % size

  var verticalStep = Math.sign(numberOr(vertical, 0))
  if (verticalStep === 0) return current

  var columnCount = Math.max(1, Math.min(size, Math.floor(numberOr(columns, 1))))
  var rowCount = Math.ceil(size / columnCount)
  var currentRow = Math.floor(current / columnCount)
  var currentColumn = current % columnCount
  var targetRow = ((currentRow + verticalStep) % rowCount + rowCount) % rowCount
  var rowStart = targetRow * columnCount
  var rowLength = Math.min(columnCount, size - rowStart)
  return rowStart + Math.min(currentColumn, rowLength - 1)
}

function nextFreeWorkspaceId(existingIds, cap) {
  var ceiling = Math.floor(numberOr(cap, 10))
  if (ceiling < 1) return -1

  var taken = []
  var source = valuesOf(existingIds)
  for (var i = 0; i < source.length; i++) {
    var id = Math.floor(numberOr(source[i], -1))
    if (id > 0) taken.push(id)
  }

  for (var candidate = 1; candidate <= ceiling; candidate++) {
    if (taken.indexOf(candidate) === -1) return candidate
  }
  return -1
}

function moveArrayValue(values, from, to) {
  var size = valuesOf(values).length
  var source = Math.floor(numberOr(from, -1))
  var target = Math.floor(numberOr(to, -1))
  if (size === 0 || source < 0 || source >= size || target < 0 || target >= size
    || source === target) return null

  var next = []
  for (var i = 0; i < size; i++) next.push(values[i])
  var moved = next.splice(source, 1)[0]
  next.splice(target, 0, moved)
  return next
}

function reassignPlan(currentIds, desiredIds, tempBase, existingIds) {
  var current = valuesOf(currentIds)
  var desired = valuesOf(desiredIds)
  if (current.length === 0 || current.length !== desired.length) return []

  var base = Math.floor(numberOr(tempBase, 0))
  if (base <= 0) return []

  var existing = existingIds === undefined ? desired : valuesOf(existingIds)
  var phase = []
  var seen = []
  for (var i = 0; i < existing.length; i++) {
    var workspace = numberOr(existing[i], -1)
    if (workspace <= 0 || seen.indexOf(workspace) !== -1) continue
    seen.push(workspace)

    var position = desired.indexOf(workspace)
    if (position < 0) continue
    var targetId = numberOr(current[position], -1)
    if (targetId <= 0 || targetId === workspace) continue
    phase.push({ workspace: workspace, temporaryId: base + phase.length, targetId: targetId })
  }

  var moves = []
  for (var j = 0; j < phase.length; j++)
    moves.push({ workspace: phase[j].workspace, id: phase[j].temporaryId })
  for (var k = 0; k < phase.length; k++)
    moves.push({ workspace: phase[k].temporaryId, id: phase[k].targetId })
  return moves
}

function removalNeighbor(ids, removedId) {
  var source = valuesOf(ids)
  if (source.length < 2) return -1

  var index = source.indexOf(Math.floor(numberOr(removedId, -1)))
  if (index === -1) return -1
  return index > 0 ? numberOr(source[index - 1], -1) : numberOr(source[1], -1)
}

function remapWorkspaceIds(ids, currentIds, desiredIds) {
  var source = valuesOf(ids)
  var current = valuesOf(currentIds)
  var desired = valuesOf(desiredIds)
  if (current.length === 0 || current.length !== desired.length) return []

  var remapped = []
  for (var i = 0; i < source.length; i++) {
    var oldId = numberOr(source[i], -1)
    var position = desired.indexOf(oldId)
    if (position < 0) continue
    var newId = numberOr(current[position], -1)
    if (newId > 0 && remapped.indexOf(newId) === -1) remapped.push(newId)
  }
  remapped.sort(function(left, right) { return left - right })
  return remapped
}

function normalizedSpaceName(value, limit) {
  var text = String(value || "").replace(/[<>&]/g, "").replace(/\s+/g, " ").trim()
  var maximum = Math.max(1, numberOr(limit, 32))
  return text.slice(0, maximum)
}

function remapSpaceNames(names, currentIds, desiredIds) {
  var source = names && typeof names === "object" ? names : ({})
  var current = valuesOf(currentIds)
  var desired = valuesOf(desiredIds)
  var canRemap = current.length > 0 && current.length === desired.length
  var result = ({})

  for (var key in source) {
    var oldId = Math.floor(numberOr(key, -1))
    var name = normalizedSpaceName(source[key], 32)
    if (oldId <= 0 || !name) continue

    var newId = oldId
    if (canRemap) {
      var position = desired.indexOf(oldId)
      if (position >= 0) newId = Math.floor(numberOr(current[position], oldId))
    }
    if (newId > 0) result[String(newId)] = name
  }
  return result
}

function spaceCardIndexAt(x, y, count, cardWidth, cardHeight, cardSpacing) {
  var numericCount = Math.floor(numberOr(count, 0))
  var size = numericCount > 0 ? numericCount : valuesOf(count).length
  var width = numberOr(cardWidth, 0)
  var height = numberOr(cardHeight, 0)
  var spacing = Math.max(0, numberOr(cardSpacing, 0))
  if (size === 0 || width <= 0 || height <= 0) return -1

  var px = Number(x)
  var py = Number(y)
  if (!isFinite(px) || !isFinite(py)) return -1
  if (px < 0 || py < 0 || py >= height) return -1

  var step = width + spacing
  var slot = Math.floor(px / step)
  if (slot >= size) return -1
  return px - slot * step < width ? slot : -1
}


function shortenedTitle(value, limit) {
  var text = String(value || "").replace(/\s+/g, " ").trim()
  var maximum = Math.max(1, numberOr(limit, 80))
  return text.length <= maximum ? text : text.slice(0, maximum - 1) + "…"
}

// Arrow-key movement over the tiled layout: the nearest window whose centre
// lies in the pressed direction, preferring ones that share the current
// window's row (or column), the way Hyprland's own focus movement does. Ties
// go to the most recently used window. Stays put at an edge, no wrapping.
function spatialNeighborIndex(rects, index, horizontal, vertical) {
  var list = valuesOf(rects)
  var count = list.length
  if (count === 0) return -1
  var dx = numberOr(horizontal, 0) > 0 ? 1 : (numberOr(horizontal, 0) < 0 ? -1 : 0)
  var dy = dx !== 0 ? 0 : (numberOr(vertical, 0) > 0 ? 1 : (numberOr(vertical, 0) < 0 ? -1 : 0))
  var current = numberOr(index, -1)
  if (current < 0 || current >= count || !list[current]) return 0
  if (dx === 0 && dy === 0) return current

  var from = list[current]
  var fromX = from.x + from.width / 2
  var fromY = from.y + from.height / 2
  var best = current
  var bestScore = Infinity
  for (var i = 0; i < count; i++) {
    var rect = list[i]
    if (i === current || !rect) continue
    var centerX = rect.x + rect.width / 2
    var centerY = rect.y + rect.height / 2
    var along = dx !== 0 ? (centerX - fromX) * dx : (centerY - fromY) * dy
    if (along <= 0) continue
    var overlaps = dx !== 0
      ? rect.y < from.y + from.height && rect.y + rect.height > from.y
      : rect.x < from.x + from.width && rect.x + rect.width > from.x
    // Distance between the facing edges, so windows that both touch the
    // current one count as equally near however wide they are.
    var gap = Math.max(0, dx > 0 ? rect.x - (from.x + from.width)
      : dx < 0 ? from.x - (rect.x + rect.width)
      : dy > 0 ? rect.y - (from.y + from.height)
      : from.y - (rect.y + rect.height))
    var across = dx !== 0 ? Math.abs(centerY - fromY) : Math.abs(centerX - fromX)
    var score = (overlaps ? 0 : 1e6) + gap * 4 + across
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}
