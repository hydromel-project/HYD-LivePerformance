--[[
@description HYD Live Performance Server
@version 1.0.1
@author hydromel-project
@about
  # HYD Live Performance Server

  Unified server for live streaming performances in REAPER.

  ## Features
  - **NowPlaying**: Streams current song info (title, artist, album, year, cover art) from SONGS track
  - **Teleprompter**: Streams lyrics blocks from LYRICS track for teleprompter display
  - **Playlist**: Manages song queue, project tabs, and web interface for playlist system

  ## Requirements
  - REAPER 6.0+
  - js_ReaScriptAPI extension
  - ffmpeg in PATH (optional, for cover art)

  ## Setup
  1. Create tracks named LYRICS and/or SONGS
  2. Enable REAPER web server (Preferences > Control/OSC/Web)
  3. Run this script
  4. Open web interfaces in browser
@provides
  [webinterface] ../www/Teleprompter.html
  [webinterface] ../www/NowPlaying.html
  [webinterface] ../www/Playlist.html
@link https://github.com/hydromel-project/HYD-LivePerformance
--]]

-- ============================================================================
-- CONFIGURATION
-- ============================================================================
local www_root = reaper.GetResourcePath() .. "/reaper_www_root"
local temp_dir = (os.getenv("TEMP") or os.getenv("TMP") or www_root):gsub("/", "\\")
local playlists_folder = reaper.GetResourcePath() .. "/Scripts/Playlists"

-- Update intervals (in seconds)
local TELEPROMPTER_INTERVAL = 0.016  -- ~60fps for smooth beat sync
local NOWPLAYING_INTERVAL = 0.1      -- 100ms
local PLAYLIST_INTERVAL = 0.1        -- 100ms

-- Timing
local last_teleprompter_update = 0
local last_nowplaying_update = 0
local last_playlist_update = 0

-- ============================================================================
-- SHARED UTILITIES
-- ============================================================================

-- JSON Escape
local function JsonEscape(str)
  if not str then return "" end
  str = str:gsub('\\', '\\\\')
  str = str:gsub('"', '\\"')
  str = str:gsub('\n', '\\n')
  str = str:gsub('\r', '\\r')
  str = str:gsub('\t', '\\t')
  return str
end

-- Check if file exists
local function FileExists(path)
  local f = io.open(path, "r")
  if f then f:close() return true end
  return false
end

-- Check if file exists and has content
local function FileReady(path)
  local f = io.open(path, "r")
  if f then
    local size = f:seek("end")
    f:close()
    return size and size > 0
  end
  return false
end

-- Delete file
local function DeleteFile(path)
  if path and FileExists(path) then os.remove(path) end
end

-- Get region at position
local function GetRegionAtPos(pos)
  local _, num_markers, num_regions = reaper.CountProjectMarkers(0)
  local total = num_markers + num_regions
  for i = 0, total - 1 do
    local retval, isrgn, rgn_start, rgn_end, name, idx = reaper.EnumProjectMarkers3(0, i)
    if isrgn and pos >= rgn_start and pos < rgn_end then
      return rgn_start, rgn_end, name
    end
  end
  return 0, 0, ""
end

-- Find track by name (case-insensitive)
local function FindTrackByName(name)
  local name_lower = name:lower()
  local count_tracks = reaper.CountTracks(0)
  for i = 0, count_tracks - 1 do
    local track = reaper.GetTrack(0, i)
    local retval, track_name = reaper.GetTrackName(track)
    if track_name:lower() == name_lower then
      return track
    end
  end
  return nil
end

-- Get item at position on track
local function GetItemAtPos(track, pos)
  if not track then return nil end
  local count = reaper.GetTrackNumMediaItems(track)
  for i = 0, count - 1 do
    local item = reaper.GetTrackMediaItem(track, i)
    local item_pos = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
    local item_len = reaper.GetMediaItemInfo_Value(item, "D_LENGTH")
    if pos >= item_pos and pos < item_pos + item_len then
      return item, item_pos, item_pos + item_len
    end
  end
  return nil, 0, 0
end

