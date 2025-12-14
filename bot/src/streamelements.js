const { io } = require('socket.io-client');
const config = require('./config');
const gameEngine = require('./game-engine');
const twitch = require('./twitch');
const EventEmitter = require('events');

class StreamElementsIntegration extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
  }

  /**
   * Connect to StreamElements Socket API
   */
  connect() {
    const jwtToken = config.get('streamelements.jwtToken');

    if (!jwtToken) {
      console.log('⚠️ StreamElements not configured - skipping connection');
      return false;
    }

    this.socket = io('https://realtime.streamelements.com', {
      transports: ['websocket']
    });

    this.socket.on('connect', () => {
      console.log('🟢 StreamElements socket connected, authenticating...');
      this.socket.emit('authenticate', { method: 'jwt', token: jwtToken });
    });

    this.socket.on('authenticated', (data) => {
      console.log('🟢 StreamElements authenticated');
      this.connected = true;
      this.emit('connected');
    });

    this.socket.on('unauthorized', (err) => {
      console.error('StreamElements auth failed:', err.message || err);
      this.emit('error', new Error('Authentication failed'));
    });

    this.socket.on('disconnect', () => {
      console.log('🟢 StreamElements disconnected');
      this.connected = false;
      this.emit('disconnected');
    });

    // Listen for tip events
    this.socket.on('event:test', (event) => {
      // Test events from StreamElements dashboard
      this.handleEvent(event);
    });

    this.socket.on('event', (event) => {
      this.handleEvent(event);
    });

    this.socket.on('error', (err) => {
      console.error('StreamElements error:', err);
      this.emit('error', err);
    });

    return true;
  }

  /**
   * Handle StreamElements events
   */
  handleEvent(event) {
    const type = event.type;

    if (type === 'tip') {
      this.handleTip(event);
    } else if (type === 'cheer') {
      this.handleCheer(event);
    }
    // Can also handle: subscriber, follow, host, raid, etc.
  }

  /**
   * Handle tip/donation event
   */
  handleTip(event) {
    const donationsConfig = config.get('donations');
    if (!donationsConfig.enabled) return;

    const data = event.data;
    const amount = parseFloat(data.amount);
    const username = data.username || data.displayName || 'Anonymous';
    const currency = data.currency || 'USD';

    console.log(`💰 StreamElements Tip: ${username} - ${currency}${amount}`);

    // Find matching action based on amount
    const matchingAction = donationsConfig.actions.find(action => {
      const minOk = amount >= action.minAmount;
      const maxOk = action.maxAmount === null || amount <= action.maxAmount;
      return minOk && maxOk;
    });

    if (matchingAction) {
      const result = gameEngine.processAction(matchingAction.action, username, {
        source: 'donation',
        amount: amount,
        currency: currency,
        platform: 'streamelements'
      });

      // Send chat announcement
      if (config.get('game.announcements.enabled')) {
        let message = matchingAction.message || result.message;
        message = message
          .replace('{user}', username)
          .replace('{amount}', amount.toFixed(2))
          .replace('{rate}', result.newRate?.toFixed(2) || '');

        twitch.sendChat(message);
      }

      this.emit('tipProcessed', {
        username,
        amount,
        currency,
        action: matchingAction.action,
        result
      });
    }
  }

  /**
   * Handle cheer/bits event
   */
  handleCheer(event) {
    const data = event.data;
    const bits = parseInt(data.amount);
    const username = data.username || data.displayName;
    const dollarEquivalent = bits / 100;

    console.log(`💎 StreamElements Cheer: ${username} - ${bits} bits (~$${dollarEquivalent.toFixed(2)})`);

    this.emit('cheerReceived', {
      username,
      bits,
      dollarEquivalent
    });
  }

  /**
   * Disconnect from StreamElements
   */
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.connected,
      configured: !!config.get('streamelements.jwtToken')
    };
  }
}

module.exports = new StreamElementsIntegration();
