--[[
 * ReaScript Name: Playlist Index Songs
 * Description: Scans songs folder for .RPP files and generates a searchable JSON index
 * Author: hydromel-project
 * Version: 1.0
--]]

-- CONFIGURATION
local EXT_NAME = "Playlist"
local www_root = reaper.GetResourcePath() .. "/reaper_www_root"

-- Get songs folder from ExtState or prompt user
local function GetSongsFolder()
  local folder = reaper.GetExtState(EXT_NAME, "songs_folder")
  if folder == "" then
    -- Prompt user to select folder
    local retval, path = reaper.JS_Dialog_BrowseForFolder("Select folder containing song .RPP files", "")
    if retval == 1 and path ~= "" then
      reaper.SetExtState(EXT_NAME, "songs_folder", path, true)  -- persist
      return path
    end
    return nil
  end
  return folder
end

-- Generate URL-friendly ID from artist and title
local function GenerateId(artist, title)
  local id = (artist .. "-" .. title):lower()
  -- Replace spaces and special chars with hyphens
  id = id:gsub("%s+", "-")
  id = id:gsub("[^%w%-]", "")
  -- Remove multiple consecutive hyphens
  id = id:gsub("%-+", "-")
  -- Remove leading/trailing hyphens
  id = id:gsub("^%-+", ""):gsub("%-+$", "")
  return id
end

-- Parse filename "Artist - Title.rpp" format
local function ParseFilename(filename)
  -- Remove .rpp extension
  local name = filename:gsub("%.rpp$", ""):gsub("%.RPP$", "")

  -- Split on " - " (artist - title)
  local artist, title = name:match("^(.-)%s*%-%s*(.+)$")

  if artist and title then
    return artist, title
  else
    -- Fallback: use whole name as title, unknown artist
    return "Unknown", name
  end
end

-- Escape string for JSON
local function JsonEscape(str)
  if not str then return "" end
  str = str:gsub('\\', '\\\\')
  str = str:gsub('"', '\\"')
  str = str:gsub('\n', '\\n')
  str = str:gsub('\r', '\\r')
  str = str:gsub('\t', '\\t')
  return str
end

-- Scan folder for .RPP files
local function ScanFolder(folder)
  local songs = {}

  -- Use reaper.EnumerateFiles to list files
  local i = 0
  while true do
    local filename = reaper.EnumerateFiles(folder, i)
    if not filename then break end

    -- Check if it's an .rpp file
    if filename:lower():match("%.rpp$") then
      local artist, title = ParseFilename(filename)
      local id = GenerateId(artist, title)

      table.insert(songs, {
        id = id,
        artist = artist,
        title = title,
        file = filename
      })
    end

    i = i + 1
  end

  -- Sort by artist, then title
  table.sort(songs, function(a, b)
    if a.artist:lower() == b.artist:lower() then
      return a.title:lower() < b.title:lower()
    end
    return a.artist:lower() < b.artist:lower()
  end)

  return songs
end

-- Generate JSON string
local function GenerateJson(songs)
  local parts = {}

  for _, song in ipairs(songs) do
    table.insert(parts, string.format(
      '{"id":"%s","a":"%s","t":"%s","f":"%s"}',
      JsonEscape(song.id),
      JsonEscape(song.artist),
      JsonEscape(song.title),
      JsonEscape(song.file)
    ))
  end

  local timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ")

  return string.format(
    '{"songs":[%s],"count":%d,"indexed":"%s"}',
    table.concat(parts, ","),
    #songs,
    timestamp
  )
end

-- Write JSON to file
local function WriteJsonFile(json, filepath)
  local file = io.open(filepath, "w")
  if file then
    file:write(json)
    file:close()
    return true
  end
  return false
end

-- MAIN
local function Main()
  local folder = GetSongsFolder()

  if not folder then
    reaper.MB("No songs folder selected. Please run the script again and select a folder.", "Playlist Index", 0)
    return
  end

  reaper.ShowConsoleMsg("Scanning folder: " .. folder .. "\n")

  local songs = ScanFolder(folder)

  if #songs == 0 then
    reaper.MB("No .RPP files found in:\n" .. folder, "Playlist Index", 0)
    return
  end

  reaper.ShowConsoleMsg("Found " .. #songs .. " songs\n")

  -- Generate JSON
  local json = GenerateJson(songs)

  -- Write to www_root for web access
  local output_path = www_root .. "/songs_index.json"
  if WriteJsonFile(json, output_path) then
    reaper.ShowConsoleMsg("Index saved to: " .. output_path .. "\n")
    reaper.MB("Successfully indexed " .. #songs .. " songs!\n\nIndex saved to:\n" .. output_path, "Playlist Index", 0)
  else
    reaper.MB("Failed to write index file to:\n" .. output_path, "Playlist Index Error", 0)
  end
end

Main()