-- ============================================================================
-- NOWPLAYING MODULE
-- ============================================================================
local NowPlaying = {
  EXT_NAME = "NowPlaying",
  songs_track = nil,
  current_region_name = "",
  last_valid_region = "",
  display_active = false,
  was_playing = false,

  -- Cover extraction state
  EXTRACT_IDLE = 0,
  EXTRACT_COVER = 1,
  EXTRACT_DONE = 2,
  extract_state = 0,
  cover_temp_path = nil,
  cover_filename = nil,
  extract_start_time = 0,
  EXTRACT_TIMEOUT = 5,
  current_cover_path = nil,

  -- Cached song data
  cached = {
    has_song = false,
    title = "",
    artist = "",
    album = "",
    year = "",
    cover = "",
    region_end = 0,
    item_start = 0,
    item_end = 0
  }
}

function NowPlaying:GetSourceFromItem(item)
  if not item then return nil, nil end
  local take = reaper.GetMediaItemTake(item, 0)
  if not take then return nil, nil end
  local source = reaper.GetMediaItemTake_Source(take)
  if not source then return nil, nil end
  local filepath = reaper.GetMediaSourceFileName(source, "")
  return source, filepath
end

function NowPlaying:GetExtension(filepath)
  if not filepath then return nil end
  local ext = filepath:match("%.([^%.]+)$")
  return ext and ext:lower() or nil
end

function NowPlaying:GetMetadataFromSource(source)
  local metadata = { title = "", artist = "", album = "", year = "" }
  if not source then return metadata end

  local _, title = reaper.GetMediaFileMetadata(source, "ID3:TIT2")
  local _, artist = reaper.GetMediaFileMetadata(source, "ID3:TPE1")
  local _, album = reaper.GetMediaFileMetadata(source, "ID3:TALB")
  local _, year = reaper.GetMediaFileMetadata(source, "ID3:TYER")

  if not year or year == "" then _, year = reaper.GetMediaFileMetadata(source, "ID3:TDRC") end
  if not title or title == "" then _, title = reaper.GetMediaFileMetadata(source, "TITLE") end
  if not artist or artist == "" then _, artist = reaper.GetMediaFileMetadata(source, "ARTIST") end
  if not album or album == "" then _, album = reaper.GetMediaFileMetadata(source, "ALBUM") end
  if not year or year == "" then _, year = reaper.GetMediaFileMetadata(source, "DATE") end

  metadata.title = title or ""
  metadata.artist = artist or ""
  metadata.album = album or ""
  if year and year ~= "" then
    local yr = year:match("(%d%d%d%d)")
    metadata.year = yr or ""
  end
  return metadata
end

function NowPlaying:StartCoverExtraction(filepath)
  if not filepath then
    self.extract_state = self.EXTRACT_DONE
    return
  end
  local unique_id = os.time() .. "_" .. math.random(10000, 99999)
  self.cover_filename = "np_cover_" .. unique_id .. ".jpg"
  self.cover_temp_path = www_root:gsub("/", "\\") .. "\\" .. self.cover_filename
  self.extract_start_time = os.time()
  local cmd = 'cmd.exe /c ffmpeg -y -i "' .. filepath .. '" -map 0:v -map -0:V -c copy "' .. self.cover_temp_path .. '" 2>nul'
  reaper.ExecProcess(cmd, -2)
  self.extract_state = self.EXTRACT_COVER
end

function NowPlaying:PollCover()
  if os.time() - self.extract_start_time > self.EXTRACT_TIMEOUT then
    self.extract_state = self.EXTRACT_DONE
    return
  end
  if FileReady(self.cover_temp_path) then
    self.cached.cover = self.cover_filename
    self.current_cover_path = self.cover_temp_path
    self.extract_state = self.EXTRACT_DONE
  end
end

function NowPlaying:FlushCache()
  if self.current_cover_path then
    DeleteFile(self.current_cover_path)
    self.current_cover_path = nil
  end
  self.cached = {
    has_song = false, title = "", artist = "", album = "", year = "",
    cover = "", region_end = 0, item_start = 0, item_end = 0
  }
  self.extract_state = self.EXTRACT_IDLE
  self.cover_filename = nil
  self.cover_temp_path = nil
  self.display_active = false
