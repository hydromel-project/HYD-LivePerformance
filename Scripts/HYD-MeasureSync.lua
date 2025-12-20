--[[
@description HYD Measure Sync
@version 1.4.0
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
  last_playrate = 1.0,
  waiting_for_measure_end = false,  -- True when countdown done, waiting for measure boundary
  trigger_measure = -1,  -- The measure we're waiting to end
  -- Execution state machine
  exec_phase = nil,  -- nil, "stopped", "waiting_for_precount"
  exec_precount_bars = 0,
  exec_new_rate = 0,  -- The new rate that was set
  waiting_for_precount = false  -- True when stopped and waiting for GameHUD precount to complete
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

-- Check if SWS extension is installed
local function has_sws()
  return reaper.SNM_GetIntConfigVar ~= nil
end

-- Configure count-in length using SWS extension
-- preroll config var is a bitfield, prerollmeas is the length in measures
local function configure_countin(bars)
  if not has_sws() then
    log("WARNING: SWS extension not installed - cannot set count-in length programmatically")
    log("Please install SWS from https://www.sws-extension.org/")
    return false
  end

  -- Get current preroll settings
  local current_preroll = reaper.SNM_GetIntConfigVar("preroll", 0)
  local current_prerollmeas = reaper.SNM_GetDoubleConfigVar("prerollmeas", 0)

  log(string.format("Current preroll settings: bitfield=%d, measures=%.2f", current_preroll, current_prerollmeas))

  -- Set the count-in length in measures
  -- prerollmeas is the number of measures for count-in
  reaper.SNM_SetDoubleConfigVar("prerollmeas", bars)

  -- The preroll bitfield controls various options:
  -- Bit 0 (1): Enable pre-roll before recording
  -- Bit 1 (2): Enable count-in before playback
  -- Bit 2 (4): Enable count-in before recording
  -- We want bit 1 (count-in before playback) enabled
  local new_preroll = current_preroll | 2  -- Set bit 1 (count-in before playback)
  reaper.SNM_SetIntConfigVar("preroll", new_preroll)

  log(string.format("Set count-in: %d bars, preroll bitfield: %d -> %d", bars, current_preroll, new_preroll))

  return true
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
    '{"enabled":%s,"measure":%d,"beat":%.2f,"beatsInMeasure":%d,"countdown":%d,"hasPending":%s,"pendingRate":%.2f,"isExecuting":%s,"waitingForMeasure":%s,"waitingForPrecount":%s,"precountBars":%d,"newRate":%.3f,"playState":%d,"playrate":%.3f,"totalBeats":%d}',
    state.enabled and "true" or "false",
    math.floor(state.current_measure),
    state.current_beat,
    math.floor(state.beats_in_measure),
    state.countdown_beats,
    pending and "true" or "false",
    pending and pending.newRate or 0,
    state.is_executing and "true" or "false",
    state.waiting_for_measure_end and "true" or "false",
    state.waiting_for_precount and "true" or "false",
    state.exec_precount_bars,
    state.exec_new_rate,
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

-- Phase 1: Stop playback and prepare
local function execute_speed_change_stop()
  if not state.pending_change then return end

  state.is_executing = true
  local new_rate = state.pending_change.newRate
  local precount_bars = state.pending_change.preCountBars or 1

  log(string.format("Executing speed change to %.2fx", new_rate))

  -- Step 1: Get current play position and calculate target measure BEFORE stopping
  local play_pos = reaper.GetPlayPosition()
  local beat_in_measure, measures = reaper.TimeMap2_timeToBeats(0, play_pos)
  local current_measure = math.floor(measures)

  -- We want to start at the beginning of the current measure (we just crossed into it)
  local target_measure = current_measure
  local target_time = get_measure_start_time(target_measure)

  log(string.format("Play position: %.2f, Current measure: %d, Target: measure %d",
    play_pos, current_measure, target_measure))

  -- Step 2: Stop playback using direct API call
  reaper.OnStopButton()

  -- Verify stop worked
  local play_state = reaper.GetPlayState()
  log(string.format("Stop command sent. Play state now: %d (0=stopped, 1=playing)", play_state))

  -- If still playing, try harder
  if (play_state & 1) == 1 then
    log("Still playing! Trying Main_OnCommand stop...")
    reaper.Main_OnCommand(1016, 0)
    play_state = reaper.GetPlayState()
    log(string.format("Play state after second stop: %d", play_state))
  end

  -- Step 3: Set new playrate
  reaper.CSurf_OnPlayRateChange(new_rate)
  state.last_playrate = new_rate
  log(string.format("Playrate set to %.2fx", new_rate))

  -- Step 4: Move cursor AND playhead to target measure start
  if target_time then
    reaper.SetEditCurPos(target_time, false, true)
    log(string.format("Cursor and playhead set to measure %d at time %.3f", target_measure, target_time))
  else
    log("Warning: Could not get target measure time")
  end

  -- Clear pending change
  state.pending_change = nil
  state.countdown_beats = 0
  state.waiting_for_measure_end = false
  state.trigger_measure = -1

  -- Set up to wait for GameHUD precount to complete
  -- Bot will detect waitingForPrecount=true and trigger GameHUD audio precount
  -- When GameHUD finishes, bot will send startPlayback command
  state.exec_phase = "waiting_for_precount"
  state.exec_precount_bars = precount_bars
  state.exec_new_rate = new_rate
  state.waiting_for_precount = true

  log("Stopped and waiting for GameHUD audio precount...")
  log(string.format("Bot should start precount: %d bars at new rate %.2fx", precount_bars, new_rate))
end

-- Phase 2: Start playback (called after GameHUD audio precount completes)
local function execute_speed_change_play()
  log("Starting playback after GameHUD precount...")

  -- GameHUD has already played the audio precount, just start playback now
  -- No need for REAPER's count-in since GameHUD handled it
  reaper.Main_OnCommand(1007, 0)  -- Transport: Play
  log(string.format("Playback started at %.2fx!", state.exec_new_rate))

  -- Reset execution state
  state.exec_phase = nil
  state.exec_precount_bars = 0
  state.exec_new_rate = 0
  state.waiting_for_precount = false
  state.is_executing = false

  -- Reset beat tracking
  last_beat_int = -1
  last_measure_int = -1
end

-- Legacy wrapper for immediate execution (used by executeNow command)
local function execute_speed_change()
  execute_speed_change_stop()
  -- For immediate execution, skip the wait and play now
  state.exec_phase = nil
  execute_speed_change_play()
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
    state.waiting_for_measure_end = false
    state.trigger_measure = -1
    log("Measure-sync DISABLED")

  elseif cmd.action == "queue" and cmd.newRate then
    -- Auto-enable when queue is received
    if not state.enabled then
      state.enabled = true
      log("Auto-enabled measure-sync (queue received)")
    end

    local warning_beats = cmd.warningBeats or 4
    state.pending_change = {
      newRate = cmd.newRate,
      warningBeats = warning_beats,
      totalBeats = warning_beats,  -- Store original for progress calculation
      preCountBars = cmd.preCountBars or 1,
      queuedAt = reaper.time_precise()
    }
    state.countdown_beats = warning_beats
    state.waiting_for_measure_end = false
    state.trigger_measure = -1

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
    state.waiting_for_measure_end = false
    state.trigger_measure = -1

  elseif cmd.action == "executeNow" then
    if state.pending_change then
      log("Executing pending change immediately")
      execute_speed_change()
    end

  elseif cmd.action == "startPlayback" then
    -- Bot signals that GameHUD audio precount is complete, start playback now
    if state.waiting_for_precount then
      log("Received startPlayback - GameHUD precount complete")
      execute_speed_change_play()
    else
      log("Received startPlayback but not waiting for precount, ignoring")
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
  local measure_changed = false

  if measure_int ~= last_measure_int then
    -- Measure changed
    measure_changed = true
    beat_changed = true
  elseif beat_int ~= last_beat_int then
    -- Same measure but different beat
    beat_changed = true
  end

  -- If we're waiting for measure end, check for measure boundary
  if state.waiting_for_measure_end then
    if measure_changed and measure_int > state.trigger_measure then
      log(string.format("Measure boundary reached! (measure %d -> %d)", state.trigger_measure, measure_int))
      execute_speed_change_stop()  -- Start the stop phase, play will happen after delay
      return
    end
    -- Still waiting, update tracking
    if beat_changed then
      last_measure_int = measure_int
      last_beat_int = beat_int
    end
    return
  end

  -- Normal countdown phase
  if beat_changed then
    last_measure_int = measure_int
    last_beat_int = beat_int

    -- Decrement countdown
    if state.countdown_beats > 0 then
      state.countdown_beats = state.countdown_beats - 1
      log(string.format("Countdown: %d beats remaining (measure %d, beat %d)",
        state.countdown_beats, measure_int, beat_int))
    end

    -- When countdown complete, start waiting for measure end
    if state.countdown_beats <= 0 and not state.waiting_for_measure_end then
      state.waiting_for_measure_end = true
      state.trigger_measure = measure_int
      log(string.format("Countdown complete! Waiting for measure %d to end...", measure_int))
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

  -- No delay-based execution anymore - we wait for bot's startPlayback command
  -- which comes after GameHUD finishes audio precount

  -- Poll position at high frequency
  if current_time - last_poll_time >= POLL_INTERVAL then
    last_poll_time = current_time

    local is_playing = update_position()

    -- Update countdown if we have a pending change (and not waiting for precount)
    if state.enabled and state.pending_change and not state.waiting_for_precount then
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
  log("Starting HYD Measure Sync v1.4.0")
  log("Command file: " .. command_file)
  log("Status file: " .. status_file)
  log("Audio precount is now handled by GameHUD (Web Audio API)")

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
