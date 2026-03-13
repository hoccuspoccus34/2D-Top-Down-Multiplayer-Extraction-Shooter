/**
 * server.js — Authoritative Game Server
 * 2D Top-Down Multiplayer Extraction Shooter MVP
 *
 * Responsibilities:
 *  - Serve static files via Express
 *  - Manage game state (players, chests, loot piles, projectiles, portal)
 *  - Run a fixed-rate game loop (60 tick/s)
 *  - Handle collision detection, combat, looting and extraction server-side
 *  - Broadcast authoritative state to all connected clients via Socket.io
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// ─── Express & Socket.io Setup ────────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

// Serve all files in /public as static assets
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`[Server] Listening on http://localhost:${PORT}`);
});

// ─── Map & World Constants ────────────────────────────────────────────────────
const MAP_WIDTH = 2000;   // pixels
const MAP_HEIGHT = 2000;  // pixels
const TILE_SIZE = 40;     // visual grid tile size

// ─── Player Constants ─────────────────────────────────────────────────────────
const PLAYER_RADIUS = 16;
const PLAYER_SPEED = 180;        // pixels per second
const PLAYER_MAX_HP = 100;
const VISION_RADIUS = 600;       // fog-of-war radius in pixels

// ─── Projectile Constants ─────────────────────────────────────────────────────
const PROJECTILE_SPEED = 420;    // pixels per second
const PROJECTILE_RADIUS = 5;
const PROJECTILE_DAMAGE = 20;
const PROJECTILE_LIFETIME = 2.2; // seconds before auto-removal

// ─── Portal Constants ─────────────────────────────────────────────────────────
const PORTAL_SIZE = 60;          // square side length
const EXTRACTION_TIME = 3;       // seconds standing on portal to extract

// ─── Item Pool ────────────────────────────────────────────────────────────────
const ITEM_DEFS = {
  'Gold Coin':         { emoji: '🪙', stat: null,     value: 0,   description: 'Shiny but useless… or is it?' },
  'Shadow Blade':      { emoji: '🗡️', stat: 'damage', value: 5,   description: '+5 Damage' },
  'Crimson Shard':     { emoji: '💎', stat: 'maxHp',  value: 15,  description: '+15 Max HP' },
  'Cursed Tome':       { emoji: '📖', stat: 'vision', value: 60,  description: '+60 Vision' },
  'Iron Key':          { emoji: '🔑', stat: null,     value: 0,   description: 'Opens something…' },
  'Elixir of Shadows': { emoji: '🧪', stat: 'speed',  value: 20,  description: '+20 Speed' },
  'Bone Relic':        { emoji: '🦴', stat: 'maxHp',  value: 10,  description: '+10 Max HP' },
  'Void Crystal':      { emoji: '🔮', stat: 'damage', value: 8,   description: '+8 Damage' },
};
const ITEM_POOL = Object.keys(ITEM_DEFS);

// ─── Chest Configuration ──────────────────────────────────────────────────────
const CHEST_COUNT = 12;
const CHEST_SIZE = 24;
const LOOT_RADIUS = 14;          // radius of dropped loot pile

// ─── Game State ───────────────────────────────────────────────────────────────
/**
 * players  : { [socketId]: PlayerObject }
 * projectiles : [ ProjectileObject, ... ]
 * chests   : [ ChestObject, ... ]
 * lootPiles: [ LootPileObject, ... ]
 * portal   : PortalObject
 */
const gameState = {
  players: {},
  projectiles: [],
  chests: [],
  lootPiles: [],
  portal: null,
};

// ─── World Initialisation ─────────────────────────────────────────────────────

/** Generate a random integer between min (inclusive) and max (exclusive). */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

/** Pick a random element from an array. */
function randItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Initialise chests at random positions, keeping them away from map edges. */
function initChests() {
  gameState.chests = [];
  for (let i = 0; i < CHEST_COUNT; i++) {
    gameState.chests.push({
      id: `chest_${i}`,
      x: randInt(100, MAP_WIDTH - 100),
      y: randInt(100, MAP_HEIGHT - 100),
      size: CHEST_SIZE,
      item: randItem(ITEM_POOL),
      looted: false,
    });
  }
}

/** Place the extraction portal near the centre of the map. */
function initPortal() {
  gameState.portal = {
    x: MAP_WIDTH / 2 - PORTAL_SIZE / 2,
    y: MAP_HEIGHT / 2 - PORTAL_SIZE / 2,
    size: PORTAL_SIZE,
  };
}

initChests();
initPortal();

// ─── Collision Helpers ────────────────────────────────────────────────────────

/** AABB vs circle overlap test. */
function circleRect(cx, cy, cr, rx, ry, rw, rh) {
  const nearX = Math.max(rx, Math.min(cx, rx + rw));
  const nearY = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nearX;
  const dy = cy - nearY;
  return dx * dx + dy * dy < cr * cr;
}

