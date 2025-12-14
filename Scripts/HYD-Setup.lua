--[[
@description HYD Live Performance Setup
@version 1.0.1
@author hydromel-project
@about
  # HYD Live Performance Setup

  One-time setup script that:
  - Configures REAPER web server on port 9020
  - Adds the Live Performance Server to the main toolbar

  Run this once after installing via ReaPack.

  IMPORTANT: Close REAPER immediately after running this script
  (don't make other changes) for settings to persist.
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
  -- Look for HTTP on port 9020 with correct format
  return content:find("HTTP 0 " .. WEB_PORT .. " ") ~= nil
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

  -- Correct format: HTTP 0 PORT '' 'DEFAULT_PAGE' FLAGS ''
  -- FLAGS: 0 = normal, other values for specific features
  local new_line = string.format("csurf_%d=HTTP 0 %d '' '' 0 ''\n", next_idx, WEB_PORT)

  -- Update csurf_cnt to include new entry
  local cnt_pattern = "csurf_cnt=(%d+)"
  local current_cnt = content:match(cnt_pattern)

  if current_cnt then
    local new_cnt = next_idx + 1  -- cnt should be one more than highest index
    content = content:gsub(cnt_pattern, "csurf_cnt=" .. new_cnt)
  else
    -- Add csurf_cnt if not present
    content = content:gsub("(%[reaper%]\r?\n)", "%1csurf_cnt=1\n")
  end

  -- Add the new csurf entry after the last one
  local search_pos = 1
  local final_pos = nil
  while true do
    local s, e = content:find("csurf_%d+=[^\r\n]*\r?\n", search_pos)
    if not s then break end
    final_pos = e
    search_pos = e + 1
  end

  if final_pos then
    content = content:sub(1, final_pos) .. new_line .. content:sub(final_pos + 1)
  else
    -- No csurf entries yet, add after [reaper] section header
    content = content:gsub("(csurf_cnt=%d+\r?\n)", "%1" .. new_line)
  end

  if WriteFile(ini_path, content) then
    return true, "Web server configured on port " .. WEB_PORT
  else
    return false, "Could not write to reaper.ini"
  end
end

-- Register and get the command ID for our script
local function GetServerCommandString()
  -- Path to the server script
  local script_paths = {
    resource_path .. "/Scripts/HYD-LivePerformance/Scripts/HYD-LivePerformanceServer.lua",
    resource_path .. "/Scripts/Live Performance/HYD-LivePerformanceServer.lua",
    resource_path .. "/Scripts/HYD-LivePerformanceServer.lua",
  }

  for _, script_path in ipairs(script_paths) do
    -- Check if file exists
    local f = io.open(script_path, "r")
    if f then
      f:close()

      -- Register the script (or get existing command ID)
      local cmd_id = reaper.AddRemoveReaScript(true, 0, script_path, true)

      if cmd_id and cmd_id ~= 0 then
        -- Get the command string (e.g., "RS0a8a0eed62e9d6bb...")
        local cmd_string = reaper.ReverseNamedCommandLookup(cmd_id)
        if cmd_string then
          return "_" .. cmd_string, cmd_id, script_path
        end
      end
    end
  end

  return nil, nil, nil
end

-- Check if our script is already in toolbar
local function IsScriptInToolbar(cmd_string)
  local content = ReadFile(menu_path)
  if not content then return false end
  -- Check for our specific command string
  if cmd_string then
    return content:find(cmd_string, 1, true) ~= nil
  end
  -- Also check for HYD-LivePerformanceServer in any form
  return content:find("HYD%-LivePerformanceServer") ~= nil or
         content:find("LivePerformanceServer") ~= nil
end

-- Add action to main toolbar
local function AddToToolbar()
  local cmd_string, cmd_id, script_path = GetServerCommandString()

  if not cmd_string then
    return false, "Could not find/register Live Performance Server script.\nMake sure HYD-LivePerformanceServer.lua is installed."
  end

  if IsScriptInToolbar(cmd_string) then
    return true, "Script already in toolbar"
  end

  local content = ReadFile(menu_path)
  if not content then
    content = ""
  end

  -- Find [Main toolbar] section
  local section_start = content:find("%[Main toolbar%]")

  if section_start then
    -- Find highest item index in Main toolbar section
    local section_end = content:find("\r?\n%[", section_start + 1)
    local toolbar_section = section_end
      and content:sub(section_start, section_end)
      or content:sub(section_start)

    local max_idx = -1
    for idx in toolbar_section:gmatch("item_(%d+)=") do
      local num = tonumber(idx)
      if num and num > max_idx then
        max_idx = num
      end
    end

    -- Create new toolbar item with command string format
    local new_item = string.format("item_%d=%s HYD Live Performance Server\n", max_idx + 1, cmd_string)

    -- Find where to insert (before tbf_ entries or next section)
    local insert_pos = toolbar_section:find("tbf_")
    if insert_pos then
      insert_pos = section_start + insert_pos - 2  -- Before tbf_ line
    elseif section_end then
      insert_pos = section_end
    else
      insert_pos = #content + 1
    end

    content = content:sub(1, insert_pos) .. new_item .. content:sub(insert_pos + 1)
  else
    -- Add new Main toolbar section at end
    content = content .. "\n[Main toolbar]\nitem_0=" .. cmd_string .. " HYD Live Performance Server\n"
  end

  if WriteFile(menu_path, content) then
    return true, "Added to main toolbar"
  else
    return false, "Could not write to reaper-menu.ini"
  end
end

-- Main setup function
local function RunSetup()
  local messages = {}
  local all_ok = true

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
  reaper.ShowConsoleMsg("  " .. (web_ok and "[OK] " or "[FAIL] ") .. web_msg .. "\n\n")
  table.insert(messages, (web_ok and "[OK] " or "[FAIL] ") .. web_msg)
  if not web_ok then all_ok = false end

  -- Step 2: Add to toolbar
  reaper.ShowConsoleMsg("Adding to main toolbar...\n")
  local toolbar_ok, toolbar_msg = AddToToolbar()
  reaper.ShowConsoleMsg("  " .. (toolbar_ok and "[OK] " or "[FAIL] ") .. toolbar_msg .. "\n\n")
  table.insert(messages, (toolbar_ok and "[OK] " or "[FAIL] ") .. toolbar_msg)
  if not toolbar_ok then all_ok = false end

  -- Mark setup as complete
  if all_ok then
    reaper.SetExtState("HYD_LivePerformance", "setup_complete", "1", true)
  end

  -- Summary
  reaper.ShowConsoleMsg(string.rep("=", 50) .. "\n")

  local summary = "Setup Results:\n\n"
  for i, msg in ipairs(messages) do
    summary = summary .. i .. ". " .. msg .. "\n"
  end

  summary = summary .. "\nWeb Interface URLs (after restart):\n"
  summary = summary .. "- Teleprompter: http://localhost:" .. WEB_PORT .. "/Teleprompter.html\n"
  summary = summary .. "- Now Playing: http://localhost:" .. WEB_PORT .. "/NowPlaying.html\n"
  summary = summary .. "- Playlist: http://localhost:" .. WEB_PORT .. "/Playlist.html\n"

  summary = summary .. "\n" .. string.rep("-", 40) .. "\n"
  summary = summary .. "IMPORTANT: Close REAPER now!\n"
  summary = summary .. "Don't make other changes before closing.\n"
  summary = summary .. "Settings will apply on next launch."

  reaper.ShowConsoleMsg(summary .. "\n")

  local result = reaper.MB(
    summary .. "\n\nClose REAPER now to apply settings?",
    script_name,
    4  -- Yes/No
  )

  if result == 6 then  -- Yes
    -- Close REAPER (action 40004)
    reaper.Main_OnCommand(40004, 0)
  end
end

-- Run setup
RunSetup()
