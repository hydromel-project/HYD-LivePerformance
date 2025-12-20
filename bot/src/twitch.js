const { ApiClient } = require('@twurple/api');
const { RefreshingAuthProvider } = require('@twurple/auth');
const { EventSubWsListener } = require('@twurple/eventsub-ws');
const tmi = require('tmi.js');
const config = require('./config');
const gameEngine = require('./game-engine');
const reaper = require('./reaper');
const requests = require('./requests');
const EventEmitter = require('events');

// Load access denied jokes from JSON
const accessDeniedJokes = require('./access-denied-jokes.json');

/**
 * Get a random access denied joke
 */
function getAccessDeniedJoke() {
  const jokes = accessDeniedJokes.jokes;
  return jokes[Math.floor(Math.random() * jokes.length)];
}

class TwitchIntegration extends EventEmitter {
  constructor() {
    super();
    this.authProvider = null;
    this.apiClient = null;
    this.eventSubListener = null;
    this.chatClient = null;
    this.connected = false;
    this.rewardsCreated = false;
    this.songsIndex = [];  // Will be set by server when loaded
  }

  /**
   * Set the songs index for request matching
   */
  setSongsIndex(songs) {
    this.songsIndex = songs || [];
    console.log(`   Songs index loaded: ${this.songsIndex.length} songs`);
  }

