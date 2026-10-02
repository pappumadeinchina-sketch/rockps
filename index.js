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
let logIdCounter = 0;

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
  logIdCounter++;
  chatLogs.push({ id: logIdCounter, time: timestamp, type, text });
  if (chatLogs.length > 300) chatLogs.shift();
}

addLog('SYSTEM', 'AFK Bot System initialized. Ready to connect.');

// ----------------------------------------------------
// Built-in Web Dashboard & Status Server (with inline fallback)
// ----------------------------------------------------
const EMBEDDED_DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>pappuchan - Live AFK Bot Console</title>
  <link rel="icon" href="https://mc-heads.net/avatar/pappuchan/64" type="image/png">
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --green: #22c55e;
      --yellow: #f59e0b;
      --red: #ef4444;
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    body { background: var(--bg); color: var(--text); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    header { background: var(--card-bg); border-bottom: 1px solid var(--border); padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand img { width: 40px; height: 40px; border-radius: 8px; image-rendering: pixelated; }
    .brand-title { font-size: 1.1rem; font-weight: 700; color: #fff; }
    .brand-subtitle { font-size: 0.8rem; color: var(--text-muted); }
    .stats-bar { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; background: rgba(34, 197, 94, 0.15); color: var(--green); border: 1px solid rgba(34, 197, 94, 0.3); }
    .badge.offline { background: rgba(239, 68, 68, 0.15); color: var(--red); border-color: rgba(239, 68, 68, 0.3); }
    .badge.connecting { background: rgba(245, 158, 11, 0.15); color: var(--yellow); border-color: rgba(245, 158, 11, 0.3); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .stat-pill { font-size: 0.8rem; color: var(--text-muted); background: #0f172a; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); }
    .stat-pill strong { color: #fff; }
    main { flex: 1; display: flex; flex-direction: column; padding: 16px; gap: 12px; overflow: hidden; }
    .terminal-container { flex: 1; background: #090d16; border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
    .terminal-header { background: #111827; padding: 8px 14px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #1f2937; font-size: 0.75rem; color: var(--text-muted); }
    .terminal-logs { flex: 1; padding: 14px; overflow-y: auto; font-family: 'Consolas', 'Courier New', monospace; font-size: 0.85rem; line-height: 1.5; }
    .log-line { display: flex; gap: 10px; margin-bottom: 4px; word-break: break-word; }
    .log-time { color: #64748b; font-size: 0.75rem; user-select: none; min-width: 65px; }
    .tag { font-weight: 700; font-size: 0.75rem; padding: 1px 6px; border-radius: 4px; user-select: none; height: fit-content; }
    .tag-chat { background: #1e293b; color: #94a3b8; }
    .tag-joke { background: rgba(245, 158, 11, 0.2); color: var(--yellow); }
    .tag-promo { background: rgba(239, 68, 68, 0.2); color: var(--red); }
    .tag-ai { background: rgba(168, 85, 247, 0.2); color: var(--purple); }
    .tag-system { background: rgba(56, 189, 248, 0.2); color: var(--accent); }
    .log-msg { flex: 1; color: #e2e8f0; }
    .log-msg.highlight-ai { color: #d8b4fe; font-weight: 600; }
    .log-msg.highlight-joke { color: #fde047; }
    .log-msg.highlight-promo { color: #f87171; }
    .input-bar { display: flex; gap: 8px; }
    .input-bar input { flex: 1; background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; color: #fff; font-size: 0.9rem; outline: none; }
    .input-bar input:focus { border-color: var(--accent); }
    .input-bar button { background: var(--accent); color: #0f172a; border: none; border-radius: 6px; padding: 10px 20px; font-weight: 700; cursor: pointer; transition: opacity 0.2s; }
    .input-bar button:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <img src="https://mc-heads.net/avatar/pappuchan/64" alt="pappuchan avatar">
      <div>
        <div class="brand-title">pappuchan ✦ AFK Bot</div>
        <div class="brand-subtitle">Server: <strong>play.ashsmp.in</strong> (Lifesteal)</div>
      </div>
    </div>
    <div class="stats-bar">
      <div id="statusBadge" class="badge">
        <span class="dot"></span>
        <span id="statusText">Connecting...</span>
      </div>
      <div class="stat-pill">Jokes: <strong id="jokesCount">0/200</strong></div>
      <div class="stat-pill">AI Replies: <strong id="aiCount">0</strong></div>
      <div class="stat-pill">Uptime: <strong id="uptimeText">0s</strong></div>
    </div>
  </header>

  <main>
    <div class="terminal-container">
      <div class="terminal-header">
        <span>● LIVE SERVER CHAT &amp; LOGS</span>
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
          <input type="checkbox" id="autoScroll" checked> Auto-Scroll
        </label>
      </div>
      <div id="logs" class="terminal-logs">
        <div class="log-line">
          <span class="log-time">--:--:--</span>
          <span class="tag tag-system">SYSTEM</span>
          <span class="log-msg">Connecting to live console stream...</span>
        </div>
      </div>
    </div>

    <form id="chatForm" class="input-bar">
      <input type="text" id="chatInput" placeholder="Type a chat message or command (e.g. /spawn, hello guys)..." autocomplete="off">
      <button type="submit">Send</button>
    </form>
  </main>

  <script>
    const logsEl = document.getElementById('logs');
    const autoScrollEl = document.getElementById('autoScroll');
    const statusBadge = document.getElementById('statusBadge');
    const statusText = document.getElementById('statusText');
    const jokesCountEl = document.getElementById('jokesCount');
    const aiCountEl = document.getElementById('aiCount');
    const uptimeTextEl = document.getElementById('uptimeText');
    const chatForm = document.getElementById('chatForm');
    const chatInput = document.getElementById('chatInput');

    let lastLogId = 0;

    function formatUptime(seconds) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const data = await res.json();

        if (data.connected && data.hasWarpedAfk) {
          statusBadge.className = 'badge';
          statusText.textContent = 'ONLINE (AFK ZONE)';
        } else if (data.connected) {
          statusBadge.className = 'badge connecting';
          statusText.textContent = data.status || 'CONNECTED';
        } else {
          statusBadge.className = 'badge offline';
          statusText.textContent = data.status || 'OFFLINE';
        }

        jokesCountEl.textContent = (data.jokesSent || 0) + '/' + (data.totalJokesAvailable || 200);
        aiCountEl.textContent = data.aiRepliesSent || 0;
        uptimeTextEl.textContent = formatUptime(data.uptimeSeconds || 0);

        if (data.logs && data.logs.length > 0) {
          const latest = data.logs[data.logs.length - 1];
          if (latest && latest.id !== lastLogId) {
            lastLogId = latest.id;
            renderLogs(data.logs);
          }
        }
      } catch (e) {
        statusBadge.className = 'badge offline';
        statusText.textContent = 'DISCONNECTED';
      }
    }

    function renderLogs(logs) {
      logsEl.innerHTML = '';
      logs.forEach(item => {
        const line = document.createElement('div');
        line.className = 'log-line';

        let tagClass = 'tag-chat';
        let highlightClass = '';
        if (item.type === 'JOKE') { tagClass = 'tag-joke'; highlightClass = 'highlight-joke'; }
        else if (item.type === 'PROMO') { tagClass = 'tag-promo'; highlightClass = 'highlight-promo'; }
        else if (item.type === 'AI') { tagClass = 'tag-ai'; highlightClass = 'highlight-ai'; }
        else if (item.type === 'SYSTEM') { tagClass = 'tag-system'; }

        line.innerHTML = 
          '<span class="log-time">' + item.time + '</span>' +
          '<span class="tag ' + tagClass + '">' + item.type + '</span>' +
          '<span class="log-msg ' + highlightClass + '">' + escapeHtml(item.text) + '</span>';
        logsEl.appendChild(line);
      });

      if (autoScrollEl.checked) {
        logsEl.scrollTop = logsEl.scrollHeight;
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    chatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = '';

      try {
        await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text })
        });
      } catch (err) {
        alert('Failed to send message: ' + err.message);
      }
    });

    setInterval(fetchStatus, 2000);
    fetchStatus();
  </script>
</body>
</html>`;

let dashboardHtml = '';
try {
  dashboardHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
} catch (e) {
  dashboardHtml = EMBEDDED_DASHBOARD_HTML;
}

const server = http.createServer((req, res) => {
  // 1. Live Web Console Dashboard
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(dashboardHtml || EMBEDDED_DASHBOARD_HTML);
  }

  // 2. Real-time Status & Chat Logs API
  if (req.method === 'GET' && req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      service: 'Minecraft AFK Bot',
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
          console.log(`[Web Sent] ${message}`);
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
  console.log(`[Web Server] Live chat dashboard listening on port ${PORT}`);
});

// Self-ping to prevent Render free tier from idling
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  console.log(`[Self-Ping] Enabled for: ${RENDER_URL}`);
  setInterval(() => {
    https.get(`${RENDER_URL}/api/status`, () => {}).on('error', () => {});
  }, 10 * 60 * 1000); // 10 mins
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
  console.log(`\n[Joke Broadcaster] Activated! Jokes every ${CONFIG.jokeInterval / 1000}s, promo after ${CONFIG.promoDelay / 1000}s.`);
  addLog('SYSTEM', `Joke broadcaster started. Broadcasting every ${CONFIG.jokeInterval / 1000}s.`);

  function scheduleNextJoke() {
    jokeTimeout = setTimeout(() => {
      if (!bot || !bot.player || !botState.connected) return;

      const joke = JOKES[jokeIndex % JOKES.length];
      jokeIndex++;
      botState.jokesSent = jokeIndex;

      console.log(`\n[Joke #${jokeIndex}/${JOKES.length}] ${joke}`);
      addLog('JOKE', joke);
      bot.chat(joke);

      // Wait 10 seconds (safe from Ash Guard speed limit), then send varied promo
      promoTimeout = setTimeout(() => {
        if (!bot || !bot.player || !botState.connected) return;
        const promo = PROMOS[promoIndex % PROMOS.length];
        promoIndex++;

        console.log(`[Promo] ${promo}\n`);
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
      console.log(`[Lifesteal Monitor] Auto-checking if Lifesteal is back online: /lifesteal`);
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

  console.log(`\n==================================================`);
  console.log(`[Bot] Connecting to ${CONFIG.host} as ${CONFIG.username}...`);
  console.log(`==================================================\n`);
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
    hideErrors: false
  });

  currentBot = bot;

  // Handle anti-bot verification challenge GUI / Inventory if sent
  bot.on('windowOpen', (window) => {
    console.log(`[Anti-Bot Window] Window opened: ${window.title}`);
    addLog('SYSTEM', `Verification Window opened: ${window.title}`);
    setTimeout(() => {
      try {
        bot.clickWindow(0, 0, 0);
        console.log(`[Anti-Bot Window] Clicked slot 0.`);
      } catch (e) {}
    }, 1000);
  });

  // Automatic Resource Pack Handling (Crucial for Lifesteal ItemsAdder plugin)
  bot._client.on('packet', (data, meta) => {
    if (meta.name === 'add_resource_pack') {
      try {
        bot._client.write('resource_pack_receive', { uuid: data.uuid, result: 3 });
        bot._client.write('resource_pack_receive', { uuid: data.uuid, result: 0 });
        console.log(`[Bot] Server requested resource pack: Accepted & Loaded.`);
        addLog('SYSTEM', 'Resource pack accepted & loaded successfully.');
      } catch (e) {
        console.error(`[Bot] Resource pack response error:`, e.message);
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
    console.log(`[Bot] Logged into server proxy. Waiting for spawn...`);
    addLog('SYSTEM', 'Logged into server proxy. Waiting for spawn...');
    startLifestealMonitor(bot);
  });

  bot.on('spawn', () => {
    bot.physicsEnabled = true;
    console.log(`[Bot] Spawned in world at: ${bot.entity.position}`);
    addLog('SYSTEM', `Spawned in world at: ${bot.entity.position}`);

    // Human-like actions to immediately pass anti-bot / headless client check
    try {
      bot.swingArm();
      bot.look(0, 0, true);
    } catch (e) {}

    // Trigger /warp afkzone ONLY after confirmed spawn in Lifesteal
    if (botState.inLifesteal && !botState.hasWarpedAfk) {
      console.log(`[Bot] Lifesteal world fully loaded! Waiting 3s before /warp afkzone...`);
      addLog('SYSTEM', 'Lifesteal world loaded. Warping to afkzone in 3s...');
      setTimeout(() => {
        if (botState.inLifesteal && !botState.hasWarpedAfk) {
          botState.hasWarpedAfk = true;
          botState.status = 'AFK in AFK Zone';
          console.log(`[Bot] Executing: /warp afkzone`);
          bot.chat('/warp afkzone');
          console.log(`[Bot] AFK zone reached! Staying completely still.`);
          addLog('SYSTEM', 'AFK zone reached. Staying completely still.');
          startJokeLoop(bot);
        }
      }, CONFIG.actionDelay);
    }
  });

  // Display server action bar
  bot.on('actionBar', (actionbar) => {
    try {
      const text = cleanChat(actionbar.toString().trim());
      if (text.length > 0) {
        console.log(`[ActionBar] ${text}`);
        addLog('SYSTEM', `[ActionBar] ${text}`);
      }
    } catch {}
  });

  // Display server titles/action bars cleanly
  bot.on('title', (title) => {
    try {
      const text = String(parseText(title) || '').trim();
      if (text.length > 0) {
        const cleaned = cleanChat(text);
        console.log(`[Server Title] ${cleaned}`);
        addLog('TITLE', cleaned);
      }
    } catch {}
  });

  // Handle server chat, sequence triggers, bad-words filter, and Groq AI replies
  bot.on('message', async (jsonMsg) => {
    try {
      const raw = jsonMsg.toString();
      const filtered = cleanChat(raw);

      // Print to both Console and Web Dashboard!
      console.log(`[Chat] ${filtered}`);
      addLog('CHAT', filtered);

      const lowerRaw = raw.toLowerCase();

      // 1. Auto-login when prompted
      if (!botState.hasLoggedIn && (raw.includes('/login') || lowerRaw.includes('login using'))) {
        botState.hasLoggedIn = true;
        console.log(`[Bot] Login prompt detected. Waiting 3s before /login ggstime...`);
        addLog('SYSTEM', 'Login prompt detected. Executing: /login ggstime');
        setTimeout(() => {
          bot.chat('/login ggstime');
        }, CONFIG.actionDelay);
      }

      // 2. Initial switch to lifesteal after successful login or welcome message in hub
      if (!botState.hasSentLifesteal && (lowerRaw.includes('successfully logged in') || raw.includes('Welcome pappuchan'))) {
        botState.hasLoggedIn = true;
        botState.hasSentLifesteal = true;
        console.log(`[Bot] Login confirmed! Switching to /lifesteal in 3s...`);
        addLog('SYSTEM', 'Login confirmed! Switching to /lifesteal in 3s...');
        setTimeout(() => {
          console.log(`[Bot] Executing: /lifesteal`);
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
        console.log(`\n[Lifesteal Monitor] Lifesteal is offline/rebooting. Will auto-retry until online...\n`);
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
          console.log(`\n[Lifesteal Monitor] Lifesteal went offline/restarted! Returned to Hub. Auto-retrying /lifesteal...\n`);
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
          console.log(`[Bot] Verified: You are currently in the AFK Zone! No movement active.`);
          addLog('SYSTEM', 'Verified in AFK Zone. Joke broadcaster starting.');
          startJokeLoop(bot);
        }
      }

      // 8. Groq AI: Cute, heartbroken replies with player name tag and anti-duplicate check
      if (botState.connected && isMentioned(raw, CONFIG.username)) {
        console.log(`\n[Mention Detected] Someone mentioned you: "${filtered}"`);
        addLog('SYSTEM', `Mention detected: "${filtered}"`);
        const reply = await generateDryReply(raw);
        if (reply && bot && bot.player) {
          setTimeout(() => {
            if (bot && bot.player) {
              console.log(`[Groq AI Reply] ${reply}\n`);
              addLog('AI', reply);
              bot.chat(reply);
              botState.aiRepliesSent++;
            }
          }, 3000);
        }
      }

    } catch (e) {
      console.log(`[Chat Error]`, e.message);
    }
  });

  bot.on('kicked', (reason) => {
    stopJokeLoop();
    stopLifestealMonitor();
    const kickText = String(parseText(reason) || '').trim();
    botState.lastKickReason = kickText;
    console.log(`\n[Bot] Kicked from server.`);
    console.log(`----------------------------------------`);
    console.log(kickText);
    console.log(`----------------------------------------\n`);
    addLog('SYSTEM', `Kicked from server: ${kickText}`);

    const lower = kickText.toLowerCase();

    // 1. Anti-Bot First Join Challenge: "Connection verified. Please rejoin to continue."
    if (lower.includes('connection verified') || lower.includes('please rejoin') || lower.includes('rejoin to continue')) {
      nextReconnectDelay = 3000;
      console.log(`[Verification Challenge] Server requested immediate rejoin! Reconnecting in 3s...`);
      addLog('SYSTEM', 'Verification challenge passed! Rejoining in 3s...');
    }
    // 2. Short wait requested: "Please wait a few seconds before trying to verify again"
    else if (lower.includes('few seconds') || lower.includes('failed the bot verification')) {
      nextReconnectDelay = 12000;
      console.log(`[ASH GUARD Challenge] Waiting 12 seconds before re-verifying...`);
      addLog('SYSTEM', 'Waiting 12 seconds before re-verifying...');
    }
    // 3. Server restart / reboot
    else if (lower.includes('restart') || lower.includes('reboot') || lower.includes('server closed')) {
      nextReconnectDelay = CONFIG.restartReconnectDelay;
      console.log(`[Server Restart Detected] Waiting 45s for server to boot...`);
      addLog('SYSTEM', 'Server reboot detected. Waiting 45s...');
    }
    // 4. IP Denied
    else if (lower.includes('denied from entering') || lower.includes('few minutes')) {
      nextReconnectDelay = CONFIG.deniedReconnectDelay;
      console.log(`[ASH GUARD Active] Temporary rate limit. Pausing ${CONFIG.deniedReconnectDelay / 60000} mins.`);
      addLog('SYSTEM', `Ash Guard active. Pausing ${CONFIG.deniedReconnectDelay / 60000} mins.`);
    } else {
      nextReconnectDelay = CONFIG.defaultReconnectDelay;
    }
  });

  bot.on('error', (err) => {
    stopJokeLoop();
    stopLifestealMonitor();
    console.error(`\n[Bot] Connection error:`, err.message || err);
    addLog('SYSTEM', `Error: ${err.message || err}`);
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      nextReconnectDelay = CONFIG.restartReconnectDelay;
      console.log(`[Server Offline] Port unreachable. Waiting 45s...`);
    }
  });

  bot.on('end', () => {
    stopJokeLoop();
    stopLifestealMonitor();
    botState.connected = false;
    botState.status = 'Disconnected';
    botState.reconnectCount++;

    const waitSeconds = Math.round(nextReconnectDelay / 1000);
    console.log(`\n[Bot] Disconnected. Reconnecting in ${waitSeconds}s (Total reconnects: ${botState.reconnectCount})...`);
    addLog('SYSTEM', `Disconnected. Reconnecting in ${waitSeconds}s...`);

    reconnectTimer = setTimeout(() => {
      startBot();
    }, nextReconnectDelay);
  });
}

// Global process error catch
process.on('uncaughtException', (err) => {
  console.error('[Process Error]', err.message);
});

startBot();
