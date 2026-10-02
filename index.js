const mineflayer = require('mineflayer');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const nbt = require('prismarine-nbt');
const ChatMessage = require('prismarine-chat')('1.20.4');
const { cleanChat } = require('./filter');
const { isMentioned, generateDryReply } = require('./aiResponder');
const JOKES = require('./jokes.json');

const PROMOS = [
  "subscribe me on youtube -> @papppuchan",
  "bhai log youtube pe @papppuchan search karke subscribe kar lo please <3",
  "dil se request hai, youtube pe @papppuchan subscribe kar dena dosto :)",
  "agar thode maze aaye ho toh yt: @papppuchan subscribe zaroor karna!",
  "chota sa YouTuber hoon, please subscribe kar do yt -> @papppuchan",
  "bhai ki thodi help kar do, youtube pe @papppuchan subscribe maar do!",
  "youtube channel: @papppuchan | ek subscribe toh banta hai yaaro",
  "support me on youtube guys -> @papppuchan (dil se shukriya)"
];

const CONFIG = {
  host: process.env.MC_HOST || 'play.ashsmp.in',
  port: parseInt(process.env.MC_PORT, 10) || 25565,
  username: process.env.MC_USERNAME || 'pappuchan',
  version: '1.20.4',
  brand: 'vanilla',
  auth: 'offline',
  viewDistance: 'far',
  actionDelay: 3000,
  jokeInterval: 65000,
  promoDelay: 10000,
  defaultReconnectDelay: 25000,
  restartReconnectDelay: 45000,
  deniedReconnectDelay: 240000
};

let reconnectTimer = null;
let jokeTimeout = null;
let promoTimeout = null;
let jokeIndex = 0;
let promoIndex = 0;
let currentBot = null;
let lifestealMonitorTimer = null;

// Disguised telemetry logging for hosting environments (keeps console clean of Minecraft chats)
function logService(category, message) {
  console.log(`[${category}] ${message}`);
}

const botState = {
  status: 'Starting',
  connected: false,
  hasLoggedIn: false,
  hasSentLifesteal: false,
  inLifesteal: false,
  inQueue: false,
  hasWarpedAfk: false,
  jokesSent: 0,
  aiRepliesSent: 0,
  lastKickReason: null,
  reconnectCount: 0
};

// Rolling in-memory log buffer for live web console
const chatLogs = [];
function addLog(type, text) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  chatLogs.push({ time: timestamp, type, text });
  if (chatLogs.length > 300) chatLogs.shift();
}

addLog('SYSTEM', 'Telemetry stream monitor initialized. Ready to connect.');

// ----------------------------------------------------
// Web Dashboard & Status Server (Render & Web UI)
// ----------------------------------------------------
let dashboardHtml = '';
try {
  dashboardHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
} catch (e) {
  dashboardHtml = '<h1>Live Stream Monitor</h1>';
}

const server = http.createServer((req, res) => {
  // 1. Live Web Console Dashboard
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(dashboardHtml);
  }

  // 2. Real-time Status & Chat Logs API
  if (req.method === 'GET' && req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      service: 'Stream Monitor',
      bot: CONFIG.username,
      server: CONFIG.host,
      totalJokesAvailable: JOKES.length,
      uptimeSeconds: Math.floor(process.uptime()),
      logs: chatLogs,
      ...botState
    }));
  }

  // 3. Send command or chat from the web browser!
  if (req.method === 'POST' && req.url === '/api/send') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { message } = JSON.parse(body);
        if (message && currentBot && currentBot.player) {
          currentBot.chat(message);
          addLog('SENT', message);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  logService('Web Server', `Live telemetry dashboard running on port ${PORT}`);
});

// Self-ping to prevent Render free instance from spinning down
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  logService('Service', `Self-keepalive enabled for: ${RENDER_URL}`);
  setInterval(() => {
    https.get(`${RENDER_URL}/api/status`, () => {}).on('error', () => {});
  }, 10 * 60 * 1000); // every 10 minutes
}

