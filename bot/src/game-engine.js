const config = require('./config');
const reaper = require('./reaper');
const EventEmitter = require('events');

class GameEngine extends EventEmitter {
  constructor() {
    super();
    this.lastActionTime = 0;
    this.autoResetTimer = null;
    this.actionHistory = [];
    this.lastPriceUpdate = 0;
  }

  /**
   * Calculate dynamic prices based on current playrate
   * @param {number} playrate - Current playrate (e.g., 1.0, 1.5, 0.75)
   * @returns {object} New prices for each reward
   */
  calculateDynamicPrices(playrate) {
    const rewardsConfig = config.get('rewards');
    const pricing = rewardsConfig.dynamicPricing || {};

    if (!pricing.enabled) {
      return {
        speedUp: rewardsConfig.speedUp?.baseCost || 500,
        slowDown: rewardsConfig.slowDown?.baseCost || 500,
        chaos: rewardsConfig.chaos?.baseCost || 2500,
        reset: rewardsConfig.reset?.baseCost || 1500
      };
    }

    const scaleFactor = pricing.scaleFactor || 1.5;
    const minCost = pricing.minCost || 100;
    const maxCost = pricing.maxCost || 50000;

    // Distance from normal (1.0x)
    const distanceFromNormal = Math.abs(playrate - 1.0);
    // How fast are we going? (above or below 1.0)
    const isFast = playrate > 1.0;
    const isSlow = playrate < 1.0;

    // Base multiplier increases with distance from 1.0x
    // At 2.0x or 0.5x (distance = 0.5-1.0), prices increase significantly
    const baseMultiplier = 1 + (distanceFromNormal * scaleFactor);

    // Speed Up: More expensive when already fast, cheaper when slow
    // Going from 2.0x to 2.1x should cost more than 1.0x to 1.1x
    let speedUpMultiplier = 1;
    if (isFast) {
      // Exponential scaling when speeding up from already fast
      speedUpMultiplier = Math.pow(baseMultiplier, 1.5);
    } else if (isSlow) {
      // Slightly cheaper to speed up when slow (helping hand)
      speedUpMultiplier = Math.max(0.5, 1 - (distanceFromNormal * 0.5));
    }

    // Slow Down: More expensive when already slow, cheaper when fast
    let slowDownMultiplier = 1;
    if (isSlow) {
      // Exponential scaling when slowing from already slow
      slowDownMultiplier = Math.pow(baseMultiplier, 1.5);
    } else if (isFast) {
      // Slightly cheaper to slow down when fast (mercy)
      slowDownMultiplier = Math.max(0.5, 1 - (distanceFromNormal * 0.3));
    }

    // Chaos: Always expensive, but MORE expensive at extremes
    // (more chaotic when already in a weird state)
    const chaosMultiplier = 1 + (distanceFromNormal * scaleFactor * 0.5);

    // Reset: Gets CHEAPER at extremes if mercy rule enabled
    // (escape valve when things get crazy)
    let resetMultiplier = 1;
    if (pricing.resetDiscountAtExtremes && distanceFromNormal > 0.5) {
      // Up to 50% discount at extreme speeds
      resetMultiplier = Math.max(0.5, 1 - (distanceFromNormal * 0.4));
    }

    // Calculate final prices
    const clamp = (val) => Math.round(Math.min(maxCost, Math.max(minCost, val)));

    return {
      speedUp: clamp((rewardsConfig.speedUp?.baseCost || 500) * speedUpMultiplier),
      slowDown: clamp((rewardsConfig.slowDown?.baseCost || 500) * slowDownMultiplier),
      chaos: clamp((rewardsConfig.chaos?.baseCost || 2500) * chaosMultiplier),
      reset: clamp((rewardsConfig.reset?.baseCost || 1500) * resetMultiplier)
    };
  }

  /**
   * Update reward prices and emit event for Twitch update
   */
  updatePrices(playrate) {
    const rewardsConfig = config.get('rewards');
    if (!rewardsConfig.dynamicPricing?.enabled) return null;

    // Throttle updates to avoid API spam (max once per 2 seconds)
    const now = Date.now();
    if (now - this.lastPriceUpdate < 2000) return null;
    this.lastPriceUpdate = now;

    const newPrices = this.calculateDynamicPrices(playrate);

    // Update config with new prices
    config.set('rewards.speedUp.cost', newPrices.speedUp);
    config.set('rewards.slowDown.cost', newPrices.slowDown);
    config.set('rewards.chaos.cost', newPrices.chaos);
    config.set('rewards.reset.cost', newPrices.reset);

    // Emit event for Twitch module to update rewards
    this.emit('pricesUpdated', newPrices);

    return newPrices;
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

      // Update dynamic prices based on new playrate
      const newPrices = this.updatePrices(result.newRate);
      if (newPrices) {
        result.prices = newPrices;
      }
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
   * Set playrate to an exact value (mod command)
   * @param {string} username - User who triggered the action
   * @param {number} rate - Target playrate (0.5-4.0)
   * @param {object} options - Additional options
   */
  setPlayrateDirect(username, rate, options = {}) {
    const minRate = config.get('game.minPlayrate') || 0.5;
    const maxRate = config.get('game.maxPlayrate') || 4.0;

    // Validate rate
    if (isNaN(rate) || rate < minRate || rate > maxRate) {
      return {
        success: false,
        reason: 'invalidRate',
        message: `🎸 ${rate}x? That tempo doesn't exist in the metal realm! Stick to ${minRate}x - ${maxRate}x or face the wrath of the riff gods! 🤘`
      };
    }

    const newRate = reaper.setPlayrate(rate);

    this.lastActionTime = Date.now();
    this.addToHistory('setPlayrate', username, newRate, options.source || 'modCommand');
    this.scheduleAutoReset();
    this.emit('actionProcessed', {
      action: 'setPlayrate',
      username,
      newRate,
      source: options.source || 'modCommand',
      avatarUrl: options.avatarUrl
    });

    // Update dynamic prices based on new playrate
    const newPrices = this.updatePrices(newRate);

    return {
      success: true,
      action: 'setPlayrate',
      newRate: newRate,
      prices: newPrices,
      message: this.formatMessage('setPlayrate', { user: username, rate: newRate.toFixed(2) })
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
