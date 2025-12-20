--[[
@description HYD Measure Sync
@version 1.1.0
@author hydromel-project
@about
  # HYD Measure Sync

  Provides measure-aware speed changes for the HYD Live Performance bot.
  Speed changes wait for measure end, then stop, pre-count, and resume.

  ## Features
  - Monitors current measure/beat position
  - Queues speed changes with configurable warning beats
  - Stops at measure end, enables metronome pre-count, resumes at new speed
  - Communicates with bot via JSON files

  ## Requirements
  - REAPER 6.0+
  - HYD Live Performance bot running

@link https://github.com/hydromel-project/HYD-LivePerformance
--]]

-- ============================================================================
-- CONFIGURATION
-- ============================================================================
local POLL_INTERVAL = 0.033  -- ~30fps for smooth tracking
local COMMAND_CHECK_INTERVAL = 0.05  -- Check for commands every 50ms
local DEBUG = true  -- Set to false to disable console output

-- File paths for bot communication
local resource_path = reaper.GetResourcePath()
local command_file = resource_path .. "/Scripts/HYD-LivePerformance/measureSync_command.json"
local status_file = resource_path .. "/Scripts/HYD-LivePerformance/measureSync_status.json"

-- State
local last_poll_time = 0
local last_command_check = 0
local last_beat_int = -1
local last_measure_int = -1

local state = {
  enabled = false,  -- Start disabled, wait for bot to enable
  pending_change = nil,  -- {newRate, warningBeats, preCountBars, queuedAt, totalBeats}
  countdown_beats = 0,
  current_measure = 0,
  current_beat = 0,
  beats_in_measure = 4,
  is_executing = false,
  last_playrate = 1.0
}

-- ============================================================================
-- UTILITIES
-- ============================================================================

local function log(msg)
  if DEBUG then
    reaper.ShowConsoleMsg("[MeasureSync] " .. msg .. "\n")
  end
end

local function file_exists(path)
  local f = io.open(path, "r")
  if f then f:close() return true end
  return false
end

