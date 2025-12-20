const osc = require('osc');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const EventEmitter = require('events');

class ReaperOSC extends EventEmitter {
  constructor() {
    super();
    this.udpPort = null;
    this.currentPlayrate = 1.0;
    this.currentBpm = 120;
    this.connected = false;

    // Measure-sync state
    this.measureSync = {
      enabled: false,
      pendingChange: null,
      currentMeasure: 0,
      currentBeat: 0,
      beatsInMeasure: 4,
      countdown: 0,
      pollInterval: null,
      lastStatus: null
    };

    // File paths for ReaScript communication
    // These need to match the paths in HYD-MeasureSync.lua
    this.measureSyncPaths = {
      command: null,  // Will be set based on REAPER resource path
      status: null
    };
  }

  /**
   * Initialize measure-sync file paths
   * @param {string} reaperResourcePath - Path to REAPER resource folder
   */
  initMeasureSyncPaths(reaperResourcePath) {
    const basePath = path.join(reaperResourcePath, 'Scripts', 'HYD-LivePerformance');
    this.measureSyncPaths.command = path.join(basePath, 'measureSync_command.json');
    this.measureSyncPaths.status = path.join(basePath, 'measureSync_status.json');
    console.log('📐 Measure-sync paths initialized:', basePath);
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

  // ============================================================================
  // MEASURE-SYNC METHODS
  // ============================================================================

  /**
   * Send a command to the MeasureSync ReaScript
   */
  sendMeasureSyncCommand(command) {
    if (!this.measureSyncPaths.command) {
      console.warn('Measure-sync paths not initialized');
      return false;
    }

    try {
      fs.writeFileSync(this.measureSyncPaths.command, JSON.stringify(command));
      return true;
    } catch (err) {
      console.error('Failed to write measure-sync command:', err.message);
      return false;
    }
  }

  /**
   * Read status from the MeasureSync ReaScript
   */
  readMeasureSyncStatus() {
    if (!this.measureSyncPaths.status) {
      return null;
    }

    try {
      if (!fs.existsSync(this.measureSyncPaths.status)) {
        return null;
      }
      const content = fs.readFileSync(this.measureSyncPaths.status, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      // File might be being written, ignore errors
      return null;
    }
  }

  /**
   * Enable measure-sync mode
   */
  enableMeasureSync() {
    this.measureSync.enabled = true;
    this.sendMeasureSyncCommand({ action: 'enable' });
    this.startMeasureSyncPolling();
    console.log('📐 Measure-sync enabled');
    this.emit('measureSyncEnabled');
  }

  /**
   * Disable measure-sync mode
   */
  disableMeasureSync() {
    this.measureSync.enabled = false;
    this.measureSync.pendingChange = null;
    this.sendMeasureSyncCommand({ action: 'disable' });
    this.stopMeasureSyncPolling();
    console.log('📐 Measure-sync disabled');
    this.emit('measureSyncDisabled');
  }

  /**
   * Queue a speed change for measure-sync execution
   * @param {number} newRate - The new playrate to set
   * @param {number} warningBeats - Beats of warning before change
   * @param {number} preCountBars - Pre-count bars after change
   */
  queueSpeedChange(newRate, warningBeats = 4, preCountBars = 1) {
    const gameConfig = config.get('game');

    // Clamp to bounds
    newRate = Math.max(gameConfig.minPlayrate, Math.min(gameConfig.maxPlayrate, newRate));
    newRate = Math.round(newRate * 100) / 100;

    this.measureSync.pendingChange = {
      newRate,
      warningBeats,
      preCountBars,
      queuedAt: Date.now()
    };

    this.sendMeasureSyncCommand({
      action: 'queue',
      newRate,
      warningBeats,
      preCountBars
    });

    console.log(`📐 Queued speed change: ${newRate}x in ${warningBeats} beats`);
    this.emit('speedChangeQueued', {
      newRate,
      warningBeats,
      preCountBars
    });

    return true;
  }

  /**
   * Cancel a pending speed change
   */
  cancelPendingChange() {
    if (this.measureSync.pendingChange) {
      this.measureSync.pendingChange = null;
      this.measureSync.countdown = 0;
      this.sendMeasureSyncCommand({ action: 'cancel' });
      console.log('📐 Pending speed change cancelled');
      this.emit('speedChangeCancelled');
    }
  }

  /**
   * Execute pending change immediately (skip waiting)
   */
  executePendingChangeNow() {
    if (this.measureSync.pendingChange) {
      this.sendMeasureSyncCommand({ action: 'executeNow' });
    }
  }

  /**
   * Start polling for measure-sync status updates
   */
  startMeasureSyncPolling() {
    if (this.measureSync.pollInterval) {
      return; // Already polling
    }

    let lastStatusTime = Date.now();
    let reaScriptRunning = false;
    let hadPendingChange = false;

    this.measureSync.pollInterval = setInterval(() => {
      const status = this.readMeasureSyncStatus();

      // Check if ReaScript is running (status file exists and is recent)
      if (status) {
        lastStatusTime = Date.now();

        // Check for shutdown signal
        if (status.shutdown) {
          if (reaScriptRunning) {
            console.log('📐 ReaScript shut down');
            reaScriptRunning = false;
            this.emit('measureSyncReaScriptStopped');
          }
          return;
        }

        if (!reaScriptRunning) {
          console.log('📐 ReaScript detected and running');
          reaScriptRunning = true;
          this.emit('measureSyncReaScriptStarted');
        }

        // Update local state
        this.measureSync.currentMeasure = status.measure || 0;
        this.measureSync.currentBeat = status.beat || 0;
        this.measureSync.beatsInMeasure = status.beatsInMeasure || 4;
        this.measureSync.countdown = status.countdown || 0;

        // Track pending change state
        const statusChanged = JSON.stringify(status) !== JSON.stringify(this.measureSync.lastStatus);

        if (statusChanged) {
          this.measureSync.lastStatus = status;

          // Emit countdown update for UI
          this.emit('measureSyncUpdate', {
            measure: status.measure,
            beat: status.beat,
            beatsInMeasure: status.beatsInMeasure,
            countdown: status.countdown,
            hasPending: status.hasPending,
            pendingRate: status.pendingRate,
            isExecuting: status.isExecuting,
            playrate: status.playrate,
            totalBeats: status.totalBeats || 0
          });
        }

        // Detect when change was executed:
        // We had a pending change, and now ReaScript reports no pending change
        if (hadPendingChange && !status.hasPending && !status.isExecuting) {
          if (this.measureSync.pendingChange) {
            const executedRate = this.measureSync.pendingChange.newRate;
            this.measureSync.pendingChange = null;
            this.currentPlayrate = executedRate;
            console.log(`📐 Speed change executed: ${executedRate}x`);
            this.emit('speedChangeExecuted', { newRate: executedRate });
            this.emit('playrateChanged', executedRate);
          }
          hadPendingChange = false;
        }

        // Track if we have a pending change
        if (status.hasPending) {
          hadPendingChange = true;
        }

      } else {
        // No status file - ReaScript might not be running
        const timeSinceLastStatus = Date.now() - lastStatusTime;
        if (reaScriptRunning && timeSinceLastStatus > 2000) {
          console.log('📐 ReaScript appears to have stopped (no status for 2s)');
          reaScriptRunning = false;
          this.emit('measureSyncReaScriptStopped');
        }
      }
    }, 50); // Poll every 50ms for responsiveness
  }

  /**
   * Stop polling for measure-sync status
   */
  stopMeasureSyncPolling() {
    if (this.measureSync.pollInterval) {
      clearInterval(this.measureSync.pollInterval);
      this.measureSync.pollInterval = null;
    }
  }

  /**
   * Check if measure-sync mode is enabled
   */
  isMeasureSyncEnabled() {
    return this.measureSync.enabled;
  }

  /**
   * Check if there's a pending speed change
   */
  hasPendingChange() {
    return this.measureSync.pendingChange !== null;
  }

  /**
   * Get pending change info
   */
  getPendingChange() {
    return this.measureSync.pendingChange;
  }

  /**
   * Get current measure-sync state
   */
  getMeasureSyncState() {
    return {
      enabled: this.measureSync.enabled,
      pendingChange: this.measureSync.pendingChange,
      currentMeasure: this.measureSync.currentMeasure,
      currentBeat: this.measureSync.currentBeat,
      beatsInMeasure: this.measureSync.beatsInMeasure,
      countdown: this.measureSync.countdown
    };
  }
}

module.exports = new ReaperOSC();
