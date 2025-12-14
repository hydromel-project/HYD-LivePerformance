# HYD Live Performance Suite for REAPER

A comprehensive live performance toolkit for REAPER that provides real-time web interfaces for teleprompter lyrics, now playing displays, and playlist/queue management. Perfect for streamers, live performers, and content creators.

## Features

### Teleprompter
- Real-time lyrics display from REAPER's LYRICS track
- Streamer mode with full controls (current + next lyrics, beat indicator, progress bar)
- Public mode with rolling lyrics animation (for audience display)
- BPM and time signature display
- Visual metronome/beat indicator
- Song progress bar based on regions

### Now Playing
- Displays current song info (title, artist, album, year)
- Automatic cover art extraction from MP3/FLAC files
- Multiple layouts: horizontal, vertical, background blur
- Smooth fade in/out animations
- Auto-hide when not playing

### Playlist Manager
- Browse and search 1000+ song sessions
- Queue management with drag-to-reorder
- Load songs as background tabs (non-interrupting)
- Play/Stop controls per song
- Save/Load playlists
- Control panel for phone/moderators
- Viewer display for OBS

## Installation

### Prerequisites
- REAPER 6.0+ with ReaScript support
- [js_ReaScriptAPI extension](https://forum.cockos.com/showthread.php?t=212174) (for folder dialogs)
- [ffmpeg](https://ffmpeg.org/) in PATH (optional, for cover art extraction)

### Option 1: ReaPack (Recommended)

1. **Install ReaPack** if you haven't: https://reapack.com/

2. **Add this repository to ReaPack**:
   - Extensions > ReaPack > Import repositories...
   - Paste this URL:
   ```
   https://raw.githubusercontent.com/hydromel-project/HYD-LivePerformance/master/index.xml
   ```

3. **Install the scripts**:
   - Extensions > ReaPack > Browse packages
   - Search for "HYD"
   - Right-click > Install all packages

4. **Run the Setup script** (one-time):
   - Actions > Show action list
   - Search for "HYD Setup"
   - Run it

   This will automatically:
   - Configure REAPER web server on port 9020
   - Add the Live Performance Server to your main toolbar

5. **Restart REAPER** for changes to take effect

### Option 2: Manual Installation

1. **Copy Lua scripts** to your REAPER Scripts folder:
   ```
   %APPDATA%\REAPER\Scripts\
   ```
   - `HYD-LivePerformanceServer.lua` - Main server script
   - `Playlist_IndexSongs.lua` - Song library indexer

2. **Copy HTML files** to REAPER's web root:
   ```
   %APPDATA%\REAPER\reaper_www_root\
   ```
   - `Teleprompter.html`
   - `NowPlaying.html`
   - `Playlist.html`

3. **Enable REAPER's web interface**:
   - Preferences > Control/OSC/Web
   - Add > Web browser interface
   - Set port (default: 9010)
   - Enable "Allow 'localhost' access"

4. **Add scripts to REAPER Actions**:
   - Actions > Show action list
   - New action > Load ReaScript
   - Select each .lua file

## Usage

### Quick Start

1. **Create required tracks** in your REAPER project:
   - `LYRICS` - Empty items with lyrics in item notes
   - `SONGS` - Audio items (MP3/FLAC) for Now Playing info

2. **Create regions** for each song section

3. **Run the server script**:
   - Actions > HYD-LivePerformanceServer

4. **Open web interfaces** in browser:
   - Teleprompter: `http://localhost:9010/Teleprompter.html`
   - Now Playing: `http://localhost:9010/NowPlaying.html`
   - Playlist: `http://localhost:9010/Playlist.html`

### Setting Up for OBS

1. Open the web interface in your browser
2. Click **Settings** button (top-left)
3. Configure your display options
4. Click **Copy URL** to get the OBS-ready URL
5. In OBS: Add > Browser Source > Paste URL

The generated URL includes `hideSettings=true` which hides all controls.

### Teleprompter Track Setup

Create a track named `LYRICS` with empty items:
- Each item represents a lyrics block
- Put lyrics text in the item's **Notes** (right-click > Item notes)
- Use line breaks for multi-line lyrics
- Position items on the timeline where lyrics should appear

### Now Playing Track Setup

Create a track named `SONGS` with your audio files:
- Use MP3/FLAC files with ID3 tags for metadata
- Cover art is extracted automatically via ffmpeg
- Position items to match your song regions

### Playlist Setup (for multiple song sessions)

1. **Organize songs**: Save each song as separate `.RPP` files named `Artist - Title.rpp`

2. **Run the indexer**: Actions > Playlist_IndexSongs
   - Select your songs folder when prompted
   - This creates `songs_index.json` in web root

3. **Use the playlist interface**:
   - Search/browse songs
   - Click to add to queue
   - Songs load as background tabs
   - Click song title to switch tabs
   - Use play/stop buttons to control playback

## URL Parameters

### Teleprompter.html

| Parameter | Values | Description |
|-----------|--------|-------------|
| `mode` | `streamer`, `public` | Display mode |
| `theme` | `dark`, `light` | Color theme |
| `transparent` | `true`, `false` | Transparent background for OBS |
| `bpm` | `true`, `false` | Show BPM display |
| `beat` | `true`, `false` | Show beat indicator |
| `progress` | `true`, `false` | Show progress bar |
| `hideSettings` | `true` | Hide settings panel |

### NowPlaying.html

| Parameter | Values | Description |
|-----------|--------|-------------|
| `layout` | `horizontal`, `vertical`, `background` | Layout style |
| `theme` | `dark`, `light` | Color theme |
| `transparent` | `true`, `false` | Transparent background |
| `album` | `true`, `false` | Show album name |
| `year` | `true`, `false` | Show year |
| `cover` | `true`, `false` | Show cover art |
| `fade` | `0-30` | Seconds before end to start fading |
| `hideSettings` | `true` | Hide settings panel |

### Playlist.html

| Parameter | Values | Description |
|-----------|--------|-------------|
| `mode` | `control`, `viewer` | Interface mode |

## Project Structure

```
REAPER/
├── Scripts/
│   ├── HYD-LivePerformanceServer.lua   # Main server (combined)
│   ├── Playlist_IndexSongs.lua         # Song library indexer
│   └── Playlists/                      # Saved playlists
│       └── *.txt
└── reaper_www_root/
    ├── Teleprompter.html               # Lyrics display
    ├── NowPlaying.html                 # Song info display
    ├── Playlist.html                   # Queue management
    └── songs_index.json                # Generated song index
```

## Troubleshooting

### Web interface not loading
- Check REAPER web server is enabled (Preferences > Control/OSC/Web)
- Verify port number matches URL
- Check firewall settings

### No data showing
- Ensure HYD-LivePerformanceServer.lua is running
- Check track names are exactly `LYRICS` and `SONGS` (case-insensitive)
- Verify items exist on the tracks

### Cover art not appearing
- Install ffmpeg and ensure it's in PATH
- Check audio files have embedded cover art
- Look for `np_cover_*.jpg` in reaper_www_root

### Playlist songs not loading
- Run Playlist_IndexSongs first to generate index
- Check songs folder path is set correctly
- Verify `.RPP` files follow `Artist - Title.rpp` naming

## License

MIT License - Free for personal and commercial use.

## Author

hydromel-project

## Acknowledgments

Built with REAPER's ReaScript API and web interface capabilities.
