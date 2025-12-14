# HYD Live Performance Suite for REAPER

Display lyrics, song info, and manage playlists for your live streams and performances.

---

## What's Included

**Teleprompter** - Shows lyrics on screen as you perform
**Now Playing** - Displays current song title, artist, and cover art
**Playlist** - Queue up songs and switch between them easily

All three work in your web browser and can be added to OBS.

---

## Installation

### Step 1: Install ReaPack

If you don't have ReaPack yet:
1. Download from https://reapack.com
2. Follow their installation instructions
3. Restart REAPER

### Step 2: Add This Package

1. In REAPER, go to **Extensions > ReaPack > Import repositories**
2. Paste this link:
   ```
   https://raw.githubusercontent.com/hydromel-project/HYD-LivePerformance/master/index.xml
   ```
3. Click OK

### Step 3: Install the Scripts

1. Go to **Extensions > ReaPack > Browse packages**
2. Search for **HYD**
3. Right-click on each result and select **Install**
4. Click **Apply** when done

### Step 4: Run Setup

1. Go to **Actions > Show action list** (or press `?`)
2. Search for **HYD Setup**
3. Double-click to run it
4. A setup guide will open in your browser - follow the steps there

---

## Setting Up Your Project

The system looks for two special tracks in your REAPER project:

### LYRICS Track (for Teleprompter)

1. Create a new track and name it exactly: **LYRICS**
2. Add empty items where you want lyrics to appear
3. For each item, right-click and select **Item notes**
4. Type your lyrics in the notes box

Example:
```
Verse 1 lyrics here
Second line of verse
```

### SONGS Track (for Now Playing)

1. Create a new track and name it exactly: **SONGS**
2. Drag your audio file (MP3, FLAC, etc.) onto this track
3. The song's title, artist, and cover art are read automatically from the file

**Tip:** If you start the server and these tracks are missing, it will offer to create them for you.

---

## Using the Web Interfaces

### Starting the Server

1. Click the **HYD Live Performance Server** button in your toolbar
   (or go to Actions and search for it)
2. The server runs in the background while you work

### Opening the Displays

With the server running, open these in your web browser:

- **Teleprompter:** http://localhost:9020/Teleprompter.html
- **Now Playing:** http://localhost:9020/NowPlaying.html
- **Playlist:** http://localhost:9020/Playlist.html

### Customizing the Look

Each interface has a settings panel:

1. Click the **gear icon** in the corner
2. Adjust colors, fonts, animations, and layout
3. Click **Save** - your settings are remembered

### Adding to OBS

1. Open the interface in your browser
2. Click the gear icon to open settings
3. Customize how you want it to look
4. Click **Copy URL for OBS** at the bottom of settings
5. In OBS: **Add Source > Browser**
6. Paste the URL you copied
7. Set the width and height to match your scene

The copied URL includes all your settings and hides the gear icon automatically.

---

## Teleprompter Modes

**Streamer Mode** (default)
- Shows current lyrics in large text
- Shows upcoming lyrics below
- Beat indicator pulses with the music
- Progress bar shows position in song

**Public Mode**
- Rolling lyrics that scroll automatically
- Good for audience displays

Switch between modes in the settings panel.

---

## Now Playing Options

**Layouts:**
- Horizontal - Cover art on left, text on right
- Vertical - Cover art on top, text below
- Background - Blurred cover art fills the screen
- Minimal - Text only, no cover art

**Animations:**
- Fade, slide, or scale when song changes
- Slow pan effect on cover art (Ken Burns style)
- Auto-hide when nothing is playing

---

## Playlist (For Multiple Songs)

If you have many songs saved as separate REAPER projects:

### Organizing Your Songs

Save each song as its own .RPP file with this naming format:
```
Artist - Song Title.rpp
```

Put them all in one folder.

### Building the Song Index

1. Go to **Actions > Show action list**
2. Search for **Playlist Index Songs**
3. Run it and select your songs folder
4. Wait for it to scan all your files

### Using the Playlist

Open http://localhost:9020/Playlist.html

- **Search** - Type to filter songs
- **Add to Queue** - Click a song to add it
- **Reorder** - Drag songs up or down in the queue
- **Play** - Click a song in the queue to switch to it
- **Save Playlist** - Keep your queue for next time

---

## Troubleshooting

### "Page not found" or interface won't load

The web server might not be configured:
1. Go to **Preferences** (Ctrl+P)
2. Click **Control/OSC/Web** on the left
3. Click **Add**
4. Select **Web browser interface**
5. Set port to **9020**
6. Click OK, then Apply
7. Restart REAPER

### No lyrics or song info showing

- Make sure the server is running (check your toolbar)
- Make sure your tracks are named exactly **LYRICS** and **SONGS**
- Make sure you have items on those tracks
- Press play in REAPER - some displays only update while playing

### Cover art not appearing

The system uses ffmpeg to extract cover art from audio files:
1. Download ffmpeg from https://ffmpeg.org/download.html
2. Install it so you can run `ffmpeg` from command prompt
3. Restart REAPER and the server

If you don't want to install ffmpeg, cover art simply won't show.

### Settings not saving

Make sure you click the **Save** button in the settings panel. Settings are stored in your browser, so they stay even if you close and reopen the page.

---

## Need Help?

Visit the GitHub page: https://github.com/hydromel-project/HYD-LivePerformance

---

*Made by hydromel-project*
