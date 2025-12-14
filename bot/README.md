# HYD Playrate Bot

Let your Twitch viewers mess with your REAPER playrate using channel points and donations!

## Quick Start

### 1. Install Node.js

Download and install from https://nodejs.org (LTS version recommended)

### 2. Install Dependencies

Open a terminal in this folder and run:

```bash
npm install
```

### 3. Start the Bot

```bash
npm start
```

### 4. Open Config Panel

Go to http://localhost:9030 in your browser

## Setup Guide

### REAPER OSC Setup

1. Open REAPER **Preferences** (Ctrl+P)
2. Go to **Control/OSC/Web**
3. Click **Add** → **OSC (Open Sound Control)**
4. Configure:
   - **Mode**: Configure device IP+local port
   - **Device IP**: `127.0.0.1`
   - **Device port**: `9000` (this is where the bot listens)
   - **Local listen port**: `8000` (this is where the bot sends)
5. Check **Allow binding messages to REAPER actions and FX learn**
6. Click OK

### Twitch Setup

1. Go to https://dev.twitch.tv/console
2. Click **Register Your Application**
3. Fill in:
   - **Name**: HYD Playrate Bot (or anything)
   - **OAuth Redirect URLs**: `http://localhost:9030/api/twitch/callback`
   - **Category**: Chat Bot
4. Click **Create**
5. Copy the **Client ID** and **Client Secret**
6. In the config panel, paste these values and your channel name
7. Click **Connect to Twitch**
8. Authorize in the popup window

### Streamlabs Setup

1. Go to your Streamlabs Dashboard
2. Navigate to **Settings** → **API Settings** → **API Tokens**
3. Copy your **Socket API Token**
4. Paste it in the config panel

## How It Works

When you enable **Game Mode**:

1. The bot creates channel point rewards on your Twitch channel
2. Viewers can redeem:
   - 🔥 **Speed Up** - Increases playrate by 0.1x
   - 🧊 **Slow Down** - Decreases playrate by 0.1x
   - 🎲 **CHAOS** - Sets a random playrate
   - ✨ **Reset** - Returns to 1.0x
3. The bot announces changes in your chat
4. When you disable game mode, rewards are removed

Donations through Streamlabs also trigger actions based on the amount!

## Configuration

All settings are in the web config panel:

### Game Settings

- **Min/Max Playrate**: Bounds for how extreme it can get (default 0.5x - 2.5x)
- **Global Cooldown**: Delay between any action (prevents spam)
- **Auto Reset**: Automatically return to normal after X seconds of inactivity

### Reward Settings

For each reward, configure:
- **Enabled**: Show/hide the reward
- **Cost**: Channel points required
- **Increment**: How much speed up/slow down changes (0.1 = 10%)
- **Cooldown**: Per-reward cooldown

### Donation Thresholds

Set which action triggers based on donation amount:
- $1-4.99: Speed Up
- $5-9.99: Slow Down
- $10-24.99: Chaos
- $25+: Reset

(Fully customizable!)

### Chat Messages

Customize what the bot says:
- `{user}` - Username who triggered it
- `{rate}` - New playrate
- `{seconds}` - Cooldown remaining

## Files

```
bot/
├── index.js           # Main entry point
├── package.json       # Dependencies
├── config.json        # Your settings (created on first run)
├── src/
│   ├── config.js      # Configuration management
│   ├── server.js      # Web server & API
│   ├── reaper.js      # REAPER OSC communication
│   ├── twitch.js      # Twitch EventSub & Chat
│   ├── streamlabs.js  # Streamlabs donations
│   └── game-engine.js # Game logic
└── public/
    └── index.html     # Config panel
```

## Troubleshooting

### "REAPER not connected"

- Make sure REAPER is running
- Check OSC is configured in REAPER preferences
- Verify port numbers match

### "Twitch not connecting"

- Check Client ID and Secret are correct
- Make sure redirect URL in Twitch dev console is exactly:
  `http://localhost:9030/api/twitch/callback`
- Try disconnecting and reconnecting

### Channel point rewards not appearing

- Make sure you're a Twitch Affiliate or Partner
- Enable game mode in the config panel
- Check that rewards are enabled in settings

### Donations not triggering

- Verify Streamlabs Socket Token is correct
- Check that donation thresholds are configured
- Look at the terminal for any error messages

## Advanced

### Running as a Background Service

On Windows, you can use PM2:

```bash
npm install -g pm2
pm2 start index.js --name playrate-bot
pm2 save
pm2 startup
```

### Custom Actions

Edit `src/game-engine.js` to add new action types.

### Multiple Bots

Change the `webPort` in config.json to run multiple instances.

---

Made with chaos by hydromel-project
