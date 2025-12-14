const osc = require('osc');
const config = require('./config');
const EventEmitter = require('events');

class ReaperOSC extends EventEmitter {
  constructor() {
    super();
    this.udpPort = null;
    this.currentPlayrate = 1.0;
    this.currentBpm = 120;
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

    // Handle tempo/BPM feedback
    if (address === '/tempo' || address === '/master/tempo' || address === '/bpm') {
      if (args && args.length > 0) {
        this.currentBpm = args[0].value;
        this.emit('bpmChanged', this.currentBpm);
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

    // REAPER OSC expects a normalized value (0-1) for /playrate
    // REAPER's playrate range is 0.25x to 4x (linear scale)
    // 0.0 = 0.25x, 0.2 = 1.0x, 1.0 = 4.0x
    const minRate = 0.25;
    const maxRate = 4.0;
    const normalized = (rate - minRate) / (maxRate - minRate);
    const clampedNormalized = Math.max(0, Math.min(1, normalized));

    this.send('/playrate', [{ type: 'f', value: clampedNormalized }]);
    this.currentPlayrate = rate;
    this.emit('playrateChanged', rate);

    console.log(`📡 Set playrate: ${rate}x (normalized: ${clampedNormalized.toFixed(3)})`);

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
   * Get current BPM
   */
  getBpm() {
    return this.currentBpm;
  }

  /**
   * Set BPM (from external source like GameHUD)
   */
  setBpm(bpm) {
    if (bpm > 0) {
      this.currentBpm = bpm;
      this.emit('bpmChanged', bpm);
    }
  }

  /**
   * Calculate scaled increment based on current BPM
   * Keeps the effective BPM change consistent regardless of tempo
   */
  getScaledIncrement(baseIncrement) {
    const scalingConfig = config.get('game.proportionalScaling');

    if (!scalingConfig || !scalingConfig.enabled) {
      return baseIncrement;
    }

    const referenceBpm = scalingConfig.referenceBpm || 120;
    const currentBpm = this.currentBpm || 120;

    // Scale: at higher BPM, use smaller increment
    // Formula: actualIncrement = baseIncrement * (referenceBpm / currentBpm)
    const scaledIncrement = baseIncrement * (referenceBpm / currentBpm);

    // Round to 3 decimal places
    return Math.round(scaledIncrement * 1000) / 1000;
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
