const fs = require('fs');
const path = require('path');
const config = require('./config');
const EventEmitter = require('events');

// Persistent data files
const REQUESTS_LOG_FILE = path.join(__dirname, '..', 'requests_log.json');
const REQUESTS_STATS_FILE = path.join(__dirname, '..', 'requests_stats.json');

class RequestsManager extends EventEmitter {
  constructor() {
    super();
    this.queue = [];  // Active request queue
    this.userCooldowns = new Map();  // userId -> timestamp
    this.stats = this.loadStats();
    this.log = this.loadLog();
  }

  /**
   * Load persistent statistics
   */
  loadStats() {
    try {
      if (fs.existsSync(REQUESTS_STATS_FILE)) {
        return JSON.parse(fs.readFileSync(REQUESTS_STATS_FILE, 'utf8'));
      }
    } catch (err) {
      console.error('Error loading request stats:', err.message);
    }
    return {
      totalRequests: 0,
      totalCompleted: 0,
      totalCancelled: 0,
      totalEdited: 0,
      topRequesters: {},  // userId -> { username, count, completed }
      topSongs: {},       // songId -> { title, artist, count }
      firstRequest: null,
      lastRequest: null,
      sessionsWithRequests: 0
    };
  }

  /**
   * Save statistics
   */
  saveStats() {
    try {
      fs.writeFileSync(REQUESTS_STATS_FILE, JSON.stringify(this.stats, null, 2));
    } catch (err) {
      console.error('Error saving request stats:', err.message);
    }
  }

  /**
   * Load request log (keeps last 1000 entries)
   */
  loadLog() {
    try {
      if (fs.existsSync(REQUESTS_LOG_FILE)) {
        const data = JSON.parse(fs.readFileSync(REQUESTS_LOG_FILE, 'utf8'));
        return Array.isArray(data) ? data : [];
      }
    } catch (err) {
      console.error('Error loading request log:', err.message);
    }
    return [];
  }

  /**
   * Save request log
   */
  saveLog() {
    try {
      // Keep last 1000 entries
      const trimmedLog = this.log.slice(-1000);
      fs.writeFileSync(REQUESTS_LOG_FILE, JSON.stringify(trimmedLog, null, 2));
    } catch (err) {
      console.error('Error saving request log:', err.message);
    }
  }

  /**
   * Add entry to log
   */
  addLogEntry(entry) {
    this.log.push({
      ...entry,
      timestamp: new Date().toISOString()
    });
    this.saveLog();
  }

  /**
   * Check if user passes requirements
   * @returns {object} { allowed: boolean, reason?: string }
   */
  async checkUserRequirements(userId, username, userInfo, twitchApi) {
    const reqConfig = config.get('requests');

    // Check if requests are enabled
    if (!reqConfig?.enabled) {
      return { allowed: false, reason: 'Song requests are currently disabled.' };
    }

    // Check sub-only mode
    if (reqConfig.subOnly && !userInfo.isSubscriber && !userInfo.isBroadcaster && !userInfo.isMod) {
      return { allowed: false, reason: 'Song requests are subscriber-only.' };
    }

    // Check follower requirement
    if (reqConfig.requireFollower && twitchApi) {
      try {
        const broadcasterId = config.get('twitch.broadcasterId');
        const follow = await twitchApi.channels.getChannelFollowers(broadcasterId, userId);
        if (!follow?.data?.length) {
          return { allowed: false, reason: 'You must follow the channel to request songs.' };
        }
      } catch (err) {
        console.warn('Could not check follower status:', err.message);
        // Allow if we can't check (fail open for better UX)
      }
    }

    // Check activity requirement (based on recent chat)
    if (reqConfig.requireActive) {
      // Activity is tracked by recent messages - simple implementation
      // In production, would track message timestamps per user
      // For now, we assume they're active if they're chatting
    }

    // Check user cooldown
    const cooldownMs = (reqConfig.userCooldownMinutes || 0) * 60 * 1000;
    if (cooldownMs > 0) {
      const lastRequest = this.userCooldowns.get(userId);
      if (lastRequest && (Date.now() - lastRequest) < cooldownMs) {
        const remainingMs = cooldownMs - (Date.now() - lastRequest);
        const remainingMins = Math.ceil(remainingMs / 60000);
        return { allowed: false, reason: `Cooldown active. Try again in ${remainingMins} minute${remainingMins !== 1 ? 's' : ''}.` };
      }
    }

    // Check if user already has a request in queue
    const existingRequest = this.queue.find(r => r.userId === userId);
    if (existingRequest && !reqConfig.allowEdit) {
      return { allowed: false, reason: 'You already have a song in the queue. Wait for it to be played.' };
    }

    // Check queue limit
    const maxQueue = reqConfig.maxQueueSize || 50;
    if (this.queue.length >= maxQueue && !existingRequest) {
      return { allowed: false, reason: 'Request queue is full. Please try again later.' };
    }

    return { allowed: true, existingRequest };
  }

