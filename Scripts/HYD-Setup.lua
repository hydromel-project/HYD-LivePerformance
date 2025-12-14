--[[
@description HYD Live Performance Setup
@version 1.0.0
@author hydromel-project
@about
  # HYD Live Performance Setup

  One-time setup script that:
  - Configures REAPER web server on port 9020
  - Adds the Live Performance Server to the main toolbar

  Run this once after installing via ReaPack.
@link https://github.com/hydromel-project/HYD-LivePerformance
--]]

local script_name = "HYD Live Performance Setup"
local WEB_PORT = 9020

-- Get paths
local resource_path = reaper.GetResourcePath()
local ini_path = resource_path .. "/reaper.ini"
local menu_path = resource_path .. "/reaper-menu.ini"

-- Read file contents
local function ReadFile(path)
  local file = io.open(path, "r")
  if not file then return nil end
  local content = file:read("*all")
  file:close()
  return content
end

-- Write file contents
local function WriteFile(path, content)
  local file = io.open(path, "w")
  if not file then return false end
  file:write(content)
  file:close()
  return true
end

-- Check if web server is already configured on our port
local function IsWebServerConfigured()
  local content = ReadFile(ini_path)
  if not content then return false end
  -- Look for HTTP on port 9020
  return content:find("HTTP.-" .. WEB_PORT) ~= nil
end

-- Find highest csurf index
local function GetNextCsurfIndex(content)
  local max_idx = -1
  for idx in content:gmatch("csurf_(%d+)=") do
    local num = tonumber(idx)
    if num and num > max_idx then
      max_idx = num
    end
  end
  return max_idx + 1
end

-- Configure web server
local function ConfigureWebServer()
  if IsWebServerConfigured() then
    return true, "Web server already configured on port " .. WEB_PORT
  end

  local content = ReadFile(ini_path)
  if not content then
    return false, "Could not read reaper.ini"
  end

  local next_idx = GetNextCsurfIndex(content)

  -- Find [reaper] section and add web server config
  local new_line = string.format("csurf_%d=HTTP 0 %d '' '' %d\n", next_idx, WEB_PORT, WEB_PORT)

  -- Update or add csurf_cnt
  local cnt_pattern = "csurf_cnt=(%d+)"
  local current_cnt = content:match(cnt_pattern)

  if current_cnt then
    local new_cnt = tonumber(current_cnt) + 1
    content = content:gsub(cnt_pattern, "csurf_cnt=" .. new_cnt)
  else
    -- Add csurf_cnt if not present
    content = content:gsub("%[reaper%]\n", "[reaper]\ncsurf_cnt=1\n")
  end

  -- Add the new csurf entry after the last one or after csurf_cnt
  if content:find("csurf_%d+=") then
    -- Find last csurf line and add after it
    local last_csurf_end = 0
    for pos in content:gmatch("()csurf_%d+=[^\n]*\n") do
      last_csurf_end = pos
    end
    -- Find the end of this line
    local line_end = content:find("\n", last_csurf_end)
    if line_end then
      -- Find the actual end of the last csurf line
      local search_pos = 1
      local final_pos = 1
      while true do
        local s, e = content:find("csurf_%d+=[^\n]*\n", search_pos)
        if not s then break end
        final_pos = e
        search_pos = e + 1
      end
      content = content:sub(1, final_pos) .. new_line .. content:sub(final_pos + 1)
    end
  else
    -- No csurf entries yet, add after csurf_cnt
    content = content:gsub("(csurf_cnt=%d+\n)", "%1" .. new_line)
  end

  if WriteFile(ini_path, content) then
    return true, "Web server configured on port " .. WEB_PORT
  else
    return false, "Could not write to reaper.ini"
  end
end

-- Get the command ID for our script
local function GetServerActionId()
  -- Look for HYD-LivePerformanceServer.lua
  local script_path = resource_path .. "/Scripts/HYD-LivePerformance/Scripts/HYD-LivePerformanceServer.lua"

  -- Try to find the action by looking it up
  local cmd_id = reaper.NamedCommandLookup("_RS" .. script_path)
  if cmd_id and cmd_id ~= 0 then
    return cmd_id
  end

  -- Also try without full path (ReaPack might install differently)
  local alt_paths = {
    resource_path .. "/Scripts/Live Performance/HYD-LivePerformanceServer.lua",
    resource_path .. "/Scripts/HYD-LivePerformanceServer.lua",
  }

  for _, path in ipairs(alt_paths) do
    cmd_id = reaper.NamedCommandLookup("_RS" .. path)
    if cmd_id and cmd_id ~= 0 then
      return cmd_id
    end
  end

  return nil