function parseText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') {
    try {
      const parsed = JSON.parse(obj);
      return parseText(parsed);
    } catch {
      return obj;
    }
  }
  try {
    const simplified = nbt.simplify(obj);
    return String(new ChatMessage(simplified).toString());
  } catch {
    if (obj.text) return String(obj.text);
    return typeof obj === 'object' ? JSON.stringify(obj) : String(obj);
  }
}

// ----------------------------------------------------
// Joke & YouTube Promo Broadcaster (Safe Pacing)
// ----------------------------------------------------
function stopJokeLoop() {
  if (jokeTimeout) {
    clearTimeout(jokeTimeout);
    jokeTimeout = null;
  }
  if (promoTimeout) {
    clearTimeout(promoTimeout);
    promoTimeout = null;
  }
}

function startJokeLoop(bot) {
  stopJokeLoop();
  logService('Worker', 'Background broadcast cycle active.');
  addLog('SYSTEM', `Joke broadcaster started. Broadcasting every ${CONFIG.jokeInterval / 1000}s.`);

  function scheduleNextJoke() {
    jokeTimeout = setTimeout(() => {
      if (!bot || !bot.player || !botState.connected) return;

      const joke = JOKES[jokeIndex % JOKES.length];
      jokeIndex++;
      botState.jokesSent = jokeIndex;

      addLog('JOKE', joke);
      bot.chat(joke);

      // Wait 10 seconds (safe from Ash Guard speed limit), then send promo
      promoTimeout = setTimeout(() => {
        if (!bot || !bot.player || !botState.connected) return;
        const promo = PROMOS[promoIndex % PROMOS.length];
        promoIndex++;

        addLog('PROMO', promo);
        bot.chat(promo);

        scheduleNextJoke();
      }, CONFIG.promoDelay);

    }, CONFIG.jokeInterval);
  }

  // First joke 15s after settling in AFK zone
  jokeTimeout = setTimeout(() => {
    scheduleNextJoke();
  }, 15000);
}

// ----------------------------------------------------
// Automatic Lifesteal Recovery Monitor
// ----------------------------------------------------
function stopLifestealMonitor() {
  if (lifestealMonitorTimer) {
    clearInterval(lifestealMonitorTimer);
    lifestealMonitorTimer = null;
  }
}

function startLifestealMonitor(bot) {
  stopLifestealMonitor();
  lifestealMonitorTimer = setInterval(() => {
    if (!bot || !bot.player || !botState.connected) return;

    // If logged in, but not in Lifesteal and not in queue:
    if (botState.hasLoggedIn && !botState.inLifesteal && !botState.inQueue) {
      addLog('SYSTEM', 'Lifesteal not active. Auto-checking if online via /lifesteal...');
      bot.chat('/lifesteal');
    }
  }, 20000); // Check every 20 seconds
}

