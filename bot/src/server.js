const express = require('express');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const gameEngine = require('./game-engine');
const reaper = require('./reaper');
const twitch = require('./twitch');
const streamlabs = require('./streamlabs');
const streamelements = require('./streamelements');
const requests = require('./requests');

class WebServer {
  constructor() {
    this.app = express();
    this.server = null;
    this.wss = null;
    this.clients = new Set();
    this.songsIndex = [];
  }

  /**
   * Load songs index from REAPER www root
   */
  loadSongsIndex() {
    // Try common locations for songs_index.json
    const possiblePaths = [
      path.join(process.env.APPDATA || '', 'REAPER', 'reaper_www_root', 'songs_index.json'),
      path.join(__dirname, '..', '..', '..', 'reaper_www_root', 'songs_index.json'),
      path.join(__dirname, '..', '..', 'www', 'songs_index.json')
    ];

    for (const indexPath of possiblePaths) {
      try {
        if (fs.existsSync(indexPath)) {
          const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
          this.songsIndex = data.songs || [];
          twitch.setSongsIndex(this.songsIndex);
          console.log(`📚 Loaded ${this.songsIndex.length} songs from index`);
          return true;
        }
      } catch (err) {
        console.warn(`Could not load songs index from ${indexPath}:`, err.message);
      }
    }

    console.warn('⚠️ Songs index not found - song requests will not work until index is created');
    return false;
  }

  /**
   * Reload songs index (called when index is updated)
   */
  reloadSongsIndex() {
    this.loadSongsIndex();
    this.broadcast({ type: 'songsIndexReloaded', data: { count: this.songsIndex.length } });
  }