end

function NowPlaying:ExtractSongData(pos, region_end)
  if not self.songs_track then return false end
  local item = GetItemAtPos(self.songs_track, pos)
  if not item then return false end
  local source, filepath = self:GetSourceFromItem(item)
  if not filepath then return false end
  local ext = self:GetExtension(filepath)
  local item_pos = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
  local item_len = reaper.GetMediaItemInfo_Value(item, "D_LENGTH")

  self.cached.has_song = true
  self.cached.region_end = region_end
  self.cached.item_start = item_pos
  self.cached.item_end = item_pos + item_len

  if ext == "mp3" or ext == "flac" or ext == "ogg" or ext == "m4a" or ext == "wav" then
    local metadata = self:GetMetadataFromSource(source)
    self.cached.title = metadata.title
    self.cached.artist = metadata.artist
    self.cached.album = metadata.album
    self.cached.year = metadata.year
    self:StartCoverExtraction(filepath)
  else
    local fname = filepath:match("([^/\\]+)$") or ""
    self.cached.title = fname:gsub("%.[^%.]+$", "")
    self.extract_state = self.EXTRACT_DONE
  end

  if self.cached.title == "" then
    local fname = filepath:match("([^/\\]+)$") or "Unknown"
    self.cached.title = fname:gsub("%.[^%.]+$", "")
  end
  return true
end

function NowPlaying:Update(cur_pos, is_playing, region_start, region_end, region_name)
  -- Validate track
  if not reaper.ValidatePtr(self.songs_track, "MediaTrack*") then
    self.songs_track = FindTrackByName("SONGS")
  end
  if not self.songs_track then return end

  -- Region change detection
  if region_name ~= "" then
    if region_name ~= self.last_valid_region then
      self:FlushCache()
      self.last_valid_region = region_name
      self.current_region_name = region_name
    else
      self.current_region_name = region_name
    end
  else
    self.current_region_name = ""
  end

  -- Poll cover extraction
  if self.extract_state == self.EXTRACT_COVER then self:PollCover() end

  -- Extract song data if needed
  if region_name ~= "" and self.extract_state == self.EXTRACT_IDLE then
    self:ExtractSongData(cur_pos, region_end)
  end

  -- Display state
  if self.cached.has_song and is_playing and not self.display_active then
    self.display_active = true
  end
  if is_playing and not self.was_playing and self.cached.has_song then
    self.display_active = true
  end

  local time_remaining = 0
  if self.cached.region_end > 0 then
    time_remaining = math.max(0, self.cached.region_end - cur_pos)
  end
  self.was_playing = is_playing

  -- Send JSON
  local json = string.format(
    '{"hs":%s,"t":"%s","a":"%s","al":"%s","y":"%s","c":"%s","rn":"%s","d":%s,"tr":%.2f,"pp":%.3f,"is":%.3f,"ie":%.3f}',
    self.cached.has_song and "true" or "false",
    JsonEscape(self.cached.title), JsonEscape(self.cached.artist),
    JsonEscape(self.cached.album), JsonEscape(self.cached.year),
    JsonEscape(self.cached.cover), JsonEscape(region_name),
    self.display_active and "true" or "false",
    time_remaining, cur_pos, self.cached.item_start, self.cached.item_end
  )
  reaper.SetProjExtState(0, self.EXT_NAME, "data", json)
end

function NowPlaying:Exit()
  self:FlushCache()
  reaper.SetProjExtState(0, self.EXT_NAME, "data", "")
end

-- ============================================================================
-- TELEPROMPTER MODULE
-- ============================================================================
local Teleprompter = {
  EXT_NAME = "Teleprompter",
  lyrics_track = nil
}

function Teleprompter:GetItemNotes(item)
  if not item then return "" end
  local retval, notes = reaper.GetSetMediaItemInfo_String(item, "P_NOTES", "", false)
  return notes or ""
end

