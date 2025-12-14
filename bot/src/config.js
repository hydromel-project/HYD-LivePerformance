const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

const defaultConfig = {
  // Server settings
  webPort: 9030,

  // REAPER OSC settings
  reaper: {
    host: '127.0.0.1',
    sendPort: 8000,      // Port REAPER listens on
    receivePort: 9000    // Port we listen on for REAPER responses
  },

  // Twitch settings
  twitch: {
    clientId: '',
    clientSecret: '',
    accessToken: '',
    refreshToken: '',
    broadcasterId: '',
    broadcasterName: '',
    botName: ''  // Usually same as broadcaster
  },

  // Streamlabs settings
  streamlabs: {
    socketToken: ''
  },

  // StreamElements settings
  streamelements: {
    jwtToken: ''
  },

  // Game settings
  game: {
    enabled: false,
    minPlayrate: 0.5,
    maxPlayrate: 4.0,
    defaultPlayrate: 1.0,

    // Proportional scaling - keeps BPM change consistent regardless of tempo
    proportionalScaling: {
      enabled: true,
      referenceBpm: 120  // At this BPM, increment is as configured
    },

    // Auto-reset settings
    autoReset: {
      enabled: false,
      delaySeconds: 60,
      resetTo: 1.0
    },

    // Global cooldown
    globalCooldown: {
      enabled: true,
      seconds: 5
    },

    // Chat announcements
    announcements: {
      enabled: true,
      speedUp: '🔥 {user} sped it up to {rate}x!',
      slowDown: '🧊 {user} slowed it down to {rate}x!',
      chaos: '🎲 {user} triggered CHAOS MODE! Now at {rate}x!',
      reset: '✨ {user} reset playrate to {rate}x!',
      maxReached: '⚠️ Already at maximum speed!',
      minReached: '⚠️ Already at minimum speed!',
      cooldownActive: '⏳ Cooldown active! Try again in {seconds}s'
    }
  },

  // Channel point rewards configuration
  rewards: {
    speedUp: {
      enabled: true,
      title: '🔥 Speed Up',
      cost: 100,
      increment: 0.1,
      cooldownSeconds: 0,
      maxPerStream: 0,  // 0 = unlimited
      backgroundColor: '#FF4400',
      rewardId: null  // Set when created
    },
    slowDown: {
      enabled: true,
      title: '🧊 Slow Down',
      cost: 100,
      increment: 0.1,
      cooldownSeconds: 0,
      maxPerStream: 0,
      backgroundColor: '#00AAFF',
      rewardId: null
    },
    chaos: {
      enabled: true,
      title: '🎲 CHAOS',
      cost: 500,
      cooldownSeconds: 30,
      maxPerStream: 0,
      backgroundColor: '#FF00FF',
      rewardId: null
    },
    reset: {
      enabled: true,
      title: '✨ Reset',
      cost: 200,
      cooldownSeconds: 60,
      maxPerStream: 0,
      backgroundColor: '#00FF88',
      rewardId: null
    }
  },

  // Donation thresholds (Streamlabs)
  donations: {
    enabled: true,
    actions: [
      { minAmount: 1, maxAmount: 4.99, action: 'speedUp', message: '💰 {user} tipped ${amount} - Speed up!' },
      { minAmount: 5, maxAmount: 9.99, action: 'slowDown', message: '💰 {user} tipped ${amount} - Slow down!' },
      { minAmount: 10, maxAmount: 24.99, action: 'chaos', message: '💰 {user} tipped ${amount} - CHAOS MODE!' },
      { minAmount: 25, maxAmount: null, action: 'reset', message: '💰 {user} tipped ${amount} - Reset!' }
    ]
  }
};

class Config {
  constructor() {
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        // Deep merge with defaults to handle new config options
        return this.deepMerge(defaultConfig, saved);
      }
    } catch (err) {
      console.error('Error loading config:', err.message);
    }
    return { ...defaultConfig };
  }

  save() {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.data, null, 2));
      return true;
    } catch (err) {
      console.error('Error saving config:', err.message);
      return false;
    }
  }

  get(key) {
    const keys = key.split('.');
    let value = this.data;
    for (const k of keys) {
      if (value === undefined) return undefined;
      value = value[k];
    }
    return value;
  }

  set(key, value) {
    const keys = key.split('.');
    let obj = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (obj[keys[i]] === undefined) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    this.save();
  }

  getAll() {
    return this.data;
  }

  update(newData) {
    this.data = this.deepMerge(this.data, newData);
    this.save();
  }

  deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] instanceof Object && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }
}

module.exports = new Config();
