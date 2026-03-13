/**
 * client.js — Game Client
 * 2D Top-Down Multiplayer Extraction Shooter MVP
 *
 * Responsibilities:
 *  - Connect to the server via Socket.io
 *  - Capture keyboard (WASD) and mouse input, emit to server
 *  - Render the authoritative game state on an HTML5 Canvas each frame
 *  - Implement client-side visual effects: fog of war, portal glow, etc.
 *  - Apply simple client-side position interpolation for smooth rendering
 *  - Update the HTML HUD (HP bar, inventory list, extraction progress)
 */

// ─── DOM References ───────────────────────────────────────────────────────────
const joinScreen      = document.getElementById('join-screen');
const gameScreen      = document.getElementById('game-screen');
const nameInput       = document.getElementById('name-input');
const joinBtn         = document.getElementById('join-btn');
const canvas          = document.getElementById('gameCanvas');
const ctx             = canvas.getContext('2d');
const hpBar           = document.getElementById('hp-bar');
const hpText          = document.getElementById('hp-text');
const inventoryList   = document.getElementById('inventory-list');
const extractionHud   = document.getElementById('hud-extraction');
const extractionBar   = document.getElementById('extraction-bar');
const overlay         = document.getElementById('overlay');
const overlayTitle    = document.getElementById('overlay-title');
const overlayMessage  = document.getElementById('overlay-message');

// ─── Client State ─────────────────────────────────────────────────────────────
let socket        = null;   // Socket.io connection
let myId          = null;   // Our socket id assigned by server
let gameInited    = false;  // True once 'init' event received

// World constants received from the server on 'init'
let MAP_W         = 2000;
let MAP_H         = 2000;
let VISION_R      = 600;
let EXTRACT_TIME  = 3;
let PORTAL_DEF    = null;   // { x, y, size }
let ITEM_DEFS     = {};     // { [name]: { emoji, stat, value, description } }

// Latest authoritative snapshot from the server
let latestState   = null;

// Interpolation: keep previous and target positions per entity
// { [id]: { x, y } }
const renderPos   = {};

// Camera offset (top-left corner of the viewport in world space)
let camX = 0;
let camY = 0;

// Input state
const keys = { w: false, a: false, s: false, d: false };
let mouseWorldX = 0;
let mouseWorldY = 0;
let aimAngle = 0;

// Time for delta-time calculations
let lastFrameTime = performance.now();

// ─── Resize Canvas to Viewport ────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── Join Screen Logic ────────────────────────────────────────────────────────

joinBtn.addEventListener('click', startGame);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startGame();
});

function startGame() {
  const name = nameInput.value.trim() || undefined;

  // Connect to the Socket.io server
  socket = io();

  bindSocketEvents();

  // Tell the server we want to join
  socket.emit('playerJoin', { name });

  // Switch to game screen
  joinScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');

  // Start the render loop
  requestAnimationFrame(renderLoop);
}

// ─── Socket Event Handlers ────────────────────────────────────────────────────

function bindSocketEvents() {
  // Received once after joining: static world data
  socket.on('init', (data) => {
    myId         = data.playerId;
    MAP_W        = data.mapWidth;
    MAP_H        = data.mapHeight;
    VISION_R     = data.visionRadius;
    EXTRACT_TIME = data.extractionTime;
    PORTAL_DEF   = data.portal;
    ITEM_DEFS    = data.itemDefs || {};
    gameInited   = true;
    console.log('[Client] Initialised. My ID:', myId);
  });

  // Authoritative game state arrives ~60 times per second
  socket.on('gameState', (state) => {
    latestState = state;
    // Update interpolation targets
    for (const id in state.players) {
      if (!renderPos[id]) {
        // First time we see this player: snap to their position
        renderPos[id] = { x: state.players[id].x, y: state.players[id].y };
      }
      // else: we'll lerp toward the new position each frame
    }
  });

  // Feedback when we pick up an item
  socket.on('itemPickup', (data) => {
    showPickupNotice(data.item, data.source);
  });

  // Server tells us we took damage (inventory/HP already reflected in next gameState)
  socket.on('damaged', (data) => {
    flashScreen('rgba(180, 0, 30, 0.35)');
  });

  // We died
  socket.on('playerDied', (data) => {
    showOverlay('☠ You Died', 'All your loot has been dropped on the ground.');
  });

  // We successfully extracted
  socket.on('extracted', (data) => {
    const msg = data.items && data.items.length > 0
      ? `You escaped with:\n${data.items.join(', ')}`
      : 'You escaped… with nothing.';
    showOverlay('✦ Extracted!', msg);
  });
}

