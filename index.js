const mineflayer = require('mineflayer');
const readline = require('readline');
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
  "papppuchan search kar lo dosto thoda support mil jayega",
  "bhai log kabhi bore ho toh papppuchan dekh lena maze aayenge",
  "dil se shukriya sabhi ko jo support karte hain",
  "kisi ko acche jokes chahiye toh papppuchan search kar lena dosto",
  "papppuchan ko support karo bhai log dil se pyaar milega"
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
  jokeInterval: 75000,
  promoDelay: 12000,
  defaultReconnectDelay: 25000,
  restartReconnectDelay: 45000,
  deniedReconnectDelay: 240000
};

let rl = null;
let reconnectTimer = null;
let jokeTimeout = null;
let promoTimeout = null;
let afkTransitionTimer = null;
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
  isMuted: false,
  muteExpiryTimer: null,
  jokesSent: 0,
  aiRepliesSent: 0,
  lastKickReason: null,
  reconnectCount: 0
};

// Rolling in-memory log buffer for live web console
const chatLogs = [];
function addLog(type, text, html = null) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  logIdCounter++;
  const safeText = typeof text === 'string' ? text : (typeof text === 'object' ? JSON.stringify(text) : String(text || ''));
  const safeHtml = typeof html === 'string' ? html : null;
  chatLogs.push({ id: logIdCounter, time: timestamp, type, text: safeText, html: safeHtml });
  if (chatLogs.length > 300) chatLogs.shift();
}

addLog('SYSTEM', 'AFK Bot System initialized. Ready to connect.');