end

-- Check if action is already in toolbar
local function IsActionInToolbar(action_id)
  local content = ReadFile(menu_path)
  if not content then return false end
  return content:find("item_%d+=" .. action_id) ~= nil or
         content:find("item_%d+=_RS") ~= nil -- Script reference
end

-- Add action to main toolbar
local function AddToToolbar()
  local action_id = GetServerActionId()

  if not action_id then
    -- If we can't find the action yet, store a marker to add it later
    -- This can happen if the script hasn't been loaded yet
    return false, "Could not find Live Performance Server action.\nPlease run Actions > Load ReaScript and select HYD-LivePerformanceServer.lua first."
  end

  if IsActionInToolbar(action_id) then
    return true, "Action already in toolbar"
  end

  local content = ReadFile(menu_path)
  if not content then
    -- Create new menu file if it doesn't exist
    content = ""
  end

  -- Find or create [Main toolbar] section
  local toolbar_section = content:match("%[Main toolbar%][^\n]*\n([^%[]*)")

  if toolbar_section then
    -- Find highest item index in toolbar
    local max_idx = -1
    for idx in toolbar_section:gmatch("item_(%d+)=") do
      local num = tonumber(idx)
      if num and num > max_idx then
        max_idx = num
      end
    end

    local new_item = string.format("item_%d=%d\n", max_idx + 1, action_id)

    -- Insert before the next section or at end of toolbar section
    local section_start = content:find("%[Main toolbar%]")
    local section_end = content:find("\n%[", section_start + 1)

    if section_end then
      content = content:sub(1, section_end) .. new_item .. content:sub(section_end + 1)
    else
      content = content .. new_item
    end
  else
    -- Add new Main toolbar section
    content = content .. "\n[Main toolbar]\nitem_0=" .. action_id .. "\n"
  end

  if WriteFile(menu_path, content) then
    return true, "Added to main toolbar (restart REAPER to see)"
  else
    return false, "Could not write to reaper-menu.ini"
  end
end

-- Main setup function
local function RunSetup()
  local messages = {}

  -- Check if setup was already run
  local setup_done = reaper.GetExtState("HYD_LivePerformance", "setup_complete")
  if setup_done == "1" then
    local result = reaper.MB(
      "Setup has already been run.\n\nWould you like to run it again?",
      script_name, 4
    )
    if result ~= 6 then return end
  end

  reaper.ShowConsoleMsg("\n" .. string.rep("=", 50) .. "\n")
  reaper.ShowConsoleMsg("  HYD Live Performance Setup\n")
  reaper.ShowConsoleMsg(string.rep("=", 50) .. "\n\n")

  -- Step 1: Configure web server
  reaper.ShowConsoleMsg("Configuring web server on port " .. WEB_PORT .. "...\n")
  local web_ok, web_msg = ConfigureWebServer()
  reaper.ShowConsoleMsg("  " .. (web_ok and "[OK] " or "[SKIP] ") .. web_msg .. "\n\n")
  table.insert(messages, web_msg)

  -- Step 2: Add to toolbar
  reaper.ShowConsoleMsg("Adding to main toolbar...\n")
  local toolbar_ok, toolbar_msg = AddToToolbar()
  reaper.ShowConsoleMsg("  " .. (toolbar_ok and "[OK] " or "[SKIP] ") .. toolbar_msg .. "\n\n")
  table.insert(messages, toolbar_msg)

  -- Mark setup as complete
  if web_ok then
    reaper.SetExtState("HYD_LivePerformance", "setup_complete", "1", true)
  end

  -- Summary
  reaper.ShowConsoleMsg(string.rep("=", 50) .. "\n")
  reaper.ShowConsoleMsg("Setup complete!\n\n")

  local summary = "Setup Results:\n\n"
  for i, msg in ipairs(messages) do
    summary = summary .. i .. ". " .. msg .. "\n"
  end

  summary = summary .. "\nWeb Interface URLs:\n"
  summary = summary .. "- Teleprompter: http://localhost:" .. WEB_PORT .. "/Teleprompter.html\n"
  summary = summary .. "- Now Playing: http://localhost:" .. WEB_PORT .. "/NowPlaying.html\n"
  summary = summary .. "- Playlist: http://localhost:" .. WEB_PORT .. "/Playlist.html\n"
  summary = summary .. "\nPlease RESTART REAPER for changes to take effect."

  reaper.ShowConsoleMsg(summary .. "\n")
  reaper.MB(summary, script_name, 0)
end

-- Run setup
RunSetup()