// ─── Input Handling ───────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  handleKey(e.key.toLowerCase(), true);
  // E key: interact / loot
  if (e.key.toLowerCase() === 'e' && socket) {
    socket.emit('interact');
  }
});

document.addEventListener('keyup', (e) => {
  handleKey(e.key.toLowerCase(), false);
});

function handleKey(key, down) {
  if (key === 'w' || key === 'arrowup')    keys.w = down;
  if (key === 's' || key === 'arrowdown')  keys.s = down;
  if (key === 'a' || key === 'arrowleft')  keys.a = down;
  if (key === 'd' || key === 'arrowright') keys.d = down;
}

canvas.addEventListener('mousemove', (e) => {
  // Convert screen coordinates to world coordinates using the camera offset
  mouseWorldX = e.clientX + camX;
  mouseWorldY = e.clientY + camY;
  updateAim();
});

canvas.addEventListener('click', () => {
  if (socket) socket.emit('shoot');
});

function updateAim() {
  if (!myId || !latestState || !latestState.players[myId]) return;
  const me = latestState.players[myId];
  aimAngle = Math.atan2(mouseWorldY - me.y, mouseWorldX - me.x);
}

// Send input state to the server at ~60 fps (throttled by rAF)
function sendInput() {
  if (!socket || !gameInited) return;
  socket.emit('playerInput', {
    up:       keys.w,
    down:     keys.s,
    left:     keys.a,
    right:    keys.d,
    aimAngle: aimAngle,
  });
}

// ─── Render Loop ──────────────────────────────────────────────────────────────

function renderLoop(timestamp) {
  const dt = Math.min((timestamp - lastFrameTime) / 1000, 0.1); // cap dt
  lastFrameTime = timestamp;

  sendInput();

  if (latestState && gameInited) {
    interpolatePositions(dt);
    updateCamera();
    drawFrame();
    updateHUD();
  } else {
    // Draw a loading screen while waiting for the first state
    drawLoading();
  }

  requestAnimationFrame(renderLoop);
}

// ─── Client-Side Interpolation ────────────────────────────────────────────────
/**
 * Lerp each entity's rendered position toward the server-authoritative position.
 * This smooths out the ~16ms gaps between 60fps server ticks on the visual side.
 */
function interpolatePositions(dt) {
  const LERP_SPEED = 18; // higher = snappier
  const factor = Math.min(1, LERP_SPEED * dt);

  for (const id in latestState.players) {
    const target = latestState.players[id];
    if (!renderPos[id]) {
      renderPos[id] = { x: target.x, y: target.y };
    } else {
      renderPos[id].x += (target.x - renderPos[id].x) * factor;
      renderPos[id].y += (target.y - renderPos[id].y) * factor;
    }
  }
}

// ─── Camera ───────────────────────────────────────────────────────────────────
/** Keep the local player centred in the viewport. */
function updateCamera() {
  if (!myId || !latestState.players[myId]) return;
  const me = renderPos[myId] || latestState.players[myId];
  camX = me.x - canvas.width  / 2;
  camY = me.y - canvas.height / 2;
  // Clamp camera to map bounds
  camX = Math.max(0, Math.min(camX, MAP_W - canvas.width));
  camY = Math.max(0, Math.min(camY, MAP_H - canvas.height));
}

// ─── Drawing ──────────────────────────────────────────────────────────────────

function drawFrame() {
  const W = canvas.width;
  const H = canvas.height;

  // 1. Clear with dark-but-visible background
  ctx.fillStyle = '#12101e';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(-camX, -camY); // Apply camera transform

  // 2. Draw grid (subtle atmosphere)
  drawGrid();

  // 3. Draw portal
  if (PORTAL_DEF) drawPortal(PORTAL_DEF);

  // 4. Draw chests
  for (const chest of latestState.chests) drawChest(chest);

  // 5. Draw ground loot piles
  for (const pile of latestState.lootPiles) drawLootPile(pile);

  // 6. Draw projectiles
  for (const proj of latestState.projectiles) drawProjectile(proj);

  // 7. Draw players (other players first, self on top)
  const myPlayer = latestState.players[myId];
  for (const id in latestState.players) {
    if (id !== myId) drawPlayer(latestState.players[id], false);
  }
  if (myPlayer) drawPlayer(myPlayer, true);

  // 8. Draw map boundary indicators so players can see the edges
  drawMapBorder();

  // 9. Draw fog of war on top of everything else (softer)
  if (myPlayer) drawFog(myPlayer);

  ctx.restore();
}

