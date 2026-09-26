.pragma library

// Pure generator for the compositor-side Hyprland Lua binding script of
// the merged plugin's Alt-Tab switcher. No Qt imports and no ambient
// state: every dynamic value arrives as a validated option, so generated
// Lua never interpolates client data and identical options always produce
// an identical script.

var SUBMAP = "omission-alt-tab"
var SHELL_TARGET = "io.github.nobledoodle.omission"
var IPC_COMMAND = "omarchy-shell -q shell call " + SHELL_TARGET + " "

// Bounded registration retry policy consumed by AltTabService.qml.
var REGISTRATION_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 250
}

var OWNER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function optionNumber(raw, fallback, minimum, maximum) {
  var value = Math.round(Number(raw))
  if (!isFinite(value)) value = fallback
  return Math.max(minimum, Math.min(maximum, value))
}

function bindingOptions(raw) {
  var options = raw || {}
  if (typeof options.ownerToken !== "string")
    throw new Error("AltTabBindingScript: ownerToken must be a string")
  var ownerToken = options.ownerToken
  if (!OWNER_TOKEN_PATTERN.test(ownerToken)) {
    throw new Error("AltTabBindingScript: ownerToken must be alphanumeric with . _ or - separators")
  }
  return {
    ownerToken: ownerToken,
    submap: SUBMAP,
    coalesceMs: optionNumber(options.coalesceMs, 60, 10, 500),
    pollIntervalMs: optionNumber(options.pollIntervalMs, 16, 8, 100),
    maxPollTicks: optionNumber(options.maxPollTicks, 700, 10, 5000),
    commitDelayMs: optionNumber(options.commitDelayMs, 40, 0, 500)
  }
}

function generateApply(raw) {
  var options = bindingOptions(raw)
  var owner = options.ownerToken
  return [
    "local owner = \"" + owner + "\"",
    "local submap = \"" + SUBMAP + "\"",
    "local coalesce_ms = " + options.coalesceMs,
    "local poll_ms = " + options.pollIntervalMs,
    "local max_poll_ticks = " + options.maxPollTicks,
    "local commit_delay_ms = " + options.commitDelayMs,
    "local pending_delta = 0",
    "local flush_scheduled = false",
    "local poll_ticks = 0",
    "local function owned()",
    "  return _G.omission_alt_tab_owner == owner",
    "end",
    "local function live()",
    "  return owned() and _G.omission_alt_tab_active == true",
    "end",
    "local function shell_call(method, argument)",
    "  local suffix = argument and (\" \" .. argument) or \"\"",
    "  pcall(hl.exec_cmd, \"" + IPC_COMMAND + "\" .. method .. suffix)",
    "end",
    "-- Leave the plugin submap only when it is the current one, so an",
    "-- unrelated submap is never reset.",
    "local function reset_our_submap()",
    "  if hl.get_current_submap() == submap then",
    "    hl.dispatch(hl.dsp.submap(\"reset\"))",
    "  end",
    "end",
    "local function disable(handle)",
    "  if type(handle) == \"table\" or type(handle) == \"userdata\" then",
    "    -- A handle whose bind was removed (a config reload, an unbind) is",
    "    -- expired. Hyprland 0.56 dereferences null when any method is called",
    "    -- on one, and pcall cannot catch a segfault; __tostring is the one",
    "    -- accessor that checks the weak reference, so test liveness with it.",
    "    if tostring(handle) == \"HL.Keybind(expired)\" then return end",
    "    pcall(function() handle:set_enabled(false) end)",
    "  end",
    "end",
    "-- A surviving submap from an earlier life is reset before any state",
    "-- is cleared or rebound.",
    "reset_our_submap()",
    "-- Retire exactly the handles this plugin created. Refs may have been",
    "-- cleared by a config reload, so failures are ignored; generic keys",
    "-- are never string-unbound because that would hit foreign binds.",
    "local previous = _G.omission_alt_tab_binds",
    "if type(previous) == \"table\" then",
    "  for index = 1, #previous do",
    "    disable(previous[index])",
    "  end",
    "end",
    "_G.omission_alt_tab_binds = {}",
    "local binds = _G.omission_alt_tab_binds",
    "_G.omission_alt_tab_owner = owner",
    "_G.omission_alt_tab_active = false",
    "local function stop()",
    "  pending_delta = 0",
    "  flush_scheduled = false",
    "  poll_ticks = 0",
    "  _G.omission_alt_tab_active = false",
    "  reset_our_submap()",
    "end",
    "-- Rapid advances coalesce into one signed integer delta so a burst of",
    "-- key presses sends a single bounded IPC call instead of one per key.",
    "local function flush_delta()",
    "  flush_scheduled = false",
    "  if not live() then",
    "    pending_delta = 0",
    "    return",
    "  end",
    "  if pending_delta == 0 then return end",
    "  shell_call(\"advance\", tostring(pending_delta))",
    "  pending_delta = 0",
    "end",
    "local function push_advance(delta)",
    "  if not live() then",
    "    pending_delta = 0",
    "    return",
    "  end",
    "  pending_delta = pending_delta + delta",
    "  if not flush_scheduled then",
    "    flush_scheduled = true",
    "    hl.timer(flush_delta, { timeout = coalesce_ms, type = \"oneshot\" })",
    "  end",
    "end",
    "local function settle(method, apply_pending)",
    "  if not owned() then return end",
    "  local was_active = _G.omission_alt_tab_active == true",
    "  local final_delta = apply_pending and pending_delta or 0",
    "  stop()",
    "  if was_active and method then",
    "    local argument = apply_pending and tostring(final_delta) or \"ignored\"",
    "    hl.timer(function()",
    "      if owned() then shell_call(method, argument) end",
    "    end, { timeout = commit_delay_ms, type = \"oneshot\" })",
    "  end",
    "end",
    "-- Alt release is detected by bounded polling, so no global Alt_L or",
    "-- Alt_R release bind is needed and no modifier bind is shadowed.",
    "local watch_alt",
    "watch_alt = function()",
    "  if not live() then",
    "    poll_ticks = 0",
    "    return",
    "  end",
    "  if not hl.is_key_down(\"Alt_L\") and not hl.is_key_down(\"Alt_R\") then",
    "    settle(\"commit\", true)",
    "    return",
    "  end",
    "  poll_ticks = poll_ticks + 1",
    "  if poll_ticks >= max_poll_ticks then",
    "    settle(\"commit\", true)",
    "    return",
    "  end",
    "  hl.timer(watch_alt, { timeout = poll_ms, type = \"oneshot\" })",
    "end",
    "local function begin(direction)",
    "  if not owned() then return end",
    "  if live() then return end",
    "  pending_delta = 0",
    "  poll_ticks = 0",
    "  _G.omission_alt_tab_active = true",
    "  hl.dispatch(hl.dsp.submap(submap))",
    "  shell_call(\"advance\", tostring(direction))",
    "  hl.timer(watch_alt, { timeout = poll_ms, type = \"oneshot\" })",
    "end",
    "local function track(handle)",
    "  if handle ~= nil then table.insert(binds, handle) end",
    "end",
    "-- Intentionally replace the stock chords so the plugin and the",
    "-- compositor cycle do not both fire; reload restores them.",
    "hl.unbind(\"ALT + TAB\")",
    "hl.unbind(\"ALT + SHIFT + TAB\")",
    "hl.define_submap(submap, function()",
    "  track(hl.bind(\"ALT + TAB\", function()",
    "    if not owned() then return end",
    "    push_advance(1)",
    "  end, { description = \"Alt-Tab: next\" }))",
    "  track(hl.bind(\"ALT + SHIFT + TAB\", function()",
    "    if not owned() then return end",
    "    push_advance(-1)",
    "  end, { description = \"Alt-Tab: previous\" }))",
    "  track(hl.bind(\"LEFT\", function()",
    "    if not owned() then return end",
    "    push_advance(-1)",
    "  end, { description = \"Alt-Tab: previous\" }))",
    "  track(hl.bind(\"RIGHT\", function()",
    "    if not owned() then return end",
    "    push_advance(1)",
    "  end, { description = \"Alt-Tab: next\" }))",
    "  track(hl.bind(\"ESCAPE\", function()",
    "    if not owned() then return end",
    "    settle(\"cancel\", false)",
    "  end, { description = \"Alt-Tab: cancel\" }))",
    "  track(hl.bind(\"RETURN\", function()",
    "    if not owned() then return end",
    "    settle(\"commit\", true)",
    "  end, { description = \"Alt-Tab: select\" }))",
    "end)",
    "track(hl.bind(\"ALT + TAB\", function()",
    "  if not owned() then return end",
    "  begin(1)",
    "end, { description = \"Alt-Tab\" }))",
    "track(hl.bind(\"ALT + SHIFT + TAB\", function()",
    "  if not owned() then return end",
    "  begin(-1)",
    "end, { description = \"Alt-Tab (reverse)\" }))"
  ].join("\n")
}

