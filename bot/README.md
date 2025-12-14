# HYD Playrate Bot

Let your Twitch viewers mess with your REAPER playrate using channel points and donations!

## Quick Start (Easy Way)

### 1. Install Node.js

Download and install from https://nodejs.org (LTS version recommended)

### 2. Run the Installer

Double-click **`install.bat`** in this folder.

This will:
- Create a desktop shortcut called "HYD Playrate Bot"
- Offer to launch and set up the bot immediately

### 3. Use the Desktop Shortcut

The shortcut handles everything:
- **First run**: Automatically installs dependencies
- **After that**: Launches the bot directly

### 4. Open Config Panel

Go to http://localhost:9030 in your browser

---

## Quick Start (Manual Way)

If you prefer using the command line:

```bash
npm install
npm start
```

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

You need to create an "Application" in Twitch's Developer Console. This gives you credentials that let the bot control channel points on your behalf.

#### Step 1: Open Twitch Developer Console

1. Go to https://dev.twitch.tv/console
2. Log in with your Twitch account (the account you stream from)
3. Click **Applications** in the left sidebar (if not already there)

#### Step 2: Register a New Application

1. Click the **+ Register Your Application** button
2. Fill in the form:

| Field | What to enter |
|-------|---------------|
| **Name** | `HYD Playrate Bot` (or any name you want - must be unique on Twitch) |
| **OAuth Redirect URLs** | `http://localhost:9030/api/twitch/callback` |
| **Category** | Select **Chat Bot** from dropdown |
| **Client Type** | Select **Confidential** |

3. Complete the CAPTCHA if shown
4. Click **Create**

> **OAuth Redirect URL must be EXACTLY:**
> ```
> http://localhost:9030/api/twitch/callback
> ```
> - Use `http://` (not `https://`)
> - Include port `:9030`
> - No trailing slash
> - If you changed the bot's port, use that number instead of 9030

#### Step 3: Get Your Client ID and Secret

After creating the app, you'll see your application's page:

1. **Client ID** - Displayed on the page, copy this
2. **Client Secret** - Click **New Secret** button to generate one
   - ⚠️ **Copy the secret immediately!** It's only shown once
   - If you lose it, you'll need to generate a new one

Your credentials will look something like:
```
Client ID:     a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5
Client Secret: p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0
```

#### Step 4: Connect in Config Panel

1. Start the bot: `npm start`
2. Open http://localhost:9030 in your browser
3. In the **Twitch Setup** section, enter:
   - **Client ID** - Paste from Step 3
   - **Client Secret** - Paste from Step 3
   - **Channel Name** - Your Twitch username (e.g., `hydromelproject`)
4. Click **Save**
5. Click **Connect to Twitch**
6. A popup opens - click **Authorize** to grant permissions
7. You should see "Twitch Connected!" - close the popup

The bot now has permission to:
- Create/manage channel point rewards
- Read when viewers redeem rewards
- Send chat messages

### Streamlabs Setup (for donations)

1. Go to your Streamlabs Dashboard
2. Navigate to **Settings** → **API Settings** → **API Tokens**
3. Copy your **Socket API Token**
4. Paste it in the config panel

### StreamElements Setup (for donations)

1. Go to your StreamElements Dashboard: https://streamelements.com/dashboard
2. Click your profile icon → **Account Settings**
3. Go to **Channels** tab
4. Click **Show secrets**
5. Copy the **JWT Token**
6. Paste it in the config panel

> **Note:** You only need to configure ONE donation platform (Streamlabs OR StreamElements), whichever you use for accepting tips.

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

### "Twitch not connecting" or "Invalid redirect URI"

This is usually a redirect URL mismatch:

1. Go to https://dev.twitch.tv/console and click on your app
2. Check **OAuth Redirect URLs** section
3. The URL must be **exactly**: `http://localhost:9030/api/twitch/callback`

Common mistakes:
- Using `https://` instead of `http://`
- Forgetting the port number `:9030`
- Having a trailing slash at the end
- Typo in `/api/twitch/callback`

Other fixes:
- Regenerate your Client Secret and update it in the config panel
- Clear your browser cookies for twitch.tv
- Try a different browser for the auth popup

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
