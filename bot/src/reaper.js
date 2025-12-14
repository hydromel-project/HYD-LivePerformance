const osc = require('osc');
const config = require('./config');
const EventEmitter = require('events');

class ReaperOSC extends EventEmitter {
  constructor() {
    super();
    this.udpPort = null;
    this.currentPlayrate = 1.0;
    this.connected = false;
  }

  connect() {
    const reaperConfig = config.get('reaper');

    this.udpPort = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: reaperConfig.receivePort,
      remoteAddress: reaperConfig.host,
      remotePort: reaperConfig.sendPort,
      metadata: true
    });

    this.udpPort.on('ready', () => {
      console.log('📡 OSC connected to REAPER');
      console.log(`   Sending to ${reaperConfig.host}:${reaperConfig.sendPort}`);
      console.log(`   Listening on port ${reaperConfig.receivePort}`);
      this.connected = true;
      this.emit('connected');

      // Request current playrate
      this.requestPlayrate();
    });

    this.udpPort.on('message', (oscMsg) => {
      this.handleMessage(oscMsg);
    });

    this.udpPort.on('error', (err) => {
      console.error('OSC error:', err.message);
      this.connected = false;
      this.emit('error', err);
    });

    this.udpPort.open();
  }

  disconnect() {
    if (this.udpPort) {
      this.udpPort.close();
      this.connected = false;
      console.log('📡 OSC disconnected');
    }
  }

  handleMessage(oscMsg) {
    const address = oscMsg.address;
    const args = oscMsg.args;

    // Handle playrate feedback from REAPER
    if (address === '/playrate' || address === '/master/playrate') {
      if (args && args.length > 0) {
        this.currentPlayrate = args[0].value;
        this.emit('playrateChanged', this.currentPlayrate);
      }
    }

    // Handle transport state
    if (address === '/play') {
      this.emit('transportChanged', { playing: args[0]?.value === 1 });
    }
  }

  requestPlayrate() {
    // Send request for current playrate
    this.send('/device/playrate/str', []);
  }

  /**
   * Set the playrate in REAPER
   * @param {number} rate - Playrate value (e.g., 1.0, 1.5, 0.75)
   */
  setPlayrate(rate) {
    const gameConfig = config.get('game');

    // Clamp to bounds
    rate = Math.max(gameConfig.minPlayrate, Math.min(gameConfig.maxPlayrate, rate));
    rate = Math.round(rate * 100) / 100; // Round to 2 decimal places

    // REAPER expects playrate as a normalized value for the slider (0-1)
    // But we can also use the action approach
    // The /playrate address expects the actual rate value

    this.send('/playrate', [{ type: 'f', value: rate }]);
    this.currentPlayrate = rate;
    this.emit('playrateChanged', rate);

    return rate;
  }

  /**
   * Adjust playrate by an increment
   * @param {number} delta - Amount to add (positive) or subtract (negative)
   */
  adjustPlayrate(delta) {
    const newRate = this.currentPlayrate + delta;
    return this.setPlayrate(newRate);
  }

  /**
   * Set a random playrate within bounds
   */
  setRandomPlayrate() {
    const gameConfig = config.get('game');
    const min = gameConfig.minPlayrate;
    const max = gameConfig.maxPlayrate;
    const randomRate = min + Math.random() * (max - min);
    return this.setPlayrate(randomRate);
  }

  /**
   * Reset playrate to default
   */
  resetPlayrate() {
    const gameConfig = config.get('game');
    return this.setPlayrate(gameConfig.defaultPlayrate);
  }

  /**
   * Get current playrate
   */
  getPlayrate() {
    return this.currentPlayrate;
  }

  /**
   * Check if we can increase playrate
   */
  canSpeedUp() {
    const gameConfig = config.get('game');
    return this.currentPlayrate < gameConfig.maxPlayrate;
  }

  /**
   * Check if we can decrease playrate
   */
  canSlowDown() {
    const gameConfig = config.get('game');
    return this.currentPlayrate > gameConfig.minPlayrate;
  }

  /**
   * Send an OSC message to REAPER
   */
  send(address, args) {
    if (!this.connected || !this.udpPort) {
      console.warn('OSC not connected, cannot send:', address);
      return;
    }

    this.udpPort.send({
      address: address,
      args: args
    });
  }

  /**
   * Trigger a REAPER action by ID
   */
  triggerAction(actionId) {
    this.send('/action/' + actionId, [{ type: 'i', value: 1 }]);
  }
}

module.exports = new ReaperOSC();