/** Circle vs circle overlap. */
function circleCircle(ax, ay, ar, bx, by, br) {
  const dx = ax - bx;
  const dy = ay - by;
  const dist = ar + br;
  return dx * dx + dy * dy < dist * dist;
}

/** Clamp a value between lo and hi. */
function clamp(val, lo, hi) {
  return Math.max(lo, Math.min(hi, val));
}

// ─── Player Factory ───────────────────────────────────────────────────────────

/** Create a new player object at a random spawn position. */
function createPlayer(socketId, name) {
  return {
    id: socketId,
    name: name || `Shadow_${socketId.slice(0, 4)}`,
    x: randInt(PLAYER_RADIUS + 50, MAP_WIDTH - PLAYER_RADIUS - 50),
    y: randInt(PLAYER_RADIUS + 50, MAP_HEIGHT - PLAYER_RADIUS - 50),
    radius: PLAYER_RADIUS,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    inventory: [],
    kills: 0,
    // Upgrade bonuses accumulated from items
    bonusDamage: 0,
    bonusSpeed: 0,
    bonusVision: 0,
    // Extraction progress (seconds standing on portal)
    extractionProgress: 0,
    // Input state received from client
    input: {
      up: false,
      down: false,
      left: false,
      right: false,
    },
    // Aim direction (unit vector) updated each tick from client mouse position
    aimAngle: 0,
    // Used to rate-limit shooting
    shootCooldown: 0,  // seconds remaining until next shot allowed
  };
}

// ─── Socket.io Connection Handling ───────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // ── Player Join ──────────────────────────────────────────────────────────────
  socket.on('playerJoin', (data) => {
    const player = createPlayer(socket.id, data && data.name);
    gameState.players[socket.id] = player;
    console.log(`[Game] Player joined: ${player.name} (${socket.id})`);

    // Send the new player their initial state and the static world data
    socket.emit('init', {
      playerId: socket.id,
      mapWidth: MAP_WIDTH,
      mapHeight: MAP_HEIGHT,
      portal: gameState.portal,
      visionRadius: VISION_RADIUS,
      extractionTime: EXTRACTION_TIME,
      playerRadius: PLAYER_RADIUS,
      projectileRadius: PROJECTILE_RADIUS,
      itemDefs: ITEM_DEFS,
    });
  });

  // ── Input Updates ────────────────────────────────────────────────────────────
  // The client sends its latest input state every frame; the server applies it
  // on the next game-loop tick.  Keeping physics server-side prevents cheating.
  socket.on('playerInput', (input) => {
    const player = gameState.players[socket.id];
    if (!player || player.hp <= 0) return;
    player.input = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right,
    };
    player.aimAngle = typeof input.aimAngle === 'number' ? input.aimAngle : 0;
  });

  // ── Shoot ────────────────────────────────────────────────────────────────────
  socket.on('shoot', () => {
    const player = gameState.players[socket.id];
    if (!player || player.hp <= 0) return;
    if (player.shootCooldown > 0) return; // still cooling down

    player.shootCooldown = 0.25; // 4 shots per second maximum

    gameState.projectiles.push({
      id: `proj_${Date.now()}_${Math.random()}`,
      ownerId: socket.id,
      x: player.x,
      y: player.y,
      vx: Math.cos(player.aimAngle) * PROJECTILE_SPEED,
      vy: Math.sin(player.aimAngle) * PROJECTILE_SPEED,
      radius: PROJECTILE_RADIUS,
      damage: PROJECTILE_DAMAGE + player.bonusDamage,
      lifetime: PROJECTILE_LIFETIME,
    });
  });

  // ── Loot Interaction (E key) ─────────────────────────────────────────────────
  socket.on('interact', () => {
    const player = gameState.players[socket.id];
    if (!player || player.hp <= 0) return;
    tryLootNearby(player);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
    const player = gameState.players[socket.id];
    if (player) {
      dropLoot(player);
      delete gameState.players[socket.id];
    }
  });
});

// ─── Item Upgrade Helper ──────────────────────────────────────────────────────

/** Apply an item's stat boost to a player. */
function applyItemUpgrade(player, itemName) {
  const def = ITEM_DEFS[itemName];
  if (!def || !def.stat) return;
  switch (def.stat) {
    case 'damage':
      player.bonusDamage += def.value;
      break;
    case 'maxHp':
      player.maxHp += def.value;
      player.hp = Math.min(player.hp + def.value, player.maxHp);
      break;
    case 'speed':
      player.bonusSpeed += def.value;
      break;
    case 'vision':
      player.bonusVision += def.value;
      break;
  }
}

// ─── Loot Helpers ─────────────────────────────────────────────────────────────

