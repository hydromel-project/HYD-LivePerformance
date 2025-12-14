const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const config = require('./config');
const gameEngine = require('./game-engine');
const reaper = require('./reaper');
const twitch = require('./twitch');
const streamlabs = require('./streamlabs');

class WebServer {
  constructor() {
    this.app = express();
    this.server = null;
    this.wss = null;
    this.clients = new Set();
  }

  start() {
    const port = config.get('webPort');

    // Middleware
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '..', 'public')));

    // CORS for GameHUD
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
      next();
    });

    // API Routes
    this.setupRoutes();

    // Start HTTP server
    this.server = this.app.listen(port, () => {
      console.log(`🌐 Config panel: http://localhost:${port}`);
    });

    // Start WebSocket server for real-time updates
    this.setupWebSocket();

    // Forward events to WebSocket clients
    this.setupEventForwarding();
  }

  setupRoutes() {
    // Get full config
    this.app.get('/api/config', (req, res) => {
      res.json(config.getAll());
    });

    // Update config
    this.app.put('/api/config', (req, res) => {
      config.update(req.body);
      this.broadcast({ type: 'configUpdated', data: config.getAll() });
      res.json({ success: true });
    });

    // Get game state
    this.app.get('/api/state', (req, res) => {
      res.json({
        game: gameEngine.getState(),
        twitch: twitch.getStatus(),
        streamlabs: streamlabs.getStatus(),
        reaper: {
          connected: reaper.connected,
          playrate: reaper.getPlayrate()
        }
      });
    });

    // Enable/disable game mode
    this.app.post('/api/game/toggle', async (req, res) => {
      const { enabled } = req.body;
      gameEngine.setEnabled(enabled);

      if (enabled) {
        // Create channel point rewards
        await twitch.createRewards();
      } else {
        // Remove channel point rewards
        await twitch.removeRewards();
      }

      this.broadcast({ type: 'gameToggled', data: { enabled } });
      res.json({ success: true, enabled });
    });

    // Manual action trigger (for testing)
    this.app.post('/api/action', (req, res) => {
      const { action, username = 'Manual' } = req.body;
      const result = gameEngine.processAction(action, username, { source: 'manual' });
      res.json(result);
    });

    // Set playrate directly
    this.app.post('/api/playrate', (req, res) => {
      const { rate } = req.body;
      const newRate = reaper.setPlayrate(rate);
      res.json({ success: true, rate: newRate });
    });

    // Create rewards manually
    this.app.post('/api/rewards/create', async (req, res) => {
      const success = await twitch.createRewards();
      res.json({ success });
    });

    // Remove rewards manually
    this.app.post('/api/rewards/remove', async (req, res) => {
      const success = await twitch.removeRewards();
      res.json({ success });
    });

    // Get Twitch OAuth URL
    this.app.get('/api/twitch/auth-url', (req, res) => {
      const clientId = config.get('twitch.clientId');
      const redirectUri = `http://localhost:${config.get('webPort')}/api/twitch/callback`;
      const scopes = [
        'channel:read:redemptions',
        'channel:manage:redemptions',
        'chat:edit',
        'chat:read'
      ].join('+');

      const url = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scopes}`;
      res.json({ url });
    });

    // Twitch OAuth callback
    this.app.get('/api/twitch/callback', async (req, res) => {
      const { code } = req.query;

      if (!code) {
        return res.status(400).send('Missing authorization code');
      }

      try {
        const clientId = config.get('twitch.clientId');
        const clientSecret = config.get('twitch.clientSecret');
        const redirectUri = `http://localhost:${config.get('webPort')}/api/twitch/callback`;

        // Exchange code for tokens
        const response = await fetch('https://id.twitch.tv/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code: code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri
          })
        });

        const tokens = await response.json();

        if (tokens.access_token) {
          config.set('twitch.accessToken', tokens.access_token);
          config.set('twitch.refreshToken', tokens.refresh_token);

          // Reconnect with new tokens
          await twitch.disconnect();
          await twitch.connect();

          res.send(`
            <html>
              <body style="background:#1a1a1a;color:#00ff88;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
                <div style="text-align:center;">
                  <h1>✓ Twitch Connected!</h1>
                  <p>You can close this window and return to the config panel.</p>
                </div>
              </body>
            </html>
          `);
        } else {
          throw new Error(tokens.message || 'Token exchange failed');
        }
      } catch (err) {
        res.status(500).send(`Error: ${err.message}`);
      }
    });

    // History
    this.app.get('/api/history', (req, res) => {
      res.json(gameEngine.getHistory());
    });
  }

  setupWebSocket() {
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      console.log('WebSocket client connected');

      // Send initial state
      ws.send(JSON.stringify({
        type: 'init',
        data: {
          config: config.getAll(),
          state: gameEngine.getState()
        }
      }));

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          this.handleWebSocketMessage(ws, msg);
        } catch (err) {
          console.error('WebSocket message error:', err.message);
        }
      });
    });
  }

  handleWebSocketMessage(ws, msg) {
    switch (msg.type) {
      case 'getState':
        ws.send(JSON.stringify({
          type: 'state',
          data: gameEngine.getState()
        }));
        break;

      case 'action':
        const result = gameEngine.processAction(msg.action, msg.username || 'WebPanel', { source: 'manual' });
        this.broadcast({ type: 'actionResult', data: result });
        break;

      case 'setPlayrate':
        const newRate = reaper.setPlayrate(msg.rate);
        this.broadcast({ type: 'playrateChanged', data: { rate: newRate } });
        break;
    }
  }

  setupEventForwarding() {
    // Forward game events
    gameEngine.on('actionProcessed', (data) => {
      this.broadcast({ type: 'actionProcessed', data });
    });

    gameEngine.on('autoReset', (rate) => {
      this.broadcast({ type: 'autoReset', data: { rate } });
    });

    // Forward REAPER events
    reaper.on('playrateChanged', (rate) => {
      this.broadcast({ type: 'playrateChanged', data: { rate } });
    });

    // Forward Twitch events
    twitch.on('rewardsCreated', () => {
      this.broadcast({ type: 'rewardsCreated' });
    });

    twitch.on('rewardsRemoved', () => {
      this.broadcast({ type: 'rewardsRemoved' });
    });
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === 1) { // OPEN
        client.send(data);
      }
    }
  }

  stop() {
    if (this.wss) {
      this.wss.close();
    }
    if (this.server) {
      this.server.close();
    }
  }
}

module.exports = new WebServer();
