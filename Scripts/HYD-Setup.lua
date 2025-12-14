--[[
@description HYD Live Performance Setup
@version 1.0.3
@author hydromel-project
@about
  # HYD Live Performance Setup

  One-time setup script that:
  - Adds the Live Performance Server to the main toolbar (with text icon)
  - Opens setup guide in browser with instructions

  Run this once after installing via ReaPack.
@link https://github.com/hydromel-project/HYD-LivePerformance
--]]

local script_name = "HYD Live Performance Setup"
local WEB_PORT = 9020

-- Get paths
local resource_path = reaper.GetResourcePath()
local menu_path = resource_path .. "/reaper-menu.ini"
local www_root = resource_path .. "/reaper_www_root"
local setup_guide_path = www_root .. "/HYD-Setup.html"

-- Open URL in default browser
local function OpenInBrowser(url)
  -- Try SWS extension first
  if reaper.CF_ShellExecute then
    reaper.CF_ShellExecute(url)
    return true
  end

  -- Fallback to OS-specific commands
  local os_name = reaper.GetOS()
  if os_name:match("Win") then
    os.execute('start "" "' .. url .. '"')
  elseif os_name:match("OSX") then
    os.execute('open "' .. url .. '"')
  else
    os.execute('xdg-open "' .. url .. '"')
  end
  return true
end

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

-- Add action to main toolbar with text_wide icon
local function AddToToolbar()
  local cmd_string, cmd_id, script_path = GetServerCommandString()

  if not cmd_string then
    return false, "Could not find/register Live Performance Server script.\nMake sure HYD-LivePerformanceServer.lua is installed."
  end

  local content = ReadFile(menu_path)
  if not content then
    content = ""
  end

  -- Check if already in toolbar
  if content:find(cmd_string, 1, true) then
    -- Already exists, but check if it has text_wide icon
    local item_idx = nil
    for idx, cmd in content:gmatch("item_(%d+)=([^\r\n]+)") do
      if cmd:find(cmd_string, 1, true) then
        item_idx = tonumber(idx)
        break
      end
    end

    if item_idx then
      -- Check if icon already exists
      local icon_pattern = "icon_" .. item_idx .. "="
      if not content:find(icon_pattern) then
        -- Add icon entry after [Main toolbar] line
        local section_start = content:find("%[Main toolbar%]")
        if section_start then
          local line_end = content:find("\n", section_start)
          if line_end then
            local icon_line = "icon_" .. item_idx .. "=text_wide\n"
            content = content:sub(1, line_end) .. icon_line .. content:sub(line_end + 1)
            if WriteFile(menu_path, content) then
              return true, "Added text icon to existing toolbar button"
            end
          end
        end
      end
    end
    return true, "Script already in toolbar"
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

    local new_idx = max_idx + 1

    -- Create new toolbar item with command string format
    local new_item = string.format("item_%d=%s HYD Live Performance Server\n", new_idx, cmd_string)
    -- Create icon entry for text_wide (double width text)
    local new_icon = string.format("icon_%d=text_wide\n", new_idx)

    -- Insert icon after [Main toolbar] header
    local header_end = content:find("\n", section_start)
    if header_end then
      content = content:sub(1, header_end) .. new_icon .. content:sub(header_end + 1)
    end

    -- Now find where to insert item (before tbf_ entries or next section)
    -- Re-find section_end since content changed
    section_end = content:find("\r?\n%[", section_start + 1)
    toolbar_section = section_end
      and content:sub(section_start, section_end)
      or content:sub(section_start)

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
    content = content .. "\n[Main toolbar]\nicon_0=text_wide\nitem_0=" .. cmd_string .. " HYD Live Performance Server\n"
  end

  if WriteFile(menu_path, content) then
    return true, "Added to main toolbar with text icon"
  else
    return false, "Could not write to reaper-menu.ini"
  end
end

-- Main setup function
local function RunSetup()
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

  -- Step 1: Add to toolbar
  reaper.ShowConsoleMsg("Adding to main toolbar with text icon...\n")
  local toolbar_ok, toolbar_msg = AddToToolbar()
  reaper.ShowConsoleMsg("  " .. (toolbar_ok and "[OK] " or "[FAIL] ") .. toolbar_msg .. "\n\n")

  -- Mark setup as complete
  reaper.SetExtState("HYD_LivePerformance", "setup_complete", "1", true)

  reaper.ShowConsoleMsg("Opening setup guide in browser...\n")
  reaper.ShowConsoleMsg(string.rep("=", 50) .. "\n")

  -- Open setup guide in browser
  OpenInBrowser(setup_guide_path)

  reaper.MB(
    "Toolbar button added!\n\nSetup guide opened in your browser.\nFollow the instructions to complete setup.",
    script_name,
    0
  )
end

-- Run setup
RunSetup()