  start() {
    const port = config.get('webPort');

    // Load songs index for requests
    this.loadSongsIndex();

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
        streamelements: streamelements.getStatus(),
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

    // ============ SONG REQUESTS API ============

    // Get request queue
    this.app.get('/api/requests', (req, res) => {
      res.json({
        queue: requests.serializeForWeb(),
        enabled: config.get('requests.enabled'),
        config: config.get('requests')
      });
    });

    // Get request statistics
    this.app.get('/api/requests/stats', (req, res) => {
      res.json(requests.getStats());
    });

    // Get request log
    this.app.get('/api/requests/log', (req, res) => {
      const count = parseInt(req.query.count) || 50;
      res.json(requests.getRecentLog(count));
    });

    // Export full request log
    this.app.get('/api/requests/log/export', (req, res) => {
      res.json(requests.exportLog());
    });

    // Toggle requests enabled
    this.app.post('/api/requests/toggle', (req, res) => {
      const { enabled } = req.body;
      config.set('requests.enabled', enabled);
      this.broadcast({ type: 'requestsToggled', data: { enabled } });
      res.json({ success: true, enabled });
    });

    // Add request manually (from web panel)
    this.app.post('/api/requests/add', (req, res) => {
      const { songId, username = 'Manual', userId = 'manual_' + Date.now() } = req.body;

      // Find song in index
      const song = this.songsIndex.find(s => s.id === songId);
      if (!song) {
        return res.status(404).json({ success: false, message: 'Song not found' });
      }

      const result = requests.addRequest(userId, username, song, { displayName: username });
      this.broadcast({ type: 'requestQueueUpdated', data: { queue: requests.serializeForWeb() } });
      res.json(result);
    });

    // Remove request
    this.app.delete('/api/requests/:requestId', (req, res) => {
      const { requestId } = req.params;
      const result = requests.removeRequest(requestId, true, 'WebPanel');
      this.broadcast({ type: 'requestQueueUpdated', data: { queue: requests.serializeForWeb() } });
      res.json(result);
    });

    // Complete request (mark as played)
    this.app.post('/api/requests/:requestId/complete', (req, res) => {
      const { requestId } = req.params;
      const completed = requests.completeRequest(requestId);
      this.broadcast({ type: 'requestQueueUpdated', data: { queue: requests.serializeForWeb() } });
      if (completed) {
        res.json({ success: true, request: completed });
      } else {
        res.status(404).json({ success: false, message: 'Request not found' });
      }
    });

    // Clear entire request queue
    this.app.post('/api/requests/clear', (req, res) => {
      const count = requests.clearQueue();
      this.broadcast({ type: 'requestQueueUpdated', data: { queue: [] } });
      res.json({ success: true, cleared: count });
    });

    // Reload songs index
    this.app.post('/api/songs/reload', (req, res) => {
      this.reloadSongsIndex();
      res.json({ success: true, count: this.songsIndex.length });
    });

    // Search songs (for web autocomplete)
    this.app.get('/api/songs/search', (req, res) => {
      const query = (req.query.q || '').toLowerCase().trim();
      if (!query) {
        return res.json({ songs: [] });
      }

      const matches = this.songsIndex
        .filter(s =>
          s.t.toLowerCase().includes(query) ||
          s.a.toLowerCase().includes(query)
        )
        .slice(0, 20);

      res.json({ songs: matches });
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
          state: gameEngine.getState(),
          requestQueue: requests.serializeForWeb(),
          requestsEnabled: config.get('requests.enabled')
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

      case 'updateBpm':
        // GameHUD can send BPM updates
        if (msg.bpm > 0) {
          reaper.setBpm(msg.bpm);
          this.broadcast({ type: 'bpmChanged', data: { bpm: msg.bpm } });
        }
        break;

      // ============ TEST COMMANDS ============

      case 'testAction':
        // Test action - actually changes playrate in REAPER
        const currentRate = reaper.getPlayrate();
        const gameConfig = config.get('game');
        const minRate = gameConfig.minPlayrate || 0.5;
        const maxRate = gameConfig.maxPlayrate || 4.0;
        const testPlayrate = {
          speedUp: Math.min(maxRate, currentRate + 0.15),
          slowDown: Math.max(minRate, currentRate - 0.15),
          chaos: minRate + Math.random() * (maxRate - minRate),
          reset: gameConfig.defaultPlayrate || 1.0
        }[msg.action] || 1.0;

        // Actually set the playrate in REAPER
        reaper.setPlayrate(testPlayrate);

        // Sample Twitch avatars for testing
        const testAvatars = [
          'https://static-cdn.jtvnw.net/jtv_user_pictures/8a6381c7-d0c0-4576-b179-38bd5ce1d6af-profile_image-300x300.png',
          'https://static-cdn.jtvnw.net/jtv_user_pictures/dallas-profile_image-1a2c906ee2c35f12-300x300.png',
          'https://static-cdn.jtvnw.net/jtv_user_pictures/3f13ab61-ec78-4fe6-8481-8682cb3b0ac2-profile_image-300x300.png'
        ];

        this.broadcast({
          type: 'actionProcessed',
          data: {
            action: msg.action,
            username: msg.username || 'TEST_USER',
            newRate: testPlayrate,
            source: 'test',
            avatarUrl: testAvatars[Math.floor(Math.random() * testAvatars.length)]
          }
        });
        break;

      case 'testCountdown':
        // Start a test countdown
        this.broadcast({
          type: 'testCountdown',
          data: { seconds: msg.seconds || 15 }
        });
        break;

      case 'testCancelCountdown':
        this.broadcast({ type: 'testCancelCountdown' });
        break;

      case 'testVisualEffect':
        // Pass through visual effect test to GameHUD
        this.broadcast({
          type: 'testVisualEffect',
          data: { effect: msg.effect }
        });
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

    // Forward request events from Twitch
    twitch.on('requestAdded', (request) => {
      this.broadcast({ type: 'requestAdded', data: request });
      this.broadcast({ type: 'requestQueueUpdated', data: { queue: requests.serializeForWeb() } });
    });

    twitch.on('requestRemoved', (request) => {
      this.broadcast({ type: 'requestRemoved', data: request });
      this.broadcast({ type: 'requestQueueUpdated', data: { queue: requests.serializeForWeb() } });
    });

    // Forward request events from requests module
    requests.on('requestCompleted', (request) => {
      this.broadcast({ type: 'requestCompleted', data: request });
    });

    requests.on('queueCleared', () => {
      this.broadcast({ type: 'requestQueueCleared' });
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