  /**
   * Search for a song in the index
   * @param {string} query - Search query
   * @param {array} songsIndex - Array of songs from index
   * @returns {object|null} Best matching song or null
   */
  searchSong(query, songsIndex) {
    if (!songsIndex || !query) return null;

    const normalizedQuery = query.toLowerCase().trim();

    // Exact match on title
    let match = songsIndex.find(s => s.t.toLowerCase() === normalizedQuery);
    if (match) return match;

    // Exact match on "artist - title" format
    match = songsIndex.find(s =>
      `${s.a} - ${s.t}`.toLowerCase() === normalizedQuery ||
      `${s.t} - ${s.a}`.toLowerCase() === normalizedQuery
    );
    if (match) return match;

    // Partial match (title contains query)
    match = songsIndex.find(s => s.t.toLowerCase().includes(normalizedQuery));
    if (match) return match;

    // Partial match (artist contains query)
    match = songsIndex.find(s => s.a.toLowerCase().includes(normalizedQuery));
    if (match) return match;

    // Fuzzy match - split into words and find best score
    const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 1);
    if (queryWords.length > 0) {
      let bestMatch = null;
      let bestScore = 0;

      for (const song of songsIndex) {
        const songText = `${song.t} ${song.a}`.toLowerCase();
        let score = 0;
        for (const word of queryWords) {
          if (songText.includes(word)) score++;
        }
        if (score > bestScore) {
          bestScore = score;
          bestMatch = song;
        }
      }

      if (bestMatch && bestScore >= Math.ceil(queryWords.length * 0.5)) {
        return bestMatch;
      }
    }