function generateCleanup(raw) {
  var options = bindingOptions(raw)
  var owner = options.ownerToken
  return [
    "local owner = \"" + owner + "\"",
    "local submap = \"" + SUBMAP + "\"",
    "local function disable(handle)",
    "  if type(handle) == \"table\" or type(handle) == \"userdata\" then",
    "    -- A handle whose bind was removed (a config reload, an unbind) is",
    "    -- expired. Hyprland 0.56 dereferences null when any method is called",
    "    -- on one, and pcall cannot catch a segfault; __tostring is the one",
    "    -- accessor that checks the weak reference, so test liveness with it.",
    "    if tostring(handle) == \"HL.Keybind(expired)\" then return end",
    "    pcall(function() handle:set_enabled(false) end)",
    "  end",
    "end",
    "-- Reset only the plugin submap; an unrelated current submap is left",
    "-- untouched.",
    "if hl.get_current_submap() == submap then",
    "  hl.dispatch(hl.dsp.submap(\"reset\"))",
    "end",
    "-- Disable exactly the tracked plugin handles. Configured bindings",
    "-- were never removed, so nothing foreign is restored or clobbered.",
    "local binds = _G.omission_alt_tab_binds",
    "if type(binds) == \"table\" then",
    "  for index = 1, #binds do",
    "    disable(binds[index])",
    "  end",
    "end",
    "_G.omission_alt_tab_binds = nil",
    "if _G.omission_alt_tab_owner == owner then",
    "  _G.omission_alt_tab_owner = nil",
    "  _G.omission_alt_tab_active = false",
    "  hl.unbind(\"ALT + TAB\")",
    "  hl.unbind(\"ALT + SHIFT + TAB\")",
    "end"
  ].join("\n")
}
