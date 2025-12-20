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
      speedUp: '🔥 {user} cranked it to {rate}x! THRASH HARDER! 🤘',
      slowDown: '🧊 {user} dropped it to {rate}x! Doom mode engaged. 🎸',
      chaos: '🎲 {user} unleashed CHAOS! {rate}x — THE PIT IS OPEN! 💀',
      reset: '⚡ {user} restored order at {rate}x. The calm before the storm...',
      setPlayrate: '🎛️ {user} commanded {rate}x! So it shall be done. 🤘',
      maxReached: '💀 WE\'RE ALREADY BLASTING AT MAXIMUM OVERDRIVE! Even Dragonforce can\'t shred faster than this!',
      minReached: '🪦 Any slower and we\'re playing funeral doom! The tempo has been buried alive.',
      cooldownActive: '⏳ Chill for {seconds}s, moshpit needs to recover! Even metalheads need a breather between breakdowns.'
    }
  },

  // Channel point rewards configuration
  rewards: {
    speedUp: {
      enabled: true,
      title: '🔥 Speed Up',
      baseCost: 500,           // Base cost at 1.0x
      cost: 500,               // Current cost (updated dynamically)
      increment: 0.1,
      cooldownSeconds: 0,
      maxPerStream: 0,         // 0 = unlimited
      backgroundColor: '#FF4400',
      rewardId: null           // Set when created
    },
    slowDown: {
      enabled: true,
      title: '🧊 Slow Down',
      baseCost: 500,
      cost: 500,
      increment: 0.1,
      cooldownSeconds: 0,
      maxPerStream: 0,
      backgroundColor: '#00AAFF',
      rewardId: null
    },
    chaos: {
      enabled: true,
      title: '🎲 CHAOS',
      baseCost: 2500,          // High risk = high cost
      cost: 2500,
      cooldownSeconds: 30,
      maxPerStream: 0,
      backgroundColor: '#FF00FF',
      rewardId: null
    },
    reset: {
      enabled: true,
      title: '✨ Reset',
      baseCost: 1500,          // Escape from chaos
      cost: 1500,
      cooldownSeconds: 60,
      maxPerStream: 0,
      backgroundColor: '#00FF88',
      rewardId: null
    },

    // Dynamic pricing settings
    dynamicPricing: {
      enabled: true,
      // How aggressively prices scale (1.0 = double at 2x, 2.0 = triple at 2x)
      scaleFactor: 1.5,
      // Minimum cost (never go below this)
      minCost: 100,
      // Maximum cost cap
      maxCost: 50000,
      // Reset gets cheaper at extremes (mercy rule)
      resetDiscountAtExtremes: true
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
  },

  // Song request settings
  requests: {
    enabled: false,

    // Requirements
    subOnly: false,           // Only subscribers can request
    requireFollower: false,   // Must be a follower to request
    requireActive: false,     // Must have chatted recently (future feature)

    // Cooldowns and limits
    userCooldownMinutes: 5,   // Minutes between requests per user
    maxQueueSize: 50,         // Maximum requests in queue

    // Edit behavior
    allowEdit: true,          // Users can edit their request without losing spot

    // Channel points (0 = free)
    channelPointsCost: 0,

    // Command settings
    command: '!request',
    aliases: ['!sr', '!songrequest'],

    // Chat messages
    messages: {
      requestAdded: '🎵 @{user} Added "{title}" by {artist} to the queue (position #{position})',
      requestEdited: '🎵 @{user} Updated request to "{title}" by {artist} (position #{position})',
      notFound: '@{user} Could not find a song matching "{query}". Try being more specific!',
      disabled: '@{user} Song requests are currently disabled.',
      subOnly: '@{user} Song requests are subscriber-only.',
      followerOnly: '@{user} You must follow the channel to request songs.',
      cooldown: '@{user} Cooldown active. Try again in {minutes} minute(s).',
      queueFull: '@{user} Request queue is full. Please try again later.',
      currentRequest: '@{user} Your current request: "{title}" by {artist} (position #{position})',
      noRequest: '@{user} You don\'t have a song in the queue.',
      queuePosition: '@{user} "{title}" is at position #{position}',
      queueEmpty: 'The request queue is empty! Use !request <song> to add one.',
      requestCancelled: '@{user} Your request has been removed from the queue.'
    }
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