function startBot() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  stopJokeLoop();
  stopLifestealMonitor();

  // Reset state machine flags for every fresh connection
  botState.connected = false;
  botState.hasLoggedIn = false;
  botState.hasSentLifesteal = false;
  botState.inLifesteal = false;
  botState.inQueue = false;
  botState.hasWarpedAfk = false;
  botState.status = 'Connecting';

  logService('Gateway', 'Synchronizing upstream stream link...');
  addLog('SYSTEM', `Connecting to ${CONFIG.host} as ${CONFIG.username}...`);

  const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    brand: CONFIG.brand,
    auth: CONFIG.auth,
    viewDistance: CONFIG.viewDistance,
    skinParts: {
      showCape: true,
      showJacket: true,
      showLeftSleeve: true,
      showRightSleeve: true,
      showLeftPants: true,
      showRightPants: true,
      showHat: true
    },
    hideErrors: true
  });

  currentBot = bot;

  // Automatic Resource Pack Handling (Crucial for Lifesteal ItemsAdder plugin)
  bot._client.on('packet', (data, meta) => {
    if (meta.name === 'add_resource_pack') {
      try {
        bot._client.write('resource_pack_receive', { uuid: data.uuid, result: 3 });
        bot._client.write('resource_pack_receive', { uuid: data.uuid, result: 0 });
        addLog('SYSTEM', 'Resource pack accepted & loaded successfully.');
      } catch (e) {
        addLog('SYSTEM', `Resource pack load note: ${e.message}`);
      }
    }
  });

  bot.on('resourcePack', () => {
    bot.acceptResourcePack();
  });

  let nextReconnectDelay = CONFIG.defaultReconnectDelay;

  bot.on('login', () => {
    botState.connected = true;
    botState.status = 'Proxy Connected';
    logService('Gateway', 'Upstream session active.');
    addLog('SYSTEM', 'Logged into server proxy. Waiting for spawn...');
    startLifestealMonitor(bot);
  });

  bot.on('spawn', () => {
    bot.physicsEnabled = true;
    addLog('SYSTEM', `Spawned in world at: ${bot.entity.position}`);

    // Trigger /warp afkzone ONLY after confirmed spawn in Lifesteal
    if (botState.inLifesteal && !botState.hasWarpedAfk) {
      addLog('SYSTEM', 'Lifesteal world loaded. Warping to afkzone in 3s...');
      setTimeout(() => {
        if (botState.inLifesteal && !botState.hasWarpedAfk) {
          botState.hasWarpedAfk = true;
          botState.status = 'AFK in AFK Zone';
          bot.chat('/warp afkzone');
          addLog('SYSTEM', 'AFK zone reached. Staying completely still.');
          startJokeLoop(bot);
        }
      }, CONFIG.actionDelay);
    }
  });

  bot.on('title', (title) => {
    try {
      const text = String(parseText(title) || '').trim();
      if (text.length > 0) {
        const cleaned = cleanChat(text);
        addLog('TITLE', cleaned);
      }
    } catch {}
  });

  // Handle server chat, sequence triggers, bad-words filter, and Groq AI replies
  bot.on('message', async (jsonMsg) => {
    try {
      const raw = jsonMsg.toString();
      const filtered = cleanChat(raw);

      // Log exclusively to the web dashboard (keeps terminal clean)
      addLog('CHAT', filtered);

      const lowerRaw = raw.toLowerCase();

      // 1. Auto-login when prompted
      if (!botState.hasLoggedIn && (raw.includes('/login') || lowerRaw.includes('login using'))) {
        botState.hasLoggedIn = true;
        addLog('SYSTEM', 'Login prompt detected. Executing: /login ggstime');
        setTimeout(() => {
          bot.chat('/login ggstime');
        }, CONFIG.actionDelay);
      }

      // 2. Initial switch to lifesteal after successful login or welcome message in hub
      if (!botState.hasSentLifesteal && (lowerRaw.includes('successfully logged in') || raw.includes('Welcome pappuchan'))) {
        botState.hasLoggedIn = true;
        botState.hasSentLifesteal = true;
        addLog('SYSTEM', 'Login confirmed! Switching to /lifesteal in 3s...');
        setTimeout(() => {
          bot.chat('/lifesteal');
        }, CONFIG.actionDelay);
      }

      // 3. Detect queue for lifesteal
      if (raw.includes('joined the queue for lifesteal') || raw.includes('Position:')) {
        botState.inQueue = true;
        botState.status = 'In Lifesteal Queue';
      }

      // 4. Mark that we are transitioning into Lifesteal
      if (raw.includes('Connecting to lifesteal') || raw.includes('ItemsAdder') || (raw.includes('Lifesteal') && !raw.includes('queue'))) {
        botState.inQueue = false;
        botState.inLifesteal = true;
        botState.status = 'In Lifesteal';
      }

      // 5. Detect if Lifesteal is OFFLINE or RESTARTING
      if (
        lowerRaw.includes('could not connect') ||
        lowerRaw.includes('server is offline') ||
        lowerRaw.includes('server is restarting') ||
        lowerRaw.includes('failed to connect') ||
        lowerRaw.includes('maintenance')
      ) {
        addLog('SYSTEM', 'Lifesteal server is offline/rebooting. Auto-reconnect active...');
        botState.inQueue = false;
        botState.inLifesteal = false;
        botState.status = 'In Hub (Lifesteal Offline)';
      }

      // 6. Detect if server pushes player back to Hub
      if (botState.inLifesteal || botState.hasWarpedAfk) {
        if (
          lowerRaw.includes('connected to hub') ||
          lowerRaw.includes('fallback') ||
          lowerRaw.includes('the server you were on was restarted') ||
          (lowerRaw.includes('hub-') && !lowerRaw.includes('left the hub') && !lowerRaw.includes('joined the hub'))
        ) {
          addLog('SYSTEM', 'Lifesteal restarted. Returned to Hub. Auto-retrying /lifesteal...');
          stopJokeLoop();
          botState.inLifesteal = false;
          botState.hasWarpedAfk = false;
          botState.inQueue = false;
          botState.status = 'In Hub (Waiting for Lifesteal)';
        }
      }

      // 7. If server announces AFK Zone entry
      if (raw.includes('entered the AFK Zone') || raw.includes('AFK Zone')) {
        if (!botState.hasWarpedAfk) {
          botState.hasWarpedAfk = true;
          botState.status = 'AFK in AFK Zone';
          addLog('SYSTEM', 'Verified in AFK Zone. Joke broadcaster starting.');
          startJokeLoop(bot);
        }
      }

      // 8. Groq AI: Cute, heartbroken replies with player name tag and anti-duplicate check
      if (botState.connected && isMentioned(raw, CONFIG.username)) {
        addLog('SYSTEM', `Mention detected: "${filtered}"`);
        const reply = await generateDryReply(raw);
        if (reply && bot && bot.player) {
          setTimeout(() => {
            if (bot && bot.player) {
              addLog('AI', reply);
              bot.chat(reply);
              botState.aiRepliesSent++;
            }
          }, 3000);
        }
      }

    } catch (e) {
      addLog('SYSTEM', `Event parse note: ${e.message}`);
    }
  });

  bot.on('kicked', (reason) => {
    stopJokeLoop();
    stopLifestealMonitor();
    const kickText = String(parseText(reason) || '').trim();
    botState.lastKickReason = kickText;
    addLog('SYSTEM', `Kicked from server: ${kickText}`);

    const lower = kickText.toLowerCase();

    // 1. Anti-Bot First Join Challenge: "Connection verified. Please rejoin to continue."
    if (lower.includes('connection verified') || lower.includes('please rejoin') || lower.includes('rejoin to continue')) {
      nextReconnectDelay = 3000;
      addLog('SYSTEM', 'Verification challenge passed! Rejoining in 3s...');
    }
    // 2. Short wait requested
    else if (lower.includes('few seconds')) {
      nextReconnectDelay = 12000;
      addLog('SYSTEM', 'Waiting 12 seconds before re-verifying...');
    }
    // 3. Server restart / reboot
    else if (lower.includes('restart') || lower.includes('reboot') || lower.includes('server closed')) {
      nextReconnectDelay = CONFIG.restartReconnectDelay;
      addLog('SYSTEM', 'Server reboot detected. Waiting 45s...');
    }
    // 4. IP Denied
    else if (lower.includes('denied from entering') || lower.includes('few minutes')) {
      nextReconnectDelay = CONFIG.deniedReconnectDelay;
      addLog('SYSTEM', `Ash Guard active. Pausing ${CONFIG.deniedReconnectDelay / 60000} mins.`);
    } else {
      nextReconnectDelay = CONFIG.defaultReconnectDelay;
    }
  });

  bot.on('error', (err) => {
    stopJokeLoop();
    stopLifestealMonitor();
    addLog('SYSTEM', `Connection note: ${err.message || err}`);
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      nextReconnectDelay = CONFIG.restartReconnectDelay;
    }
  });

  bot.on('end', () => {
    stopJokeLoop();
    stopLifestealMonitor();
    botState.connected = false;
    botState.status = 'Disconnected';
    botState.reconnectCount++;

    const waitSeconds = Math.round(nextReconnectDelay / 1000);
    logService('Sync', `Link cycle refreshed. Reconnecting in ${waitSeconds}s...`);
    addLog('SYSTEM', `Disconnected. Reconnecting in ${waitSeconds}s...`);

    reconnectTimer = setTimeout(() => {
      startBot();
    }, nextReconnectDelay);
  });
}

// Global process error catch
process.on('uncaughtException', (err) => {
  logService('Process', `Recovery event: ${err.message}`);
});

startBot();