/** Draw a subtle dark grid to give depth to the map. */
function drawGrid() {
  const TILE = 40;
  const startX = Math.floor(camX / TILE) * TILE;
  const startY = Math.floor(camY / TILE) * TILE;
  const endX = camX + canvas.width  + TILE;
  const endY = camY + canvas.height + TILE;

  ctx.strokeStyle = 'rgba(60, 50, 90, 0.6)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let x = startX; x < endX; x += TILE) {
    ctx.moveTo(x, camY);
    ctx.lineTo(x, camY + canvas.height);
  }
  for (let y = startY; y < endY; y += TILE) {
    ctx.moveTo(camX, y);
    ctx.lineTo(camX + canvas.width, y);
  }
  ctx.stroke();
}

/** Draw the extraction portal as a glowing blue square. */
function drawPortal(portal) {
  const t = Date.now() / 1000;
  const pulse = 0.5 + 0.5 * Math.sin(t * 3);

  ctx.save();

  // Outer glow
  const glowRadius = portal.size * 1.2;
  const grad = ctx.createRadialGradient(
    portal.x + portal.size / 2, portal.y + portal.size / 2, 0,
    portal.x + portal.size / 2, portal.y + portal.size / 2, glowRadius
  );
  grad.addColorStop(0, `rgba(40, 120, 255, ${0.35 + pulse * 0.25})`);
  grad.addColorStop(1, 'rgba(0, 0, 80, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(
    portal.x + portal.size / 2,
    portal.y + portal.size / 2,
    glowRadius, 0, Math.PI * 2
  );
  ctx.fill();

  // Portal square
  ctx.fillStyle = `rgba(20, 80, 200, ${0.7 + pulse * 0.2})`;
  ctx.strokeStyle = `rgba(100, 180, 255, ${0.8 + pulse * 0.2})`;
  ctx.lineWidth = 2;
  ctx.fillRect(portal.x, portal.y, portal.size, portal.size);
  ctx.strokeRect(portal.x, portal.y, portal.size, portal.size);

  // Label
  ctx.fillStyle = `rgba(160, 220, 255, ${0.7 + pulse * 0.3})`;
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('PORTAL', portal.x + portal.size / 2, portal.y - 6);

  ctx.restore();
}