local function read_file(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local content = f:read("*all")
  f:close()
  return content
end

local function write_file(path, content)
  local f = io.open(path, "w")
  if not f then return false end
  f:write(content)
  f:close()
  return true
end

local function delete_file(path)
  if file_exists(path) then
    os.remove(path)
  end
end

-- Simple JSON parser for our specific format
local function parse_command(json)
  if not json or json == "" then return nil end

  local cmd = {}
  cmd.action = json:match('"action"%s*:%s*"([^"]*)"')
  cmd.newRate = tonumber(json:match('"newRate"%s*:%s*([%d%.%-]+)'))
  cmd.warningBeats = tonumber(json:match('"warningBeats"%s*:%s*([%d]+)'))
  cmd.preCountBars = tonumber(json:match('"preCountBars"%s*:%s*([%d]+)'))

  return cmd
end

-- Build status JSON
local function build_status_json()
  local pending = state.pending_change
  local current_playrate = reaper.Master_GetPlayRate(0)

  return string.format(
    '{"enabled":%s,"measure":%d,"beat":%.2f,"beatsInMeasure":%d,"countdown":%d,"hasPending":%s,"pendingRate":%.2f,"isExecuting":%s,"playState":%d,"playrate":%.3f,"totalBeats":%d}',
    state.enabled and "true" or "false",
    math.floor(state.current_measure),
    state.current_beat,
    math.floor(state.beats_in_measure),
    state.countdown_beats,
    pending and "true" or "false",
    pending and pending.newRate or 0,
    state.is_executing and "true" or "false",
    reaper.GetPlayState(),
    current_playrate,
    pending and pending.totalBeats or 0
  )
end

-- ============================================================================
-- MEASURE/BEAT TRACKING
-- ============================================================================

local function update_position()
  local play_state = reaper.GetPlayState()
  local is_playing = (play_state & 1) == 1

  local pos
  if is_playing then
    pos = reaper.GetPlayPosition()
  else
    pos = reaper.GetCursorPosition()
  end

  -- Get measure and beat info
  -- TimeMap2_timeToBeats returns:
  --   retval (beat within measure 0-based),
  --   measures (measure number, can be fractional),
  --   cml (beats per measure based on time sig),
  --   fullbeats (total beats from project start),
  --   cdenom (time sig denominator)
  local beat_in_measure, measures, cml, fullbeats, cdenom = reaper.TimeMap2_timeToBeats(0, pos)

  state.current_measure = measures or 0
  state.current_beat = beat_in_measure or 0
  state.beats_in_measure = cml or 4

  return is_playing
end

-- Get the start time of a specific measure
local function get_measure_start_time(measure_num)
  -- Use TimeMap_GetMeasureInfo to get measure boundaries
  -- Returns: retval, qn_start, qn_end, timesig_num, timesig_denom, tempo
  local retval, qn_start, qn_end, ts_num, ts_denom, tempo = reaper.TimeMap_GetMeasureInfo(0, math.floor(measure_num))

  if retval then
    -- Convert quarter-note position to time
    return reaper.TimeMap2_QNToTime(0, qn_start)
  end

  -- Fallback: estimate based on current position
  return nil
end

-- ============================================================================
-- SPEED CHANGE EXECUTION
-- ============================================================================

local function execute_speed_change()
  if not state.pending_change then return end

  state.is_executing = true
  local new_rate = state.pending_change.newRate
  local precount_bars = state.pending_change.preCountBars or 1

  log(string.format("Executing speed change to %.2fx", new_rate))

  -- Step 1: Stop playback
  reaper.Main_OnCommand(1016, 0)  -- Transport: Stop

  -- Small delay to ensure stop is processed
  -- (handled by defer, state.is_executing prevents re-entry)

  -- Step 2: Set new playrate using CSurf_OnPlayRateChange
  -- This function takes the absolute playrate value
  reaper.CSurf_OnPlayRateChange(new_rate)
  state.last_playrate = new_rate

  log(string.format("Playrate set to %.2fx", new_rate))

  -- Step 3: Get next measure start position and seek there
  local cur_pos = reaper.GetCursorPosition()
  local beat_in_measure, measures = reaper.TimeMap2_timeToBeats(0, cur_pos)
  local next_measure = math.floor(measures) + 1

  -- Get the time of the next measure start
  local next_measure_time = get_measure_start_time(next_measure)

  if next_measure_time then
    -- Seek to next measure
    reaper.SetEditCurPos(next_measure_time, false, false)
    log(string.format("Seeked to measure %d at time %.2f", next_measure, next_measure_time))
  else
    log("Warning: Could not get next measure time, staying at current position")
  end

  -- Step 4: Enable pre-count if configured
  if precount_bars > 0 then
    -- Check current count-in state
    local count_in_state = reaper.GetToggleCommandState(40495)
    if count_in_state ~= 1 then
      reaper.Main_OnCommand(40495, 0)  -- Toggle count-in on
      log("Enabled count-in")
    end

    -- Note: Count-in length is set in REAPER preferences
    -- We can't easily change it programmatically without project manipulation
  end

  -- Step 5: Start playback
  reaper.Main_OnCommand(1007, 0)  -- Transport: Play
  log("Playback started")

  -- Clear pending change
  state.pending_change = nil
  state.countdown_beats = 0
  state.is_executing = false

  -- Reset beat tracking
  last_beat_int = -1
  last_measure_int = -1
end

-- ============================================================================
-- COMMAND PROCESSING
-- ============================================================================

local function process_commands()
  if not file_exists(command_file) then return end

  local content = read_file(command_file)
  delete_file(command_file)  -- Delete after reading

  if not content or content == "" then return end

  local cmd = parse_command(content)
  if not cmd or not cmd.action then return end

  log("Received command: " .. cmd.action)

  if cmd.action == "enable" then
    state.enabled = true
    log("Measure-sync ENABLED")

  elseif cmd.action == "disable" then
    state.enabled = false
    state.pending_change = nil
    state.countdown_beats = 0
    log("Measure-sync DISABLED")

  elseif cmd.action == "queue" and cmd.newRate then
    local warning_beats = cmd.warningBeats or 4
    state.pending_change = {
      newRate = cmd.newRate,
      warningBeats = warning_beats,
      totalBeats = warning_beats,  -- Store original for progress calculation
      preCountBars = cmd.preCountBars or 1,
      queuedAt = reaper.time_precise()
    }
    state.countdown_beats = warning_beats

    -- Reset beat tracking to ensure we catch the next beat
    last_beat_int = -1
    last_measure_int = -1

    log(string.format("Queued speed change to %.2fx in %d beats", cmd.newRate, warning_beats))

  elseif cmd.action == "cancel" then
    if state.pending_change then
      log("Cancelled pending speed change")
    end
    state.pending_change = nil
    state.countdown_beats = 0

  elseif cmd.action == "executeNow" then
    if state.pending_change then
      log("Executing pending change immediately")
      execute_speed_change()
    end
  end
end

-- ============================================================================
-- COUNTDOWN LOGIC
-- ============================================================================

local function update_countdown(is_playing)
  if not state.pending_change or not is_playing or state.is_executing then
    return
  end

  local beat_int = math.floor(state.current_beat)
  local measure_int = math.floor(state.current_measure)

  -- Detect beat change (new beat started)
  local beat_changed = false

  if measure_int ~= last_measure_int then
    -- Measure changed - definitely a beat change
    beat_changed = true
  elseif beat_int ~= last_beat_int then
    -- Same measure but different beat
    beat_changed = true
  end

  if beat_changed then
    last_measure_int = measure_int
    last_beat_int = beat_int

    -- Decrement countdown
    if state.countdown_beats > 0 then
      state.countdown_beats = state.countdown_beats - 1
      log(string.format("Countdown: %d beats remaining (measure %d, beat %d)",
        state.countdown_beats, measure_int, beat_int))
    end

    -- Check if we should execute
    -- Execute when countdown reaches 0 AND we're at the start of a beat
    if state.countdown_beats <= 0 then
      log("Countdown complete, executing speed change")
      execute_speed_change()
    end
  end
end

-- ============================================================================
-- MAIN LOOP
-- ============================================================================

local function SetButtonState(set)
  local is_new_value, filename, sec, cmd, mode, resolution, val = reaper.get_action_context()
  if sec and cmd then
    reaper.SetToggleCommandState(sec, cmd, set or 0)
    reaper.RefreshToolbar2(sec, cmd)
  end
end

local function Exit()
  log("Shutting down...")
  -- Write final status
  write_file(status_file, '{"enabled":false,"shutdown":true}')
  SetButtonState(0)
end

local function Main()
  local current_time = reaper.time_precise()

  -- Poll position at high frequency
  if current_time - last_poll_time >= POLL_INTERVAL then
    last_poll_time = current_time

    local is_playing = update_position()

    -- Update countdown if we have a pending change
    if state.enabled and state.pending_change then
      update_countdown(is_playing)
    end

    -- Write status for bot to read
    write_file(status_file, build_status_json())
  end

  -- Check for commands more frequently
  if current_time - last_command_check >= COMMAND_CHECK_INTERVAL then
    last_command_check = current_time
    process_commands()
  end

  reaper.defer(Main)
end

local function Init()
  log("Starting HYD Measure Sync v1.1.0")
  log("Command file: " .. command_file)
  log("Status file: " .. status_file)

  -- Clean up any old command file
  delete_file(command_file)

  -- Write initial status (disabled, waiting for bot)
  state.enabled = false
  write_file(status_file, build_status_json())

  log("Waiting for bot to enable measure-sync...")

  -- Start
  SetButtonState(1)
  Main()
  reaper.atexit(Exit)
end

Init()
