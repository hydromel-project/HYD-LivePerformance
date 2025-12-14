/**
 * HYD Playrate Bot
 *
 * Twitch/Streamlabs integration for REAPER playrate control
 * Allows viewers to mess with your playrate using channel points and donations!
 */

const config = require('./src/config');
const server = require('./src/server');
const reaper = require('./src/reaper');
const twitch = require('./src/twitch');
const streamlabs = require('./src/streamlabs');
const gameEngine = require('./src/game-engine');

console.log('');
console.log('╔════════════════════════════════════════╗');
console.log('║     HYD Playrate Bot v1.0.0            ║');
console.log('║     Twitch + Streamlabs + REAPER       ║');
console.log('╚════════════════════════════════════════╝');
console.log('');

async function start() {
  // Start web server first (always available for config)
  server.start();

  // Connect to REAPER via OSC
  console.log('');
  console.log('Connecting to services...');
  reaper.connect();

  // Connect to Twitch (if configured)
  await twitch.connect();

  // Connect to Streamlabs (if configured)
  streamlabs.connect();

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Check what's configured
  const twitchConfigured = config.get('twitch.clientId') && config.get('twitch.accessToken');
  const streamlabsConfigured = !!config.get('streamlabs.socketToken');
  const reaperConfigured = config.get('reaper.sendPort');

  if (!twitchConfigured && !streamlabsConfigured) {
    console.log('');
    console.log('⚠️  No integrations configured yet!');
    console.log('');
    console.log('   Open the config panel to set up:');
    console.log(`   → http://localhost:${config.get('webPort')}`);
    console.log('');
  }

  // Setup REAPER OSC (if not already configured, show instructions)
  if (!reaperConfigured) {
    console.log('');
    console.log('📋 REAPER OSC Setup:');
    console.log('   1. Open REAPER Preferences (Ctrl+P)');
    console.log('   2. Go to Control/OSC/Web');
    console.log('   3. Add → OSC (Open Sound Control)');
    console.log(`   4. Set: Mode=Configure, Receive on port ${config.get('reaper.sendPort')}`);
    console.log(`   5. Set: Send to IP 127.0.0.1, port ${config.get('reaper.receivePort')}`);
    console.log('');
  }

  console.log('');
  console.log('Ready! Press Ctrl+C to stop.');
  console.log('');
}

// Handle shutdown
process.on('SIGINT', async () => {
  console.log('');
  console.log('Shutting down...');

  // Remove rewards if game was active
  if (gameEngine.isEnabled()) {
    await twitch.removeRewards();
  }

  await twitch.disconnect();
  streamlabs.disconnect();
  reaper.disconnect();
  server.stop();

  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught error:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

// Start the bot
start().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