    return null;
  }

  /**
   * Add or update a song request
   * @returns {object} { success, message, request? }
   */
  addRequest(userId, username, song, userInfo = {}) {
    const reqConfig = config.get('requests');

    // Check if user already has a request
    const existingIndex = this.queue.findIndex(r => r.userId === userId);

    if (existingIndex !== -1) {
      // User is editing their request
      const oldRequest = this.queue[existingIndex];
      this.queue[existingIndex] = {
        ...oldRequest,
        songId: song.id,
        songTitle: song.t,
        songArtist: song.a,
        editedAt: Date.now(),
        editCount: (oldRequest.editCount || 0) + 1
      };

      this.stats.totalEdited++;
      this.saveStats();

      this.addLogEntry({
        type: 'edit',
        userId,
        username,
        oldSong: { id: oldRequest.songId, title: oldRequest.songTitle, artist: oldRequest.songArtist },
        newSong: { id: song.id, title: song.t, artist: song.a },
        position: existingIndex + 1
      });

      this.emit('requestEdited', this.queue[existingIndex]);

      return {
        success: true,
        message: `@${username} Updated your request to "${song.t}" by ${song.a} (position #${existingIndex + 1})`,
        request: this.queue[existingIndex],
        edited: true
      };
    }

    // New request
    const request = {
      id: `req_${Date.now()}_${userId}`,
      userId,
      username,
      displayName: userInfo.displayName || username,
      songId: song.id,
      songTitle: song.t,
      songArtist: song.a,
      requestedAt: Date.now(),
      editCount: 0,
      isSubscriber: userInfo.isSubscriber || false,
      avatarUrl: userInfo.avatarUrl || null
    };

    this.queue.push(request);
    this.userCooldowns.set(userId, Date.now());

    // Update stats
    this.stats.totalRequests++;
    if (!this.stats.firstRequest) {
      this.stats.firstRequest = new Date().toISOString();
    }
    this.stats.lastRequest = new Date().toISOString();

    // Track top requesters
    if (!this.stats.topRequesters[userId]) {
      this.stats.topRequesters[userId] = { username, count: 0, completed: 0 };
    }
    this.stats.topRequesters[userId].count++;
    this.stats.topRequesters[userId].username = username;  // Update in case they changed

    // Track top songs
    if (!this.stats.topSongs[song.id]) {
      this.stats.topSongs[song.id] = { title: song.t, artist: song.a, count: 0 };
    }
    this.stats.topSongs[song.id].count++;

    this.saveStats();

    this.addLogEntry({
      type: 'add',
      userId,
      username,
      song: { id: song.id, title: song.t, artist: song.a },
      position: this.queue.length
    });

    this.emit('requestAdded', request);

    return {
      success: true,
      message: `@${username} Added "${song.t}" by ${song.a} to the queue (position #${this.queue.length})`,
      request,
      edited: false
    };
  }

  /**
   * Remove a request (by user or moderator)
   */
  removeRequest(requestIdOrUserId, byModerator = false, moderatorName = null) {
    let index = this.queue.findIndex(r => r.id === requestIdOrUserId || r.userId === requestIdOrUserId);

    if (index === -1) return { success: false, message: 'Request not found.' };

    const request = this.queue[index];
    this.queue.splice(index, 1);

    this.stats.totalCancelled++;
    this.saveStats();

    this.addLogEntry({
      type: 'remove',
      userId: request.userId,
      username: request.username,
      song: { id: request.songId, title: request.songTitle, artist: request.songArtist },
      byModerator,
      moderatorName
    });

    this.emit('requestRemoved', { request, byModerator, moderatorName });

    return {
      success: true,
      message: byModerator
        ? `Removed "${request.songTitle}" from the queue.`
        : `@${request.username} Your request has been removed from the queue.`,
      request
    };
  }

  /**
   * Mark request as completed (when song is played)
   */
  completeRequest(requestId) {
    const index = this.queue.findIndex(r => r.id === requestId);
    if (index === -1) return null;

    const request = this.queue.splice(index, 1)[0];

    this.stats.totalCompleted++;
    if (this.stats.topRequesters[request.userId]) {
      this.stats.topRequesters[request.userId].completed++;
    }
    this.saveStats();

    this.addLogEntry({
      type: 'complete',
      userId: request.userId,
      username: request.username,
      song: { id: request.songId, title: request.songTitle, artist: request.songArtist }
    });

    this.emit('requestCompleted', request);
    return request;
  }

  /**
   * Get next request in queue
   */
  getNextRequest() {
    return this.queue[0] || null;
  }

  /**
   * Get user's current request
   */
  getUserRequest(userId) {
    return this.queue.find(r => r.userId === userId) || null;
  }

  /**
   * Get queue position for a user
   */
  getUserPosition(userId) {
    const index = this.queue.findIndex(r => r.userId === userId);
    return index === -1 ? null : index + 1;
  }

  /**
   * Get full queue
   */
  getQueue() {
    return this.queue;
  }

  /**
   * Clear entire queue
   */
  clearQueue() {
    const count = this.queue.length;
    this.queue = [];

    this.addLogEntry({
      type: 'clear',
      count
    });

    this.emit('queueCleared');
    return count;
  }

  /**
   * Get statistics summary
   */
  getStats() {
    // Calculate top 10 requesters
    const topRequesters = Object.entries(this.stats.topRequesters)
      .map(([userId, data]) => ({ userId, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Calculate top 10 songs
    const topSongs = Object.entries(this.stats.topSongs)
      .map(([songId, data]) => ({ songId, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      ...this.stats,
      currentQueueSize: this.queue.length,
      topRequesters,
      topSongs
    };
  }

  /**
   * Get recent log entries
   */
  getRecentLog(count = 50) {
    return this.log.slice(-count).reverse();
  }

  /**
   * Export full log for analysis
   */
  exportLog() {
    return this.log;
  }

  /**
   * Serialize queue for web interface
   */
  serializeForWeb() {
    return this.queue.map((r, i) => ({
      id: r.id,
      pos: i + 1,
      user: r.displayName || r.username,
      userId: r.userId,
      title: r.songTitle,
      artist: r.songArtist,
      songId: r.songId,
      sub: r.isSubscriber,
      avatar: r.avatarUrl,
      time: r.requestedAt,
      edits: r.editCount
    }));
  }
}

module.exports = new RequestsManager();