// ----------------------------------------------------
// Terminal Console Keyboard Input (Type and hit Enter!)
// ----------------------------------------------------
function setupConsoleInput(bot) {
  if (rl) {
    try { rl.close(); } catch {}
    rl = null;
  }

  try {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> '
    });

    rl.on('line', (line) => {
      const text = line.trim();
      if (text.length > 0) {
        if (currentBot && currentBot._client) {
          currentBot.chat(text);
          console.log(`[You] ${text}`);
          addLog('SENT', text);
        } else {
          console.log(`[Notice] Bot is not connected right now. Please wait.`);
        }
      }
      try { rl.prompt(); } catch {}
    });

    rl.prompt();
  } catch (e) {
    // Non-interactive environment fallback
  }
}

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
    .tag-sent { background: rgba(34, 197, 94, 0.2); color: var(--green); }
    .tag-title { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
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
      <input type="text" id="chatInput" placeholder="Type a chat message or command (e.g. /spawn, /lifesteal, hello)..." autocomplete="off">
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
        else if (item.type === 'SENT') { tagClass = 'tag-sent'; }
        else if (item.type === 'TITLE') { tagClass = 'tag-title'; }

        // Render full colored HTML if available, otherwise safe text
        const content = item.html || escapeHtml(item.text);

        line.innerHTML = 
          '<span class="log-time">' + item.time + '</span>' +
          '<span class="tag ' + tagClass + '">' + item.type + '</span>' +
          '<span class="log-msg ' + highlightClass + '">' + content + '</span>';
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

      try {
        const res = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text })
        });
        const result = await res.json();
        if (!res.ok) {
          alert(result.error || 'Failed to send message.');
        } else {
          chatInput.value = '';
        }
      } catch (err) {
        alert('Failed to send: ' + err.message);
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
        if (!message || message.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Message cannot be empty.' }));
        }

        if (currentBot && currentBot._client) {
          currentBot.chat(message);
          addLog('SENT', message);
          console.log(`[Web Sent] ${message}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Bot is not connected to server yet.' }));
        }
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
  console.log(`[Web Dashboard] Live chat dashboard active at http://localhost:${PORT}`);
});

// Self-ping to prevent Render free tier from idling
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  console.log(`[Self-Ping] Enabled for: ${RENDER_URL}`);
  setInterval(() => {
    https.get(`${RENDER_URL}/api/status`, () => {}).on('error', () => {});
  }, 10 * 60 * 1000);
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
  if (botState.isMuted) {
    console.log(`\x1b[33m[Joke Broadcaster] Bot is currently muted. Chat paused, continuing silent AFK farming.\x1b[0m`);
    return;
  }
  console.log(`\n\x1b[32m[Joke Broadcaster] Activated! Jokes every ${CONFIG.jokeInterval / 1000}s, promo after ${CONFIG.promoDelay / 1000}s.\x1b[0m`);
  addLog('SYSTEM', `Joke broadcaster started. Broadcasting every ${CONFIG.jokeInterval / 1000}s.`);

  function scheduleNextJoke() {
    jokeTimeout = setTimeout(() => {
      if (!bot || !bot.player || !botState.connected || botState.isMuted) return;

      const joke = JOKES[jokeIndex % JOKES.length];
      jokeIndex++;
      botState.jokesSent = jokeIndex;

      console.log(`\n\x1b[33m[Joke #${jokeIndex}/${JOKES.length}]\x1b[0m ${joke}`);
      addLog('JOKE', joke);
      bot.chat(joke);

      // Wait safe interval, then send varied promo
      promoTimeout = setTimeout(() => {
        if (!bot || !bot.player || !botState.connected || botState.isMuted) return;
        const promo = PROMOS[promoIndex % PROMOS.length];
        promoIndex++;

        console.log(`\x1b[31m[Promo]\x1b[0m ${promo}\n`);
        addLog('PROMO', promo);
        bot.chat(promo);

        scheduleNextJoke();
      }, CONFIG.promoDelay);

    }, CONFIG.jokeInterval);
  }

  // First joke 20s after settling in AFK zone
  jokeTimeout = setTimeout(() => {
    scheduleNextJoke();
  }, 20000);
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
      console.log(`\x1b[36m[Lifesteal Monitor] Auto-checking if Lifesteal is back online: /lifesteal\x1b[0m`);
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
    checkTimeoutInterval: 90 * 1000, // 90s keepalive to survive server lag spikes!
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
  setupConsoleInput(bot);

  // Handle anti-bot verification challenge GUI / Inventory if sent
  bot.on('windowOpen', (window) => {
    console.log(`[Anti-Bot Window] Window opened: ${window.title}`);
    addLog('SYSTEM', `Verification Window opened: ${window.title}`);
    setTimeout(() => {
      try {
        bot.clickWindow(0, 0, 0);
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
    console.log(`\x1b[32m[Bot] Logged into server proxy. Waiting for spawn...\x1b[0m`);
    addLog('SYSTEM', 'Logged into server proxy. Waiting for spawn...');
    startLifestealMonitor(bot);
    setupConsoleInput(bot);
  });

  // Handle trigger sequence to warp to AFK zone and drop into 0.5-block hole
  function triggerAfkZoneSequence(targetBot) {
    if (botState.hasWarpedAfk || !botState.inLifesteal) return;
    if (afkTransitionTimer) return; // Sequence already queued

    console.log(`\x1b[36m[Bot] In Lifesteal! Teleporting to AFK Zone in 4s...\x1b[0m`);
    addLog('SYSTEM', 'In Lifesteal. Preparing /warp afkzone in 4s...');

    afkTransitionTimer = setTimeout(() => {
      afkTransitionTimer = null;
      if (botState.hasWarpedAfk || !botState.inLifesteal) return;
      if (!targetBot || !targetBot._client) return;

      botState.hasWarpedAfk = true;
      botState.status = 'Warping to AFK Zone';
      console.log(`\x1b[32m[Bot] Executing: /warp afkzone\x1b[0m`);
      addLog('SYSTEM', 'Executing: /warp afkzone');
      targetBot.chat('/warp afkzone');

      // Wait 3s for teleportation & chunk load
      setTimeout(() => {
        if (!targetBot || !targetBot.entity) return;
        console.log(`\x1b[36m[Bot] Teleported to AFK Zone. Walking forward into the 0.5-block hole...\x1b[0m`);
        addLog('SYSTEM', 'Walking forward into AFK hole...');

        // Face straight forward
        try {
          targetBot.look(targetBot.entity.yaw, 0, true);
        } catch (e) {}

        // Walk forward for 2.2 seconds to drop right into the hole
        targetBot.setControlState('forward', true);

        setTimeout(() => {
          targetBot.setControlState('forward', false);
          botState.status = 'AFK in AFK Hole';
          console.log(`\x1b[32m[Bot] In AFK hole! Staying completely still to farm shards.\x1b[0m`);
          addLog('SYSTEM', 'In AFK hole! Completely still. Shards farming active.');
          if (!botState.isMuted) {
            startJokeLoop(targetBot);
          }
        }, 2200);
      }, 3000);
    }, 4000);
  }

  bot.on('respawn', () => {
    console.log(`[Bot] Dimension / World respawn event received.`);
    addLog('SYSTEM', 'World respawn event received.');
    if (botState.inLifesteal && !botState.hasWarpedAfk) {
      triggerAfkZoneSequence(bot);
    }
  });

  bot.on('spawn', () => {
    bot.physicsEnabled = true;
    console.log(`[Bot] Spawned in world at: ${bot.entity.position}`);
    addLog('SYSTEM', `Spawned in world at: ${bot.entity.position}`);

    // Human-like actions to pass anti-bot / headless client check
    try {
      bot.swingArm();
      bot.look(0, 0, true);
    } catch (e) {}

    // Trigger /warp afkzone if in Lifesteal
    if (botState.inLifesteal && !botState.hasWarpedAfk) {
      triggerAfkZoneSequence(bot);
    }
  });

  // Display server action bar with ANSI & HTML colors
  bot.on('actionBar', (actionbar) => {
    try {
      const plain = actionbar.toString().trim();
      const ansi = actionbar.toAnsi ? actionbar.toAnsi().trim() : plain;
      const html = actionbar.toHTML ? actionbar.toHTML().trim() : null;
      if (plain.length > 0) {
        console.log(`[ActionBar] ${ansi}`);
        addLog('SYSTEM', `[ActionBar] ${plain}`, html);
      }
    } catch {}
  });

  // Display server titles/action bars cleanly
  bot.on('title', (title) => {
    try {
      const plain = String(parseText(title) || '').trim();
      if (plain.length > 0) {
        const cleaned = cleanChat(plain);
        console.log(`\x1b[33m[Server Title] ${cleaned}\x1b[0m`);
        addLog('TITLE', cleaned);
      }
    } catch {}
  });

  // Handle server chat, sequence triggers, bad-words filter, and Groq AI replies
  bot.on('message', async (jsonMsg) => {
    try {
      const raw = jsonMsg.toString();
      const filtered = cleanChat(raw);

      // Render full in-game Minecraft colors without [object Object] leaks
      let ansiFormatted = filtered;
      try {
        if (typeof jsonMsg.toAnsi === 'function') {
          const res = jsonMsg.toAnsi();
          if (typeof res === 'string' && !res.includes('[object Object]')) {
            ansiFormatted = res;
          }
        }
      } catch {}

      let htmlFormatted = null;
      try {
        if (typeof jsonMsg.toHTML === 'function') {
          const res = jsonMsg.toHTML();
          if (typeof res === 'string' && !res.includes('[object Object]')) {
            htmlFormatted = res;
          }
        }
      } catch {}

      if (filtered !== raw) {
        ansiFormatted = cleanChat(ansiFormatted);
      }

      // Print colored text in CMD console & Web Dashboard
      console.log(`[Chat] ${ansiFormatted}`);
      addLog('CHAT', filtered, htmlFormatted);

      const lowerRaw = raw.toLowerCase();

      // Detect Ash Guard mute
      if (raw.includes('You were muted') || raw.includes('Staff: AshRarity') || raw.includes('cannot talk while muted')) {
        botState.isMuted = true;
        console.log(`\n\x1b[31m[Ash Guard Mute Detected] Bot is muted. Staying silent in AFK hole to farm shards.\x1b[0m\n`);
        addLog('SYSTEM', 'Bot is muted. Chat paused. Continuing AFK shard farming...');
        stopJokeLoop();
        if (botState.muteExpiryTimer) clearTimeout(botState.muteExpiryTimer);
        botState.muteExpiryTimer = setTimeout(() => {
          botState.isMuted = false;
          console.log(`\x1b[32m[Ash Guard] Mute period ended. Chat resuming.\x1b[0m`);
          addLog('SYSTEM', 'Mute period ended. Chat resuming.');
          if (botState.hasWarpedAfk) startJokeLoop(bot);
        }, 47 * 60 * 1000);
      }

      // 1. Auto-login when prompted
      if (!botState.hasLoggedIn && (raw.includes('/login') || lowerRaw.includes('login using'))) {
        botState.hasLoggedIn = true;
        console.log(`\x1b[32m[Bot] Login prompt detected. Waiting 3s before /login ggstime...\x1b[0m`);
        addLog('SYSTEM', 'Login prompt detected. Executing: /login ggstime');
        setTimeout(() => {
          bot.chat('/login ggstime');
        }, CONFIG.actionDelay);
      }

      // 2. Initial switch to lifesteal after successful login or welcome message in hub
      if (!botState.hasSentLifesteal && (lowerRaw.includes('successfully logged in') || raw.includes('Welcome pappuchan'))) {
        botState.hasLoggedIn = true;
        botState.hasSentLifesteal = true;
        console.log(`\x1b[32m[Bot] Login confirmed! Switching to /lifesteal in 3s...\x1b[0m`);
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
        triggerAfkZoneSequence(bot);
      }

      // Also detect if we are seeing Lifesteal in-game messages
      if (!botState.hasWarpedAfk && (
        raw.includes('was killed by') ||
        raw.includes('Item cleanup') ||
        raw.includes('voted on Minecraft') ||
        (raw.includes('☀') && raw.includes('»'))
      )) {
        botState.inQueue = false;
        botState.inLifesteal = true;
        triggerAfkZoneSequence(bot);
      }

      // 5. Detect if Lifesteal is OFFLINE or RESTARTING
      if (
        lowerRaw.includes('could not connect') ||
        lowerRaw.includes('server is offline') ||
        lowerRaw.includes('server is restarting') ||
        lowerRaw.includes('failed to connect') ||
        lowerRaw.includes('maintenance')
      ) {
        console.log(`\n\x1b[31m[Lifesteal Monitor] Lifesteal is offline/rebooting. Will auto-retry until online...\x1b[0m\n`);
        addLog('SYSTEM', 'Lifesteal server is offline/rebooting. Auto-reconnect active...');
        botState.inQueue = false;
        botState.inLifesteal = false;
        botState.hasWarpedAfk = false;
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
          console.log(`\n\x1b[33m[Lifesteal Monitor] Lifesteal restarted! Returned to Hub. Auto-retrying /lifesteal...\x1b[0m\n`);
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
          console.log(`\x1b[32m[Bot] Server announced AFK Zone. Moving into hole...\x1b[0m`);
          addLog('SYSTEM', 'Entered AFK Zone. Moving into hole in 1s...');
          setTimeout(() => {
            bot.setControlState('forward', true);
            setTimeout(() => {
              bot.setControlState('forward', false);
              botState.status = 'AFK in AFK Hole';
              console.log(`\x1b[32m[Bot] In AFK hole! Staying completely still.\x1b[0m`);
              addLog('SYSTEM', 'In AFK hole! Staying completely still.');
              if (!botState.isMuted) startJokeLoop(bot);
            }, 2200);
          }, 1000);
        }
      }

      // 8. Groq AI: Cute, heartbroken replies with player name tag and anti-duplicate check
      if (botState.connected && !botState.isMuted && botState.hasWarpedAfk && isMentioned(raw, CONFIG.username)) {
        console.log(`\n\x1b[35m[Mention Detected] Someone mentioned you: "${filtered}"\x1b[0m`);
        addLog('SYSTEM', `Mention detected: "${filtered}"`);
        const reply = await generateDryReply(raw);
        if (reply && bot && bot.player && !botState.isMuted) {
          setTimeout(() => {
            if (bot && bot.player && !botState.isMuted) {
              console.log(`\x1b[35m[Groq AI Reply]\x1b[0m ${reply}\n`);
              addLog('AI', reply);
              bot.chat(reply);
              botState.aiRepliesSent++;
            }
          }, 3000);
        }
      }

    } catch (e) {
      // Quiet handler for chat parse errors
    }
  });

  bot.on('kicked', (reason) => {
    stopJokeLoop();
    stopLifestealMonitor();
    const kickText = String(parseText(reason) || '').trim();
    botState.lastKickReason = kickText;
    console.log(`\n\x1b[31m[Bot] Kicked from server.\x1b[0m`);
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
      console.log(`\x1b[31m[ASH GUARD Active] Temporary rate limit. Pausing ${CONFIG.deniedReconnectDelay / 60000} mins.\x1b[0m`);
      addLog('SYSTEM', `Ash Guard active. Pausing ${CONFIG.deniedReconnectDelay / 60000} mins.`);
    } else {
      nextReconnectDelay = CONFIG.defaultReconnectDelay;
    }
  });

  bot.on('error', (err) => {
    stopJokeLoop();
    stopLifestealMonitor();
    console.error(`\x1b[31m[Bot] Connection error:\x1b[0m`, err.message || err);
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