  /**
   * Initialize Twitch connection
   */
  async connect() {
    const twitchConfig = config.get('twitch');

    if (!twitchConfig.clientId || !twitchConfig.accessToken) {
      console.log('⚠️ Twitch not configured - skipping connection');
      return false;
    }

    try {
      // Set up auth provider with token refresh
      this.authProvider = new RefreshingAuthProvider({
        clientId: twitchConfig.clientId,
        clientSecret: twitchConfig.clientSecret
      });

      this.authProvider.onRefresh(async (userId, newTokenData) => {
        config.set('twitch.accessToken', newTokenData.accessToken);
        config.set('twitch.refreshToken', newTokenData.refreshToken);
        console.log('🔄 Twitch token refreshed');
      });

      await this.authProvider.addUserForToken({
        accessToken: twitchConfig.accessToken,
        refreshToken: twitchConfig.refreshToken,
        expiresIn: 0,
        obtainmentTimestamp: 0
      }, ['chat']);

      // Create API client
      this.apiClient = new ApiClient({ authProvider: this.authProvider });

      // Get broadcaster ID if not set
      if (!twitchConfig.broadcasterId) {
        const user = await this.apiClient.users.getUserByName(twitchConfig.broadcasterName);
        if (user) {
          config.set('twitch.broadcasterId', user.id);
          twitchConfig.broadcasterId = user.id;
        }
      }

      // Connect to EventSub for channel point redemptions
      await this.connectEventSub();

      // Connect to chat for announcements
      await this.connectChat();

      this.connected = true;
      console.log('🟣 Twitch connected');
      this.emit('connected');

      return true;
    } catch (err) {
      console.error('Twitch connection error:', err.message);
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Connect to EventSub WebSocket for real-time events
   */
  async connectEventSub() {
    const twitchConfig = config.get('twitch');

    this.eventSubListener = new EventSubWsListener({
      apiClient: this.apiClient
    });

    // Listen for channel point redemptions
    await this.eventSubListener.onChannelRedemptionAdd(twitchConfig.broadcasterId, async (event) => {
      await this.handleRedemption(event);
    });

    this.eventSubListener.start();
    console.log('   EventSub listener started');
  }

  /**
   * Connect to Twitch chat for announcements
   */
  async connectChat() {
    const twitchConfig = config.get('twitch');

    this.chatClient = new tmi.Client({
      options: { debug: false },
      identity: {
        username: twitchConfig.botName || twitchConfig.broadcasterName,
        password: `oauth:${twitchConfig.accessToken}`
      },
      channels: [twitchConfig.broadcasterName]
    });

    this.chatClient.on('connected', () => {
      console.log('   Chat connected');
    });

    // Handle chat messages for commands
    this.chatClient.on('message', (channel, tags, message, self) => {
      if (self) return;  // Ignore bot's own messages
      this.handleChatMessage(channel, tags, message);
    });

    await this.chatClient.connect();
  }

  /**
   * Handle incoming chat message for commands
   */
  async handleChatMessage(channel, tags, message) {
    const trimmedMsg = message.trim();
    const cmd = trimmedMsg.split(' ')[0].toLowerCase();

    // Mod/Broadcaster command: !playrate <value>
    if (cmd === '!playrate') {
      await this.handlePlayrateCommand(channel, tags, trimmedMsg);
      return;
    }

    // Mod/Broadcaster command: !testreaper
    if (cmd === '!testreaper') {
      this.handleTestReaperCommand(channel, tags);
      return;
    }

    // Mod/Broadcaster command: !reapercommands
    if (cmd === '!reapercommands' || cmd === '!reaperhelp') {
      this.handleReaperCommandsCommand(channel, tags);
      return;
    }

    // Song request commands require requests to be enabled
    const reqConfig = config.get('requests');
    if (!reqConfig?.enabled) return;

    // Check for request commands
    const requestCommands = [reqConfig.command, ...(reqConfig.aliases || [])].map(c => c.toLowerCase());

    if (requestCommands.includes(cmd)) {
      await this.handleSongRequest(channel, tags, trimmedMsg);
      return;
    }

    // Queue position check (!queue, !position, !myrequest)
    if (['!queue', '!position', '!myrequest', '!song'].includes(cmd)) {
      await this.handleQueueCheck(channel, tags);
      return;
    }

    // Cancel request (!cancel, !cancelrequest)
    if (['!cancel', '!cancelrequest'].includes(cmd)) {
      await this.handleCancelRequest(channel, tags);
      return;
    }
  }

  /**
   * Handle !playrate command (mod/broadcaster only)
   */
  async handlePlayrateCommand(channel, tags, message) {
    const username = tags.username;
    const displayName = tags['display-name'] || username;
    const isMod = tags.mod || tags.badges?.moderator;
    const isBroadcaster = tags.badges?.broadcaster;

    // Check permissions
    if (!isMod && !isBroadcaster) {
      this.sendChat(`@${displayName} ${getAccessDeniedJoke()}`);
      return;
    }

    // Parse the rate value
    const parts = message.split(/\s+/);
    if (parts.length < 2) {
      this.sendChat(`@${displayName} 🎸 You call that a command?! Give me a number! !playrate <0.5-4.0> — Don't leave the riff hanging! 🤘`);
      return;
    }

    const rate = parseFloat(parts[1]);

    // Fetch user avatar
    let avatarUrl = null;
    try {
      const user = await this.apiClient.users.getUserById(tags['user-id']);
      if (user) {
        avatarUrl = user.profilePictureUrl;
      }
    } catch (err) {
      // Ignore avatar fetch errors
    }

    // Process the action
    const result = gameEngine.setPlayrateDirect(displayName, rate, {
      source: 'modCommand',
      avatarUrl
    });

    if (result.message) {
      this.sendChat(result.message);
    }
  }

  /**
   * Handle !testreaper command (mod/broadcaster only)
   */
  handleTestReaperCommand(channel, tags) {
    const displayName = tags['display-name'] || tags.username;
    const isMod = tags.mod || tags.badges?.moderator;
    const isBroadcaster = tags.badges?.broadcaster;

    if (!isMod && !isBroadcaster) {
      this.sendChat(`@${displayName} ${getAccessDeniedJoke()}`);
      return;
    }

    const reaperConfig = config.get('reaper');
    const isConnected = reaper.connected;
    const currentPlayrate = reaper.getPlayrate();
    const currentBpm = reaper.getBpm();

    if (isConnected) {
      this.sendChat(`🤘 THE REAPER LIVES! Shredding at ${currentPlayrate.toFixed(2)}x | ${currentBpm} BPM | Port ${reaperConfig.sendPort} — LET'S GOOOO! 🔥`);
    } else {
      this.sendChat(`💀 THE REAPER IS SILENT... OSC connection dead on port ${reaperConfig.sendPort}. Someone wake up the sound guy!`);
    }
  }

  /**
   * Handle !reapercommands command (mod/broadcaster only)
   */
  handleReaperCommandsCommand(channel, tags) {
    const displayName = tags['display-name'] || tags.username;
    const isMod = tags.mod || tags.badges?.moderator;
    const isBroadcaster = tags.badges?.broadcaster;

    if (!isMod && !isBroadcaster) {
      this.sendChat(`@${displayName} ${getAccessDeniedJoke()}`);
      return;
    }

    const gameConfig = config.get('game');
    const minRate = gameConfig.minPlayrate;
    const maxRate = gameConfig.maxPlayrate;

    this.sendChat(`⚔️ MOD ARSENAL: !playrate <${minRate}-${maxRate}> (command the tempo) | !testreaper (summon the REAPER) | !reapercommands (this grimoire 📜) 🤘`);
  }

  /**
   * Handle song request command
   */
  async handleSongRequest(channel, tags, message) {
    const reqConfig = config.get('requests');
    const username = tags.username;
    const userId = tags['user-id'];
    const displayName = tags['display-name'] || username;

    // Extract song query (everything after the command)
    const query = message.replace(/^!\S+\s*/, '').trim();

    if (!query) {
      // Show current request if no query
      await this.handleQueueCheck(channel, tags);
      return;
    }

    // Build user info
    const userInfo = {
      displayName,
      isSubscriber: tags.subscriber || tags.badges?.subscriber,
      isBroadcaster: tags.badges?.broadcaster,
      isMod: tags.mod || tags.badges?.moderator,
      avatarUrl: null
    };

    // Check user requirements
    const checkResult = await requests.checkUserRequirements(userId, username, userInfo, this.apiClient);

    if (!checkResult.allowed) {
      this.sendChat(checkResult.reason);
      return;
    }

    // Search for the song
    const song = requests.searchSong(query, this.songsIndex);

    if (!song) {
      const msg = this.formatRequestMessage('notFound', { user: username, query });
      this.sendChat(msg);
      return;
    }

    // Try to fetch avatar
    try {
      const user = await this.apiClient.users.getUserById(userId);
      if (user) {
        userInfo.avatarUrl = user.profilePictureUrl;
      }
    } catch (err) {
      // Ignore avatar fetch errors
    }

    // Add request
    const result = requests.addRequest(userId, username, song, userInfo);

    if (result.success) {
      const msgType = result.edited ? 'requestEdited' : 'requestAdded';
      const msg = this.formatRequestMessage(msgType, {
        user: username,
        title: song.t,
        artist: song.a,
        position: result.edited
          ? requests.getUserPosition(userId)
          : requests.getQueue().length
      });
      this.sendChat(msg);
      this.emit('requestAdded', result.request);
    } else {
      this.sendChat(result.message);
    }
  }

  /**
   * Handle queue check command
   */
  async handleQueueCheck(channel, tags) {
    const username = tags.username;
    const userId = tags['user-id'];

    const userRequest = requests.getUserRequest(userId);

    if (userRequest) {
      const position = requests.getUserPosition(userId);
      const msg = this.formatRequestMessage('currentRequest', {
        user: username,
        title: userRequest.songTitle,
        artist: userRequest.songArtist,
        position
      });
      this.sendChat(msg);
    } else {
      const msg = this.formatRequestMessage('noRequest', { user: username });
      this.sendChat(msg);
    }
  }

  /**
   * Handle cancel request command
   */
  async handleCancelRequest(channel, tags) {
    const username = tags.username;
    const userId = tags['user-id'];

    const result = requests.removeRequest(userId);

    if (result.success) {
      const msg = this.formatRequestMessage('requestCancelled', { user: username });
      this.sendChat(msg);
      this.emit('requestRemoved', result.request);
    } else {
      const msg = this.formatRequestMessage('noRequest', { user: username });
      this.sendChat(msg);
    }
  }

  /**
   * Format request-related chat message
   */
  formatRequestMessage(type, data) {
    const template = config.get(`requests.messages.${type}`) || '';
    return template.replace(/\{(\w+)\}/g, (match, key) => data[key] ?? match);
  }

  /**
   * Handle channel point redemption
   */
  async handleRedemption(event) {
    const rewardsConfig = config.get('rewards');
    const rewardId = event.rewardId;
    const username = event.userName;
    const userId = event.userId;

    // Find which action this reward corresponds to
    let action = null;
    for (const [actionName, rewardConfig] of Object.entries(rewardsConfig)) {
      if (rewardConfig.rewardId === rewardId) {
        action = actionName;
        break;
      }
    }

    if (!action) {
      console.log(`Unknown reward redeemed: ${event.rewardTitle}`);
      return;
    }

    // Fetch user's avatar
    let avatarUrl = null;
    try {
      const user = await this.apiClient.users.getUserById(userId);
      if (user) {
        avatarUrl = user.profilePictureUrl;
      }
    } catch (err) {
      console.warn('Could not fetch user avatar:', err.message);
    }

    console.log(`🎯 ${username} redeemed: ${action}`);

    // Process the action with avatar
    const result = gameEngine.processAction(action, username, { source: 'channelPoints', avatarUrl });

    // Send chat message
    if (config.get('game.announcements.enabled') && result.message) {
      this.sendChat(result.message);
    }

    // Mark redemption as fulfilled or refund
    try {
      if (result.success) {
        await this.apiClient.channelPoints.updateRedemptionStatusByIds(
          config.get('twitch.broadcasterId'),
          rewardId,
          [event.id],
          'FULFILLED'
        );
      } else {
        // Refund if action failed
        await this.apiClient.channelPoints.updateRedemptionStatusByIds(
          config.get('twitch.broadcasterId'),
          rewardId,
          [event.id],
          'CANCELED'
        );
      }
    } catch (err) {
      console.error('Error updating redemption status:', err.message);
    }
  }

  /**
   * Send a chat message
   */
  sendChat(message) {
    if (!this.chatClient || !config.get('game.announcements.enabled')) return;

    const channel = config.get('twitch.broadcasterName');
    this.chatClient.say(channel, message).catch(err => {
      console.error('Chat error:', err.message);
    });
  }

  /**
   * Create channel point rewards for game mode
   */
  async createRewards() {
    if (!this.apiClient) {
      console.warn('Cannot create rewards - not connected to Twitch');
      return false;
    }

    const twitchConfig = config.get('twitch');
    const rewardsConfig = config.get('rewards');

    console.log('Creating channel point rewards...');

    for (const [actionName, rewardConfig] of Object.entries(rewardsConfig)) {
      if (!rewardConfig.enabled) continue;

      try {
        const reward = await this.apiClient.channelPoints.createCustomReward(
          twitchConfig.broadcasterId,
          {
            title: rewardConfig.title,
            cost: rewardConfig.cost,
            isEnabled: true,
            backgroundColor: rewardConfig.backgroundColor,
            globalCooldown: rewardConfig.cooldownSeconds > 0 ? rewardConfig.cooldownSeconds : null,
            maxRedemptionsPerStream: rewardConfig.maxPerStream > 0 ? rewardConfig.maxPerStream : null,
            autoFulfill: false
          }
        );

        config.set(`rewards.${actionName}.rewardId`, reward.id);
        console.log(`   ✓ Created: ${rewardConfig.title} (${reward.id})`);
      } catch (err) {
        console.error(`   ✗ Failed to create ${rewardConfig.title}:`, err.message);
      }
    }

    this.rewardsCreated = true;
    this.emit('rewardsCreated');
    return true;
  }

  /**
   * Delete/disable channel point rewards
   */
  async removeRewards() {
    if (!this.apiClient) return false;

    const twitchConfig = config.get('twitch');
    const rewardsConfig = config.get('rewards');

    console.log('Removing channel point rewards...');

    for (const [actionName, rewardConfig] of Object.entries(rewardsConfig)) {
      if (!rewardConfig.rewardId) continue;

      try {
        await this.apiClient.channelPoints.deleteCustomReward(
          twitchConfig.broadcasterId,
          rewardConfig.rewardId
        );
        config.set(`rewards.${actionName}.rewardId`, null);
        console.log(`   ✓ Removed: ${rewardConfig.title}`);
      } catch (err) {
        console.error(`   ✗ Failed to remove ${rewardConfig.title}:`, err.message);
      }
    }

    this.rewardsCreated = false;
    this.emit('rewardsRemoved');
    return true;
  }

  /**
   * Update reward settings
   */
  async updateReward(actionName, settings) {
    if (!this.apiClient) return false;

    const twitchConfig = config.get('twitch');
    const rewardId = config.get(`rewards.${actionName}.rewardId`);

    if (!rewardId) return false;

    try {
      await this.apiClient.channelPoints.updateCustomReward(
        twitchConfig.broadcasterId,
        rewardId,
        settings
      );
      return true;
    } catch (err) {
      console.error(`Error updating reward ${actionName}:`, err.message);
      return false;
    }
  }

  /**
   * Update all reward prices (for dynamic pricing)
   * @param {object} prices - { speedUp, slowDown, chaos, reset }
   */
  async updateRewardPrices(prices) {
    if (!this.apiClient || !this.connected) return false;

    const twitchConfig = config.get('twitch');
    const rewardsConfig = config.get('rewards');

    const updates = [];

    for (const [actionName, newCost] of Object.entries(prices)) {
      const rewardId = rewardsConfig[actionName]?.rewardId;
      if (!rewardId || !newCost) continue;

      updates.push(
        this.apiClient.channelPoints.updateCustomReward(
          twitchConfig.broadcasterId,
          rewardId,
          { cost: newCost }
        ).then(() => {
          console.log(`   💰 ${actionName}: ${newCost} pts`);
        }).catch(err => {
          console.warn(`   Failed to update ${actionName} price:`, err.message);
        })
      );
    }

    if (updates.length > 0) {
      console.log('📊 Updating dynamic prices...');
      await Promise.all(updates);
      this.emit('pricesUpdated', prices);
    }

    return true;
  }

  /**
   * Disconnect from Twitch
   */
  async disconnect() {
    if (this.eventSubListener) {
      this.eventSubListener.stop();
    }
    if (this.chatClient) {
      await this.chatClient.disconnect();
    }
    this.connected = false;
    console.log('🟣 Twitch disconnected');
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
      rewardsCreated: this.rewardsCreated,
      broadcasterId: config.get('twitch.broadcasterId'),
      broadcasterName: config.get('twitch.broadcasterName')
    };
  }
}

module.exports = new TwitchIntegration();
