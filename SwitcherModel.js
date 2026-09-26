.pragma library

var MAX_CLIENTS = 256
var SAFE_ICON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
var STABLE_ID_PATTERN = /^[0-9A-Fa-f]+$/

function valuesOf(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value !== "string" && typeof value.length === "number") return value
  if (value && value.values !== undefined) return valuesOf(value.values)
  return []
}

function metadata(client) {
  return client && client.lastIpcObject ? client.lastIpcObject : (client || ({}))
}

function address(client) {
  var data = metadata(client)
  return String((client && client.address) || data.address || "")
}

function stableId(client) {
  var data = metadata(client)
  return String((client && client.stableId) || data.stableId || "")
}

function monitorId(client) {
  if (client && client.monitor && typeof client.monitor === "object")
    return Number(client.monitor.id)
  return Number(metadata(client).monitor)
}

function workspaceId(client) {
  if (client && client.workspace && typeof client.workspace === "object")
    return Number(client.workspace.id)
  var workspace = metadata(client).workspace
  return Number(workspace && typeof workspace === "object" ? workspace.id : workspace)
}

function historyRank(client) {
  var rank = Number(metadata(client).focusHistoryID)
  return isFinite(rank) && rank >= 0 ? rank : 2147483647
}

function isSwitchable(client, wantedMonitor, wantedWorkspace) {
  var data = metadata(client)
  if (!client || !address(client)) return false
  if (data.mapped === false || data.hidden === true || data.acceptsInput === false) return false
  if (String(monitorId(client)) !== String(wantedMonitor)) return false
  if (wantedWorkspace !== null && wantedWorkspace !== undefined
      && String(workspaceId(client)) !== String(wantedWorkspace)) return false
  return true
}

function switchableClients(clients, monitor, workspace, limit) {
  var source = valuesOf(clients)
  var maximum = Math.max(1, Math.min(MAX_CLIENTS, Number(limit) || MAX_CLIENTS))
  var result = []

  for (var i = 0; i < source.length; i++) {
    if (isSwitchable(source[i], monitor, workspace)) result.push(source[i])
  }

  result.sort(function(left, right) {
    var byHistory = historyRank(left) - historyRank(right)
    if (byHistory !== 0) return byHistory
    var leftStable = stableId(left) || address(left)
    var rightStable = stableId(right) || address(right)
    return leftStable < rightStable ? -1 : (leftStable > rightStable ? 1 : 0)
  })
  return result.slice(0, maximum)
}

function findSwitchableByStableId(clients, id, monitor, workspace) {
  var wanted = String(id || "")
  if (!STABLE_ID_PATTERN.test(wanted)) return null
  var source = valuesOf(clients)
  for (var i = 0; i < source.length; i++) {
    if (stableId(source[i]) === wanted
        && isSwitchable(source[i], monitor, workspace)) return source[i]
  }
  return null
}

function safeIconName(value) {
  var name = String(value || "").trim()
  if (name.indexOf(".") < 0) name = name.toLowerCase()
  return SAFE_ICON_PATTERN.test(name) ? name : "application-x-executable"
}

function unwrapEntry(row) {
  return row && row.entry ? row.entry : row
}

function normalizeDesktopKey(value) {
  return String(value || "").replace(/\.desktop$/i, "").toLowerCase()
}

function entryScore(entry, key) {
  var entryId = normalizeDesktopKey(entry && entry.id)
  var entryName = String((entry && (entry.name || entry.id)) || "").toLowerCase()
  if (!key) return 100
  if (entryId === key) return 0
  if (entryId.slice(-(key.length + 1)) === "." + key
      || key.slice(-(entryId.length + 1)) === "." + entryId) return 1
  if (normalizeDesktopKey(entry && entry.startupClass) === key) return 1
  if (entryName === key) return 2
  var command = String((entry && entry.command && entry.command[0]) || "")
  var executable = command.split("/").pop().toLowerCase()
  if (executable && executable === key) return 3
  return 100
}

function bestDesktopEntry(rows, keys) {
  var source = valuesOf(rows)
  var best = null
  var bestScore = 100
  for (var i = 0; i < source.length; i++) {
    var entry = unwrapEntry(source[i])
    for (var j = 0; j < keys.length; j++) {
      var score = entryScore(entry, normalizeDesktopKey(keys[j]))
      if (score < bestScore) {
        best = entry
        bestScore = score
      }
    }
  }
  return best
}

function desktopEntry(rows, initialClass, windowClass, title) {
  var classMatch = bestDesktopEntry(rows, [initialClass, windowClass])
  return classMatch || bestDesktopEntry(rows, [title])
}

function initialIndex(direction, count) {
  var size = Math.max(0, Number(count) || 0)
  if (size <= 1) return size - 1
  return Number(direction) < 0 ? size - 1 : 1
}

function nextIndex(index, delta, count) {
  var size = Math.max(0, Number(count) || 0)
  if (size === 0) return -1
  var current = Number(index)
  if (!isFinite(current) || current < 0) current = 0
  var step = Number(delta)
  if (!isFinite(step)) step = 0
  return ((current + step) % size + size) % size
}

function classLabel(value) {
  var raw = String(value || "").trim()
  if (!raw) return "Application"
  var segments = raw.split(".")
  var leaf = segments[segments.length - 1] || raw
  var words = leaf.replace(/[-_]+/g, " ").split(/\s+/)
  for (var i = 0; i < words.length; i++) {
    if (words[i]) words[i] = words[i].charAt(0).toUpperCase() + words[i].slice(1)
  }
  return words.join(" ")
}

function shortenedTitle(value, limit) {
  var text = String(value || "").replace(/\s+/g, " ").trim()
  var maximum = Math.max(1, Number(limit) || 80)
  var characters = Array.from(text)
  return characters.length <= maximum ? text
    : characters.slice(0, Math.max(0, maximum - 1)).join("") + "…"
}