/**
 * Attempt to loot the nearest un-looted chest within reach.
 * Also sweeps nearby loot piles (dropped by dead players).
 */
function tryLootNearby(player) {
  const REACH = PLAYER_RADIUS + CHEST_SIZE + 10;

  // Check chests
  for (const chest of gameState.chests) {
    if (chest.looted) continue;
    if (circleRect(player.x, player.y, REACH, chest.x, chest.y, chest.size, chest.size)) {
      chest.looted = true;
      player.inventory.push(chest.item);
      applyItemUpgrade(player, chest.item);
      io.to(player.id).emit('itemPickup', { item: chest.item, source: 'chest' });
      console.log(`[Game] ${player.name} looted chest: ${chest.item}`);
      return;
    }
  }

  // Check ground loot piles
  const LOOT_REACH = PLAYER_RADIUS + LOOT_RADIUS + 10;
  for (let i = gameState.lootPiles.length - 1; i >= 0; i--) {
    const pile = gameState.lootPiles[i];
    if (circleCircle(player.x, player.y, LOOT_REACH, pile.x, pile.y, LOOT_RADIUS)) {
      const items = pile.items.splice(0); // take all items in the pile
      player.inventory.push(...items);
      for (const item of items) applyItemUpgrade(player, item);
      gameState.lootPiles.splice(i, 1);
      for (const item of items) {
        io.to(player.id).emit('itemPickup', { item, source: 'ground' });
      }
      console.log(`[Game] ${player.name} picked up ground loot: ${items.join(', ')}`);
      return;
    }
  }
}

/**
 * Drop all items in a player's inventory as a ground loot pile.
 * Called on player death or voluntary disconnect.
 */
function dropLoot(player) {
  if (player.inventory.length === 0) return;
  gameState.lootPiles.push({
    id: `loot_${Date.now()}`,
    x: player.x,
    y: player.y,
    items: [...player.inventory],
  });
  player.inventory = [];
}

// ─── Death Handler ────────────────────────────────────────────────────────────

/**
 * Kill a player: drop their loot, notify them, then disconnect their socket.
 */
function killPlayer(player, killerId) {
  if (player.hp > 0) return; // guard double-kill
  console.log(`[Game] ${player.name} was killed by ${killerId}`);
  dropLoot(player);
  io.to(player.id).emit('playerDied', { killedBy: killerId });
  // Give client a moment to show the death screen before hard-disconnect
  setTimeout(() => {
    const sock = io.sockets.sockets.get(player.id);
    if (sock) sock.disconnect(true);
  }, 3000);
}

// ─── Fixed-Rate Game Loop ─────────────────────────────────────────────────────

const TICK_RATE = 60;                  // updates per second
const TICK_INTERVAL = 1 / TICK_RATE;  // seconds per tick

let lastTime = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTime) / 1000; // seconds elapsed since last tick
  lastTime = now;

  updateGame(dt);

  // Build and broadcast the authoritative state snapshot
  const snapshot = buildSnapshot();
  io.emit('gameState', snapshot);
}, 1000 / TICK_RATE);

// ─── Game Update Logic ────────────────────────────────────────────────────────

function updateGame(dt) {
  updatePlayers(dt);
  updateProjectiles(dt);
}

/** Move all players, handle boundary clamping, looting on-walk, extraction. */
function updatePlayers(dt) {
  for (const id in gameState.players) {
    const p = gameState.players[id];
    if (p.hp <= 0) continue;

    // Decrement shoot cooldown
    if (p.shootCooldown > 0) p.shootCooldown -= dt;

    // ── Movement ──────────────────────────────────────────────────────────────
    let dx = 0;
    let dy = 0;
    if (p.input.up)    dy -= 1;
    if (p.input.down)  dy += 1;
    if (p.input.left)  dx -= 1;
    if (p.input.right) dx += 1;

    // Normalise diagonal movement
    if (dx !== 0 && dy !== 0) {
      dx *= 0.7071;
      dy *= 0.7071;
    }

    p.x += dx * (PLAYER_SPEED + p.bonusSpeed) * dt;
    p.y += dy * (PLAYER_SPEED + p.bonusSpeed) * dt;

    // Clamp to map boundaries
    p.x = clamp(p.x, p.radius, MAP_WIDTH - p.radius);
    p.y = clamp(p.y, p.radius, MAP_HEIGHT - p.radius);

    // ── Auto-loot on collision with nearby chest ───────────────────────────────
    for (const chest of gameState.chests) {
      if (chest.looted) continue;
      if (circleRect(p.x, p.y, p.radius + 2, chest.x, chest.y, chest.size, chest.size)) {
        chest.looted = true;
        p.inventory.push(chest.item);
        applyItemUpgrade(p, chest.item);
        io.to(p.id).emit('itemPickup', { item: chest.item, source: 'chest' });
        console.log(`[Game] ${p.name} auto-looted chest: ${chest.item}`);
      }
    }

    // ── Extraction Progress ───────────────────────────────────────────────────
    const portal = gameState.portal;
    const onPortal = circleRect(p.x, p.y, p.radius, portal.x, portal.y, portal.size, portal.size);
    if (onPortal) {
      p.extractionProgress += dt;
      if (p.extractionProgress >= EXTRACTION_TIME) {
        handleExtraction(p);
        // Player is removed after extraction; skip remaining processing
        continue;
      }
    } else {
      p.extractionProgress = 0; // reset if they leave the portal
    }
  }
}