/** Draw a treasure chest. */
function drawChest(chest) {
  if (chest.looted) {
    // Looted chests are shown as dim outlines
    ctx.strokeStyle = '#2a1a0a';
    ctx.lineWidth = 1;
    ctx.strokeRect(chest.x, chest.y, chest.size, chest.size);
    return;
  }

  const t = Date.now() / 1000;
  const pulse = 0.5 + 0.5 * Math.sin(t * 2 + chest.x);

  ctx.save();
  // Glow
  ctx.shadowColor = `rgba(200, 150, 30, ${0.4 + pulse * 0.3})`;
  ctx.shadowBlur = 10;

  ctx.fillStyle = '#3a2010';
  ctx.fillRect(chest.x, chest.y, chest.size, chest.size);
  ctx.strokeStyle = `rgba(200, 150, 30, ${0.7 + pulse * 0.3})`;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(chest.x, chest.y, chest.size, chest.size);

  // Lock detail
  ctx.fillStyle = `rgba(220, 180, 40, ${0.8 + pulse * 0.2})`;
  ctx.beginPath();
  ctx.arc(chest.x + chest.size / 2, chest.y + chest.size / 2, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/** Draw a ground loot pile (dropped by a dead player). */
function drawLootPile(pile) {
  const t = Date.now() / 1000;
  const pulse = 0.5 + 0.5 * Math.sin(t * 4 + pile.x);

  ctx.save();
  ctx.shadowColor = `rgba(180, 50, 220, ${0.5 + pulse * 0.3})`;
  ctx.shadowBlur = 12;
  ctx.fillStyle = `rgba(160, 40, 200, ${0.7 + pulse * 0.2})`;
  ctx.beginPath();
  ctx.arc(pile.x, pile.y, 14, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(220, 180, 255, 0.9)';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(pile.itemCount, pile.x, pile.y);

  ctx.restore();
}

/** Draw a projectile (magic missile). */
function drawProjectile(proj) {
  const t = Date.now() / 1000;
  ctx.save();
  ctx.shadowColor = 'rgba(255, 80, 60, 0.9)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#ff5040';
  ctx.beginPath();
  ctx.arc(proj.x, proj.y, proj.radius, 0, Math.PI * 2);
  ctx.fill();

  // Bright core
  ctx.fillStyle = '#fff0e8';
  ctx.beginPath();
  ctx.arc(proj.x, proj.y, proj.radius * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Draw a player circle with HP bar and name label. */
function drawPlayer(player, isMe) {
  const rp = renderPos[player.id];
  const rx = rp ? rp.x : player.x;
  const ry = rp ? rp.y : player.y;
  const r  = player.radius;

  ctx.save();

  // Body
  ctx.shadowColor = isMe ? 'rgba(80, 200, 120, 0.7)' : 'rgba(220, 40, 40, 0.5)';
  ctx.shadowBlur = 14;

  const bodyColor = isMe ? '#2a9a5a' : '#8a1a1a';
  const rimColor  = isMe ? '#50e0a0' : '#e03030';

  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.arc(rx, ry, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = rimColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Aim direction indicator
  ctx.strokeStyle = isMe ? '#80ffc0' : '#ff8080';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(rx, ry);
  ctx.lineTo(
    rx + Math.cos(player.aimAngle) * (r + 8),
    ry + Math.sin(player.aimAngle) * (r + 8)
  );
  ctx.stroke();

  ctx.shadowBlur = 0;

  // ── HP bar above player ────────────────────────────────────────────────────
  const barW = r * 2.2;
  const barH = 4;
  const barX = rx - barW / 2;
  const barY = ry - r - 10;
  const hpFrac = Math.max(0, player.hp / player.maxHp);

  ctx.fillStyle = '#1a0a0a';
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = hpFrac > 0.5 ? '#20a050' : hpFrac > 0.25 ? '#c08020' : '#c02020';
  ctx.fillRect(barX, barY, barW * hpFrac, barH);

  // ── Player name ────────────────────────────────────────────────────────────
  ctx.fillStyle = isMe ? '#90f0b0' : '#c0a0a0';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(player.name, rx, barY - 2);

  ctx.restore();
}

/**
 * Draw fog of war using a radial gradient clipped to the whole canvas.
 * Much softer than before: the edges fade gently and player upgrades expand vision.
 */
function drawFog(player) {
  const W = canvas.width;
  const H = canvas.height;

  // Vision radius includes item-based vision bonuses
  const effectiveVision = VISION_R + (player.bonusVision || 0);

  // Screen-space position of the local player
  const sx = player.x - camX;
  const sy = player.y - camY;

  // Soft outer vignette — gentle darkening beyond the vision radius
  const grad = ctx.createRadialGradient(sx, sy, effectiveVision * 0.7, sx, sy, effectiveVision * 1.4);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.55)');

  ctx.fillStyle = grad;
  ctx.fillRect(camX, camY, W, H);
}

/** Draw a visible border around the map edges so players know where the boundary is. */
function drawMapBorder() {
  ctx.strokeStyle = '#4a2a6a';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, MAP_W, MAP_H);

  // Corner markers
  const markerSize = 30;
  ctx.strokeStyle = 'rgba(140, 60, 200, 0.6)';
  ctx.lineWidth = 2;
  const corners = [
    [0, 0], [MAP_W, 0], [0, MAP_H], [MAP_W, MAP_H],
  ];
  for (const [cx, cy] of corners) {
    ctx.beginPath();
    ctx.arc(cx, cy, markerSize, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Minimal loading/connecting screen. */
function drawLoading() {
  ctx.fillStyle = '#12101e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#4a3a6a';
  ctx.font = '18px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Entering the Shadow Realm…', canvas.width / 2, canvas.height / 2);
}

// ─── HUD Updates ──────────────────────────────────────────────────────────────

function updateHUD() {
  if (!latestState || !myId || !latestState.players[myId]) return;
  const me = latestState.players[myId];

  // HP bar
  const hpFrac = Math.max(0, me.hp / me.maxHp);
  hpBar.style.width = `${hpFrac * 100}%`;
  hpText.textContent = `${Math.max(0, me.hp)} / ${me.maxHp}`;

  // Inventory list with item emojis and descriptions
  inventoryList.innerHTML = '';
  if (me.inventory.length === 0) {
    inventoryList.innerHTML = '<li class="empty-slot">— empty —</li>';
  } else {
    for (const item of me.inventory) {
      const li = document.createElement('li');
      const def = ITEM_DEFS[item];
      const emoji = def ? def.emoji : '•';
      const desc = def && def.description ? ` — ${def.description}` : '';
      li.innerHTML = `<span class="item-icon">${emoji}</span> ${item}<span class="item-desc">${desc}</span>`;
      inventoryList.appendChild(li);
    }
  }

  // Stats line (show upgrade bonuses)
  updateStatsHUD(me);

  // Extraction progress bar
  if (me.extractionProgress > 0) {
    extractionHud.classList.remove('hidden');
    const frac = Math.min(1, me.extractionProgress / EXTRACT_TIME);
    extractionBar.style.width = `${frac * 100}%`;
  } else {
    extractionHud.classList.add('hidden');
    extractionBar.style.width = '0%';
  }

  // Leaderboard
  updateLeaderboard(latestState.leaderboard || []);
}

/** Show player upgrade stats beneath the HP bar. */
function updateStatsHUD(me) {
  let statsEl = document.getElementById('hud-stats');
  if (!statsEl) {
    statsEl = document.createElement('div');
    statsEl.id = 'hud-stats';
    document.getElementById('game-screen').appendChild(statsEl);
  }
  const dmg = ITEM_DEFS ? (me.bonusDamage || 0) : 0;
  const spd = me.bonusSpeed || 0;
  const vis = me.bonusVision || 0;
  statsEl.innerHTML =
    `<span class="stat-item">🗡️ DMG +${dmg}</span>` +
    `<span class="stat-item">⚡ SPD +${spd}</span>` +
    `<span class="stat-item">👁️ VIS +${vis}</span>` +
    `<span class="stat-item">💀 Kills ${me.kills || 0}</span>`;
}

/** Update the leaderboard HUD panel. */
function updateLeaderboard(leaderboard) {
  let lbEl = document.getElementById('hud-leaderboard');
  if (!lbEl) {
    lbEl = document.createElement('div');
    lbEl.id = 'hud-leaderboard';
    document.getElementById('game-screen').appendChild(lbEl);
  }

  let html = '<span class="hud-label">Leaderboard</span><ol id="leaderboard-list">';
  if (leaderboard.length === 0) {
    html += '<li class="lb-empty">No players</li>';
  } else {
    for (const entry of leaderboard) {
      const isMe = latestState && latestState.players[myId] &&
                   latestState.players[myId].name === entry.name;
      const meClass = isMe ? ' lb-me' : '';
      html += `<li class="lb-entry${meClass}">` +
        `<span class="lb-name">${entry.name}</span>` +
        `<span class="lb-kills">💀 ${entry.kills}</span>` +
        `<span class="lb-items">📦 ${entry.items}</span>` +
        `</li>`;
    }
  }
  html += '</ol>';
  lbEl.innerHTML = html;
}

// ─── Visual Feedback Helpers ──────────────────────────────────────────────────

/** Flash a translucent colour over the viewport (e.g., red for damage). */
function flashScreen(color) {
  const flashDiv = document.createElement('div');
  flashDiv.style.cssText = `
    position: fixed; inset: 0; pointer-events: none; z-index: 999;
    background: ${color};
    animation: fadeFlash 0.4s ease-out forwards;
  `;
  document.head.insertAdjacentHTML('beforeend', `
    <style>
      @keyframes fadeFlash {
        from { opacity: 1; }
        to   { opacity: 0; }
      }
    </style>
  `);
  document.body.appendChild(flashDiv);
  setTimeout(() => flashDiv.remove(), 450);
}

/** Show a small on-screen pickup notification. */
let pickupTimeout = null;
function showPickupNotice(item, source) {
  let notice = document.getElementById('pickup-notice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'pickup-notice';
    notice.style.cssText = `
      position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
      background: rgba(5, 3, 15, 0.88);
      border: 1px solid #4a2a6a;
      border-radius: 4px;
      padding: 8px 20px;
      color: #c0a8f0;
      font-size: 0.85rem;
      letter-spacing: 1px;
      pointer-events: none;
      z-index: 200;
      transition: opacity 0.3s;
    `;
    document.body.appendChild(notice);
  }
  const sourceLabel = source === 'ground' ? '(ground loot)' : '(chest)';
  notice.textContent = `✦ Picked up: ${item} ${sourceLabel}`;
  notice.style.opacity = '1';

  clearTimeout(pickupTimeout);
  pickupTimeout = setTimeout(() => {
    notice.style.opacity = '0';
  }, 2500);
}

/** Show the death / extraction end overlay. */
function showOverlay(title, message) {
  overlayTitle.textContent  = title;
  overlayMessage.textContent = message;
  overlay.classList.remove('hidden');
}