function Teleprompter:GetNextItems(track, pos, count)
  local items = {}
  local total = reaper.GetTrackNumMediaItems(track)
  for i = 0, total - 1 do
    local item = reaper.GetTrackMediaItem(track, i)
    local item_pos = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
    if item_pos > pos then
      local item_len = reaper.GetMediaItemInfo_Value(item, "D_LENGTH")
      table.insert(items, { item = item, start_pos = item_pos, end_pos = item_pos + item_len })
      if #items >= count then break end
    end
  end
  return items
end

function Teleprompter:EscapeText(text)
  if not text or text == "" then return "" end
  text = text:gsub("\r\n", "<br>")
  text = text:gsub("\n", "<br>")
  text = text:gsub("\r", "<br>")
  return text
end

function Teleprompter:Update(cur_pos, region_start, region_end, region_name)
  -- Validate track
  if not reaper.ValidatePtr(self.lyrics_track, "MediaTrack*") then
    self.lyrics_track = FindTrackByName("LYRICS")
  end

  local timesig_num, timesig_denom, tempo = reaper.TimeMap_GetTimeSigAtTime(0, cur_pos)
  local beat_in_measure = reaper.TimeMap2_timeToBeats(0, cur_pos)

  local current_text, current_end = "", 0
  local next1_text, next1_start, next1_end = "", 0, 0
  local next2_text, next2_start = "", 0

  if self.lyrics_track then
    local current_item, _, cur_end = GetItemAtPos(self.lyrics_track, cur_pos)
    current_text = self:EscapeText(self:GetItemNotes(current_item))
    current_end = cur_end

    local next_items = self:GetNextItems(self.lyrics_track, cur_pos, 2)
    if next_items[1] then
      next1_text = self:EscapeText(self:GetItemNotes(next_items[1].item))
      next1_start = next_items[1].start_pos
      next1_end = next_items[1].end_pos
    end
    if next_items[2] then
      next2_text = self:EscapeText(self:GetItemNotes(next_items[2].item))
      next2_start = next_items[2].start_pos
    end
  end

  local json = string.format(
    '{"cur":"%s","n1":"%s","n2":"%s","pp":%.3f,"ce":%.3f,"n1s":%.3f,"n1e":%.3f,"n2s":%.3f,"ts":"%d/%d","b":%d,"bp":%.3f,"rs":%.3f,"re":%.3f,"rn":"%s","bpm":%.1f}',
    JsonEscape(current_text), JsonEscape(next1_text), JsonEscape(next2_text),
    cur_pos, current_end, next1_start, next1_end, next2_start,
    timesig_num, timesig_denom,
    math.floor(beat_in_measure) + 1, beat_in_measure % 1,
    region_start, region_end, JsonEscape(region_name), tempo
  )
  reaper.SetProjExtState(0, self.EXT_NAME, "data", json)
end

function Teleprompter:Exit()
  reaper.SetProjExtState(0, self.EXT_NAME, "data", "")
end

-- ============================================================================
-- PLAYLIST MODULE
-- ============================================================================
local Playlist = {
  EXT_NAME = "Playlist",
  master_project = nil,
  master_project_path = "",
  songs_index = {},
  queue = {},
  current_queue_pos = 0,

  ACTION_NEW_PROJECT_TAB = 40859,
  ACTION_CLOSE_PROJECT = 40860,
  ACTION_PLAY = 1007,
  ACTION_STOP = 1016
}

function Playlist:LoadSongsIndex()
  local filepath = www_root .. "/songs_index.json"
  local file = io.open(filepath, "r")
  if not file then return false end
  local content = file:read("*all")
  file:close()
  self.songs_index = {}
  for id, artist, title, filename in content:gmatch('"id":"([^"]*)"[^}]*"a":"([^"]*)"[^}]*"t":"([^"]*)"[^}]*"f":"([^"]*)"') do
    table.insert(self.songs_index, { id = id, artist = artist, title = title, file = filename })
  end
  return #self.songs_index > 0
end

function Playlist:GetSongsFolder()
  return reaper.GetExtState(self.EXT_NAME, "songs_folder")
end