/** Handle a successful extraction for a player. */
function handleExtraction(player) {
  const lootList = player.inventory.length > 0
    ? player.inventory.join(', ')
    : 'nothing';
  console.log(`[Game] ${player.name} extracted with: ${lootList}`);

  // #TODO — Connect to MongoDB/PostgreSQL here to persist extracted loot to the
  //         player's permanent "Stash".  Something like:
  //           await db.collection('stashes').updateOne(
  //             { userId: player.userId },
  //             { $push: { items: { $each: player.inventory } } }
  //           );

  io.to(player.id).emit('extracted', {
    playerName: player.name,
    items: player.inventory,
    message: `You extracted with: ${lootList}`,
  });

  // Disconnect after a short delay so the client can show the extraction screen
  setTimeout(() => {
    const sock = io.sockets.sockets.get(player.id);
    if (sock) sock.disconnect(true);
  }, 4000);

  // Remove from active game state immediately so others can't interact
  delete gameState.players[player.id];
}

/** Move projectiles, check for hits against players, remove expired ones. */
function updateProjectiles(dt) {
  for (let i = gameState.projectiles.length - 1; i >= 0; i--) {
    const proj = gameState.projectiles[i];
    proj.x += proj.vx * dt;
    proj.y += proj.vy * dt;
    proj.lifetime -= dt;

    // Remove if out of bounds or expired
    if (
      proj.lifetime <= 0 ||
      proj.x < 0 || proj.x > MAP_WIDTH ||
      proj.y < 0 || proj.y > MAP_HEIGHT
    ) {
      gameState.projectiles.splice(i, 1);
      continue;
    }

    // Check hit against each living player (excluding the shooter)
    let hit = false;
    for (const id in gameState.players) {
      if (id === proj.ownerId) continue;
      const target = gameState.players[id];
      if (target.hp <= 0) continue;

      if (circleCircle(proj.x, proj.y, proj.radius, target.x, target.y, target.radius)) {
        target.hp -= proj.damage;
        io.to(target.id).emit('damaged', { hp: target.hp, damage: proj.damage });
        gameState.projectiles.splice(i, 1);
        hit = true;

        if (target.hp <= 0) {
          target.hp = 0;
          // Track the kill for the shooter
          const shooter = gameState.players[proj.ownerId];
          if (shooter) shooter.kills += 1;
          killPlayer(target, proj.ownerId);
        }
        break; // a projectile can only hit one target
      }
    }
  }
}

// ─── State Snapshot ───────────────────────────────────────────────────────────

/**
 * Build a lean snapshot of the game state to send to clients every tick.
 * We omit internal fields (input, shootCooldown, etc.) that clients don't need.
 */
function buildSnapshot() {
  const players = {};
  const leaderboard = [];
  for (const id in gameState.players) {
    const p = gameState.players[id];
    players[id] = {
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      radius: p.radius,
      hp: p.hp,
      maxHp: p.maxHp,
      aimAngle: p.aimAngle,
      inventory: p.inventory,
      extractionProgress: p.extractionProgress,
      kills: p.kills,
      bonusDamage: p.bonusDamage,
      bonusSpeed: p.bonusSpeed,
      bonusVision: p.bonusVision,
    };
    leaderboard.push({
      name: p.name,
      kills: p.kills,
      items: p.inventory.length,
    });
  }
  // Sort leaderboard: kills descending, then items descending
  leaderboard.sort((a, b) => b.kills - a.kills || b.items - a.items);

  return {
    players,
    leaderboard,
    projectiles: gameState.projectiles.map((proj) => ({
      id: proj.id,
      x: proj.x,
      y: proj.y,
      radius: proj.radius,
      ownerId: proj.ownerId,
    })),
    chests: gameState.chests.map((c) => ({
      id: c.id,
      x: c.x,
      y: c.y,
      size: c.size,
      looted: c.looted,
    })),
    lootPiles: gameState.lootPiles.map((lp) => ({
      id: lp.id,
      x: lp.x,
      y: lp.y,
      itemCount: lp.items.length,
    })),
  };
}
