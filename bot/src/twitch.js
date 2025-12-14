const { ApiClient } = require('@twurple/api');
const { RefreshingAuthProvider } = require('@twurple/auth');
const { EventSubWsListener } = require('@twurple/eventsub-ws');
const tmi = require('tmi.js');
const config = require('./config');
const gameEngine = require('./game-engine');
const EventEmitter = require('events');

class TwitchIntegration extends EventEmitter {
  constructor() {
    super();
    this.authProvider = null;
    this.apiClient = null;
    this.eventSubListener = null;
    this.chatClient = null;
    this.connected = false;
    this.rewardsCreated = false;
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

    await this.chatClient.connect();
  }

  /**
   * Handle channel point redemption
   */
  async handleRedemption(event) {
    const rewardsConfig = config.get('rewards');
    const rewardId = event.rewardId;
    const username = event.userName;

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

    console.log(`🎯 ${username} redeemed: ${action}`);

    // Process the action
    const result = gameEngine.processAction(action, username, { source: 'channelPoints' });

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