function Playlist:FindSongById(id)
  for _, song in ipairs(self.songs_index) do
    if song.id == id then return song end
  end
  return nil
end

function Playlist:GetProjectByPath(path)
  local i = 0
  while true do
    local proj, projfn = reaper.EnumProjects(i)
    if not proj then break end
    if projfn and projfn:lower() == path:lower() then return proj end
    i = i + 1
  end
  return nil
end

function Playlist:IsProjectReady(proj)
  if not proj or not reaper.ValidatePtr(proj, "ReaProject*") then return false end
  return reaper.GetProjectStateChangeCount(proj) ~= nil
end

function Playlist:IsProjectPlaying(proj)
  if not proj or not reaper.ValidatePtr(proj, "ReaProject*") then return false end
  return (reaper.GetPlayStateEx(proj) & 1) == 1
end

function Playlist:LoadSongProject(queueIndex)
  if queueIndex < 1 or queueIndex > #self.queue then return false end
  local item = self.queue[queueIndex]
  if item.ready or item.loading then return false end
  local folder = self:GetSongsFolder()
  if folder == "" then return false end
  local filepath = folder .. "/" .. item.file
  if not FileExists(filepath) then return false end

  item.loading = true
  reaper.Main_OnCommand(self.ACTION_NEW_PROJECT_TAB, 0)
  reaper.Main_openProject("noprompt:" .. filepath)
  reaper.SetEditCurPos(0, false, false)

  if self.master_project and reaper.ValidatePtr(self.master_project, "ReaProject*") then
    reaper.SelectProjectInstance(self.master_project)
  end
  return true
end

