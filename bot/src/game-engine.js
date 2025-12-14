const config = require('./config');
const reaper = require('./reaper');
const EventEmitter = require('events');

class GameEngine extends EventEmitter {
  constructor() {
    super();
    this.lastActionTime = 0;
    this.autoResetTimer = null;
    this.actionHistory = [];
  }

  /**
   * Check if game mode is enabled
   */
  isEnabled() {
    return config.get('game.enabled');
  }

  /**
   * Enable/disable game mode
   */
  setEnabled(enabled) {
    config.set('game.enabled', enabled);
    this.emit('enabledChanged', enabled);

    if (!enabled) {
      this.clearAutoReset();
    }

    return enabled;
  }

  /**
   * Check if global cooldown is active
   */
  isOnCooldown() {
    const cooldownConfig = config.get('game.globalCooldown');
    if (!cooldownConfig.enabled) return false;

    const elapsed = (Date.now() - this.lastActionTime) / 1000;
    return elapsed < cooldownConfig.seconds;
  }

  /**
   * Get remaining cooldown time in seconds
   */
  getCooldownRemaining() {
    const cooldownConfig = config.get('game.globalCooldown');
    if (!cooldownConfig.enabled) return 0;

    const elapsed = (Date.now() - this.lastActionTime) / 1000;
    const remaining = cooldownConfig.seconds - elapsed;
    return Math.max(0, Math.ceil(remaining));
  }

  /**
   * Process an action request
   * @param {string} action - 'speedUp', 'slowDown', 'chaos', 'reset'
   * @param {string} username - User who triggered the action
   * @param {object} options - Additional options (source: 'channelPoints' | 'donation')
   * @returns {object} Result with success status and message
   */
  processAction(action, username, options = {}) {
    if (!this.isEnabled()) {
      return { success: false, reason: 'disabled', message: 'Game mode is not active' };
    }

    if (this.isOnCooldown()) {
      const remaining = this.getCooldownRemaining();
      return {
        success: false,
        reason: 'cooldown',
        message: this.formatMessage('cooldownActive', { seconds: remaining }),
        cooldownRemaining: remaining
      };
    }

    let result;
    const rewardConfig = config.get(`rewards.${action}`);

    switch (action) {
      case 'speedUp':
        result = this.speedUp(username, rewardConfig?.increment || 0.1);
        break;
      case 'slowDown':
        result = this.slowDown(username, rewardConfig?.increment || 0.1);
        break;
      case 'chaos':
        result = this.chaos(username);
        break;
      case 'reset':
        result = this.reset(username);
        break;
      default:
        return { success: false, reason: 'unknown', message: 'Unknown action' };
    }

    if (result.success) {
      this.lastActionTime = Date.now();
      this.addToHistory(action, username, result.newRate, options.source);
      this.scheduleAutoReset();
      this.emit('actionProcessed', { action, username, ...result, source: options.source, avatarUrl: options.avatarUrl });
    }

    return result;
  }

  speedUp(username, increment = 0.1) {
    if (!reaper.canSpeedUp()) {
      return {
        success: false,
        reason: 'maxReached',
        message: this.formatMessage('maxReached', { user: username })
      };
    }

    // Apply proportional scaling based on current BPM
    const scaledIncrement = reaper.getScaledIncrement(increment);
    const newRate = reaper.adjustPlayrate(scaledIncrement);

    return {
      success: true,
      action: 'speedUp',
      newRate: newRate,
      baseIncrement: increment,
      scaledIncrement: scaledIncrement,
      bpm: reaper.getBpm(),
      message: this.formatMessage('speedUp', { user: username, rate: newRate.toFixed(2) })
    };
  }

  slowDown(username, increment = 0.1) {
    if (!reaper.canSlowDown()) {
      return {
        success: false,
        reason: 'minReached',
        message: this.formatMessage('minReached', { user: username })
      };
    }

    // Apply proportional scaling based on current BPM
    const scaledIncrement = reaper.getScaledIncrement(increment);
    const newRate = reaper.adjustPlayrate(-scaledIncrement);

    return {
      success: true,
      action: 'slowDown',
      newRate: newRate,
      baseIncrement: increment,
      scaledIncrement: scaledIncrement,
      bpm: reaper.getBpm(),
      message: this.formatMessage('slowDown', { user: username, rate: newRate.toFixed(2) })
    };
  }

  chaos(username) {
    const newRate = reaper.setRandomPlayrate();
    return {
      success: true,
      action: 'chaos',
      newRate: newRate,
      message: this.formatMessage('chaos', { user: username, rate: newRate.toFixed(2) })
    };
  }

  reset(username) {
    const newRate = reaper.resetPlayrate();
    return {
      success: true,
      action: 'reset',
      newRate: newRate,
      message: this.formatMessage('reset', { user: username, rate: newRate.toFixed(2) })
    };
  }

  /**
   * Format announcement message with placeholders
   */
  formatMessage(type, data) {
    const template = config.get(`game.announcements.${type}`) || '';
    return template.replace(/\{(\w+)\}/g, (match, key) => data[key] || match);
  }

  /**
   * Schedule auto-reset if enabled
   */
  scheduleAutoReset() {
    const autoResetConfig = config.get('game.autoReset');
    if (!autoResetConfig.enabled) return;

    this.clearAutoReset();

    this.autoResetTimer = setTimeout(() => {
      const currentRate = reaper.getPlayrate();
      if (currentRate !== autoResetConfig.resetTo) {
        reaper.setPlayrate(autoResetConfig.resetTo);
        this.emit('autoReset', autoResetConfig.resetTo);
      }
    }, autoResetConfig.delaySeconds * 1000);
  }

  /**
   * Clear auto-reset timer
   */
  clearAutoReset() {
    if (this.autoResetTimer) {
      clearTimeout(this.autoResetTimer);
      this.autoResetTimer = null;
    }
  }

  /**
   * Add action to history
   */
  addToHistory(action, username, newRate, source) {
    this.actionHistory.unshift({
      action,
      username,
      newRate,
      source,
      timestamp: Date.now()
    });

    // Keep last 50 actions
    if (this.actionHistory.length > 50) {
      this.actionHistory.pop();
    }
  }

  /**
   * Get action history
   */
  getHistory() {
    return this.actionHistory;
  }

  /**
   * Get current game state
   */
  getState() {
    const scalingConfig = config.get('game.proportionalScaling') || {};

    return {
      enabled: this.isEnabled(),
      currentPlayrate: reaper.getPlayrate(),
      currentBpm: reaper.getBpm(),
      onCooldown: this.isOnCooldown(),
      cooldownRemaining: this.getCooldownRemaining(),
      canSpeedUp: reaper.canSpeedUp(),
      canSlowDown: reaper.canSlowDown(),
      minPlayrate: config.get('game.minPlayrate'),
      maxPlayrate: config.get('game.maxPlayrate'),
      proportionalScaling: {
        enabled: scalingConfig.enabled ?? false,
        referenceBpm: scalingConfig.referenceBpm || 120
      },
      history: this.actionHistory.slice(0, 10)
    };
  }
}

module.exports = new GameEngine();
