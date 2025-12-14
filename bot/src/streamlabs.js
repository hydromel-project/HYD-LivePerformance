const { io } = require('socket.io-client');
const config = require('./config');
const gameEngine = require('./game-engine');
const twitch = require('./twitch');
const EventEmitter = require('events');

class StreamlabsIntegration extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
  }

  /**
   * Connect to Streamlabs Socket API
   */
  connect() {
    const token = config.get('streamlabs.socketToken');

    if (!token) {
      console.log('⚠️ Streamlabs not configured - skipping connection');
      return false;
    }

    const socketUrl = `https://sockets.streamlabs.com?token=${token}`;

    this.socket = io(socketUrl, {
      transports: ['websocket']
    });

    this.socket.on('connect', () => {
      console.log('💜 Streamlabs connected');
      this.connected = true;
      this.emit('connected');
    });

    this.socket.on('disconnect', () => {
      console.log('💜 Streamlabs disconnected');
      this.connected = false;
      this.emit('disconnected');
    });

    this.socket.on('event', (event) => {
      this.handleEvent(event);
    });

    this.socket.on('error', (err) => {
      console.error('Streamlabs error:', err);
      this.emit('error', err);
    });

    return true;
  }

  /**
   * Handle Streamlabs events
   */
  handleEvent(event) {
    // Streamlabs sends various event types
    const type = event.type;
    const forPlatform = event.for; // 'twitch_account', 'youtube_account', etc.

    if (type === 'donation') {
      this.handleDonation(event);
    } else if (type === 'bits') {
      this.handleBits(event);
    }
    // Can also handle: subscription, follow, host, raid, etc.
  }

  /**
   * Handle donation event
   */
  handleDonation(event) {
    const donationsConfig = config.get('donations');
    if (!donationsConfig.enabled) return;

    for (const message of event.message) {
      const amount = parseFloat(message.amount);
      const username = message.name || message.from;
      const currency = message.currency;

      console.log(`💰 Donation: ${username} - ${currency}${amount}`);

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
          currency: currency
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

        this.emit('donationProcessed', {
          username,
          amount,
          currency,
          action: matchingAction.action,
          result
        });
      }
    }
  }

  /**
   * Handle bits event
   */
  handleBits(event) {
    // Bits can be handled similarly to donations
    // Convert bits to dollar equivalent (100 bits ≈ $1)
    for (const message of event.message) {
      const bits = parseInt(message.amount);
      const username = message.name;
      const dollarEquivalent = bits / 100;

      console.log(`💎 Bits: ${username} - ${bits} bits (~$${dollarEquivalent.toFixed(2)})`);

      // You could process bits similarly to donations
      // Or have separate bit thresholds
      this.emit('bitsReceived', {
        username,
        bits,
        dollarEquivalent
      });
    }
  }

  /**
   * Disconnect from Streamlabs
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
      configured: !!config.get('streamlabs.socketToken')
    };
  }
}

module.exports = new StreamlabsIntegration();