function Playlist:AddToQueue(songId)
  local song = self:FindSongById(songId)
  if not song then return false end
  for _, item in ipairs(self.queue) do
    if item.id == songId then return false end
  end
  table.insert(self.queue, {
    id = song.id, artist = song.artist, title = song.title, file = song.file,
    proj = nil, ready = false, loading = false
  })
  self:LoadSongProject(#self.queue)
  return true
end

function Playlist:RemoveFromQueue(index)
  if index < 1 or index > #self.queue then return false end
  local item = self.queue[index]
  if item.proj and reaper.ValidatePtr(item.proj, "ReaProject*") then
    local current = reaper.EnumProjects(-1)
    reaper.SelectProjectInstance(item.proj)
    reaper.Main_OnCommand(self.ACTION_CLOSE_PROJECT, 0)
    if current and reaper.ValidatePtr(current, "ReaProject*") and current ~= item.proj then
      reaper.SelectProjectInstance(current)
    end
  end
  table.remove(self.queue, index)
  if self.current_queue_pos >= index then
    self.current_queue_pos = math.max(0, self.current_queue_pos - 1)
  end
  return true
end

function Playlist:MoveQueueItem(fromIndex, toIndex)
  if fromIndex < 1 or fromIndex > #self.queue or toIndex < 1 or toIndex > #self.queue then return false end
  if fromIndex == toIndex then return true end
  local item = table.remove(self.queue, fromIndex)
  table.insert(self.queue, toIndex, item)
  if self.current_queue_pos == fromIndex then
    self.current_queue_pos = toIndex
  elseif fromIndex < self.current_queue_pos and toIndex >= self.current_queue_pos then
    self.current_queue_pos = self.current_queue_pos - 1
  elseif fromIndex > self.current_queue_pos and toIndex <= self.current_queue_pos then
    self.current_queue_pos = self.current_queue_pos + 1
  end
  return true
end

function Playlist:UpdateLoadingProjects()
  local folder = self:GetSongsFolder()
  if folder == "" then return end
  for _, item in ipairs(self.queue) do
    if item.loading and not item.ready then
      local proj = self:GetProjectByPath(folder .. "/" .. item.file)
      if proj and self:IsProjectReady(proj) then
        item.proj = proj
        item.ready = true
        item.loading = false
      end
    end
  end
end

function Playlist:SwitchToSong(queueIndex)
  if queueIndex < 1 or queueIndex > #self.queue then return false end
  local item = self.queue[queueIndex]
  if not item.ready then
    self:LoadSongProject(queueIndex)
    return false
  end
  if item.proj and reaper.ValidatePtr(item.proj, "ReaProject*") then
    reaper.SelectProjectInstance(item.proj)
    self.current_queue_pos = queueIndex
    return true
  end
  return false
end

function Playlist:PlaySong(queueIndex)
  if queueIndex < 1 or queueIndex > #self.queue then return false end
  local item = self.queue[queueIndex]
  if not item.ready then
    self:LoadSongProject(queueIndex)
    return false
  end
  if item.proj and reaper.ValidatePtr(item.proj, "ReaProject*") then
    for i, other in ipairs(self.queue) do
      if i ~= queueIndex and other.proj and reaper.ValidatePtr(other.proj, "ReaProject*") then
        reaper.Main_OnCommandEx(self.ACTION_STOP, 0, other.proj)
      end
    end
    reaper.SelectProjectInstance(item.proj)
    self.current_queue_pos = queueIndex
    reaper.Main_OnCommandEx(self.ACTION_PLAY, 0, item.proj)
    return true
  end
  return false
end

function Playlist:StopSong(queueIndex)
  if queueIndex < 1 or queueIndex > #self.queue then return false end
  local item = self.queue[queueIndex]
  if item.proj and reaper.ValidatePtr(item.proj, "ReaProject*") then
    reaper.Main_OnCommandEx(self.ACTION_STOP, 0, item.proj)
    return true
  end
  return false
end

function Playlist:SwitchToMaster()
  if self.master_project and reaper.ValidatePtr(self.master_project, "ReaProject*") then
    reaper.SelectProjectInstance(self.master_project)
    return true
  end
  return false
end

function Playlist:StopAndGoToMaster()
  if self.master_project and reaper.ValidatePtr(self.master_project, "ReaProject*") then
    for _, item in ipairs(self.queue) do
      if item.proj and reaper.ValidatePtr(item.proj, "ReaProject*") then
        reaper.Main_OnCommandEx(self.ACTION_STOP, 0, item.proj)
      end
    end
    reaper.SelectProjectInstance(self.master_project)
    return true
  end
  return false
end

function Playlist:CloseCurrentAndAdvance()
  if self.current_queue_pos < 1 or self.current_queue_pos > #self.queue then
    return self:SwitchToMaster()
  end
  self:SwitchToMaster()
  self:RemoveFromQueue(self.current_queue_pos)
  return true
end

function Playlist:PlayNext()
  local nextPos = self.current_queue_pos + 1
  if nextPos <= #self.queue then return self:SwitchToSong(nextPos) end
  return false
end

function Playlist:EnsurePlaylistsFolder()
  reaper.RecursiveCreateDirectory(playlists_folder, 0)
end

function Playlist:SavePlaylist(name)
  if not name or name == "" then return false end
  self:EnsurePlaylistsFolder()
  local file = io.open(playlists_folder .. "/" .. name .. ".txt", "w")
  if not file then return false end
  for _, item in ipairs(self.queue) do file:write(item.id .. "\n") end
  file:close()
  return true
end

function Playlist:LoadPlaylist(name)
  if not name or name == "" then return false end
  local file = io.open(playlists_folder .. "/" .. name .. ".txt", "r")
  if not file then return false end
  while #self.queue > 0 do self:RemoveFromQueue(1) end
  self.current_queue_pos = 0
  for line in file:lines() do
    local id = line:match("^%s*(.-)%s*$")
    if id and id ~= "" then self:AddToQueue(id) end
  end
  file:close()
  return true
end

function Playlist:GetPlaylistsList()
  self:EnsurePlaylistsFolder()
  local playlists = {}
  local i = 0
  while true do
    local filename = reaper.EnumerateFiles(playlists_folder, i)
    if not filename then break end
    if filename:match("%.txt$") then
      table.insert(playlists, (filename:gsub("%.txt$", "")))
    end
    i = i + 1
  end
  return playlists
end

function Playlist:ProcessCommands()
  local cmd = reaper.GetExtState(self.EXT_NAME, "command")
  if cmd == "" then return end
  reaper.SetExtState(self.EXT_NAME, "command", "", false)

  local action, param = cmd:match("^(%w+):?(.*)$")

  if action == "add" and param ~= "" then self:AddToQueue(param)
  elseif action == "remove" and param ~= "" then self:RemoveFromQueue(tonumber(param) or 0)
  elseif action == "play" and param ~= "" then self:SwitchToSong(tonumber(param) or 0)
  elseif action == "playnow" and param ~= "" then
    local song = self:FindSongById(param)
    if song then
      table.insert(self.queue, 1, {
        id = song.id, artist = song.artist, title = song.title, file = song.file,
        proj = nil, ready = false, loading = false
      })
      self.current_queue_pos = 0
      self:SwitchToSong(1)
    end
  elseif action == "playsong" and param ~= "" then self:PlaySong(tonumber(param) or 0)
  elseif action == "stopsong" and param ~= "" then self:StopSong(tonumber(param) or 0)
  elseif action == "switch" and param ~= "" then self:SwitchToSong(tonumber(param) or 0)
  elseif action == "master" then self:StopAndGoToMaster()
  elseif action == "next" then self:PlayNext()
  elseif action == "closenext" then self:CloseCurrentAndAdvance()
  elseif action == "move" then
    local from, to = param:match("(%d+),(%d+)")
    if from and to then self:MoveQueueItem(tonumber(from), tonumber(to)) end
  elseif action == "clear" then
    while #self.queue > 0 do self:RemoveFromQueue(1) end
    self.current_queue_pos = 0
  elseif action == "reindex" then self:LoadSongsIndex()
  elseif action == "save" and param ~= "" then self:SavePlaylist(param)
  elseif action == "load" and param ~= "" then self:LoadPlaylist(param)
  end
end

function Playlist:BuildStateJson()
  local queueJson = {}
  for i, item in ipairs(self.queue) do
    local is_playing = item.proj and self:IsProjectPlaying(item.proj) or false
    table.insert(queueJson, string.format(
      '{"id":"%s","a":"%s","t":"%s","r":%s,"c":%s,"l":%s,"p":%s}',
      JsonEscape(item.id), JsonEscape(item.artist), JsonEscape(item.title),
      item.ready and "true" or "false",
      (i == self.current_queue_pos) and "true" or "false",
      item.loading and "true" or "false",
      is_playing and "true" or "false"
    ))
  end

  local current_proj = reaper.EnumProjects(-1)
  local master_active = (current_proj == self.master_project)
  local current_song = self.queue[self.current_queue_pos]
  local next_song = self.queue[self.current_queue_pos + 1]

  local playlists = self:GetPlaylistsList()
  local playlistsJson = {}
  for _, name in ipairs(playlists) do
    table.insert(playlistsJson, '"' .. JsonEscape(name) .. '"')
  end

  return string.format(
    '{"q":[%s],"qp":%d,"ql":%d,"ma":%s,"cs":%s,"ns":%s,"si":%d,"pl":[%s]}',
    table.concat(queueJson, ","), self.current_queue_pos, #self.queue,
    master_active and "true" or "false",
    current_song and string.format('{"a":"%s","t":"%s"}', JsonEscape(current_song.artist), JsonEscape(current_song.title)) or "null",
    next_song and string.format('{"a":"%s","t":"%s"}', JsonEscape(next_song.artist), JsonEscape(next_song.title)) or "null",
    #self.songs_index, table.concat(playlistsJson, ",")
  )
end

function Playlist:Update()
  self:ProcessCommands()
  self:UpdateLoadingProjects()
  local json = self:BuildStateJson()
  reaper.SetProjExtState(0, self.EXT_NAME, "data", json)
end

function Playlist:Init()
  self.master_project = reaper.EnumProjects(-1)
  if self.master_project then
    local _, path = reaper.EnumProjects(-1)
    self.master_project_path = path or ""
  end
  if not self:LoadSongsIndex() then
    local result = reaper.MB(
      "Song index not found or empty.\n\nWould you like to run the indexer now?",
      "Live Performance Server", 4
    )
    if result == 6 then
      local script_path = reaper.GetResourcePath() .. "/Scripts/Playlist_IndexSongs.lua"
      if FileExists(script_path) then
        reaper.Main_OnCommand(reaper.NamedCommandLookup("_RS" .. script_path), 0)
      end
    end
  end
end

function Playlist:Exit()
  reaper.SetProjExtState(0, self.EXT_NAME, "data", "")
  reaper.SetExtState(self.EXT_NAME, "command", "", false)
end

-- ============================================================================
-- MAIN LOOP
-- ============================================================================
local function SetButtonState(set)
  local is_new_value, filename, sec, cmd, mode, resolution, val = reaper.get_action_context()
  reaper.SetToggleCommandState(sec, cmd, set or 0)
  reaper.RefreshToolbar2(sec, cmd)
end

local function Exit()
  NowPlaying:Exit()
  Teleprompter:Exit()
  Playlist:Exit()
  SetButtonState(0)
end

local function Main()
  local current_time = reaper.time_precise()

  -- Get shared state
  local play_state = reaper.GetPlayState()
  local is_playing = (play_state & 1) == 1
  local is_paused = (play_state & 2) == 2
  local cur_pos = (is_playing or is_paused) and reaper.GetPlayPosition() or reaper.GetCursorPosition()
  local region_start, region_end, region_name = GetRegionAtPos(cur_pos)

  -- Teleprompter (highest frequency - 60fps)
  if current_time - last_teleprompter_update >= TELEPROMPTER_INTERVAL then
    last_teleprompter_update = current_time
    Teleprompter:Update(cur_pos, region_start, region_end, region_name)
  end

  -- NowPlaying (100ms)
  if current_time - last_nowplaying_update >= NOWPLAYING_INTERVAL then
    last_nowplaying_update = current_time
    NowPlaying:Update(cur_pos, is_playing, region_start, region_end, region_name)
  end

  -- Playlist (100ms)
  if current_time - last_playlist_update >= PLAYLIST_INTERVAL then
    last_playlist_update = current_time
    Playlist:Update()
  end

  reaper.defer(Main)
end

-- ============================================================================
-- INITIALIZATION
-- ============================================================================

-- Create a track with given name
local function CreateTrack(name)
  reaper.InsertTrackAtIndex(reaper.CountTracks(0), true)
  local track = reaper.GetTrack(0, reaper.CountTracks(0) - 1)
  reaper.GetSetMediaTrackInfo_String(track, "P_NAME", name, true)
  return track
end

-- Scaffold missing tracks
local function ScaffoldSession()
  local lyrics_track = FindTrackByName("LYRICS")
  local songs_track = FindTrackByName("SONGS")

  if lyrics_track and songs_track then
    return true  -- All tracks exist
  end

  -- Build message about what's missing
  local missing = {}
  if not lyrics_track then table.insert(missing, "LYRICS") end
  if not songs_track then table.insert(missing, "SONGS") end

  local msg = "Missing tracks: " .. table.concat(missing, ", ") .. "\n\n"
  msg = msg .. "Create them now?"

  local result = reaper.MB(msg, "HYD Live Performance", 4)  -- Yes/No

  if result == 6 then  -- Yes
    reaper.Undo_BeginBlock()

    if not lyrics_track then
      CreateTrack("LYRICS")
    end
    if not songs_track then
      CreateTrack("SONGS")
    end

    reaper.Undo_EndBlock("Create HYD Live Performance tracks", -1)
    reaper.TrackList_AdjustWindows(false)
    return true
  end

  return true  -- Continue anyway even if user said no
end

local function Init()
  math.randomseed(os.time())

  -- Check for required tracks and offer to scaffold
  ScaffoldSession()

  -- Initialize modules
  NowPlaying.songs_track = FindTrackByName("SONGS")
  Teleprompter.lyrics_track = FindTrackByName("LYRICS")
  Playlist:Init()

  -- Start
  SetButtonState(1)
  Main()
  reaper.atexit(Exit)
end

Init()
