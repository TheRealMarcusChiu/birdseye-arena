/**
 * Birdseye Arena — game engine
 * Pure simulation logic; no DOM dependencies.
 */

export const WORLD_W  = 2000;
export const WORLD_H  = 1500;
export const PLAYER_RADIUS  = 14;
export const BULLET_RADIUS  = 3;
export const MAX_HEALTH     = 100;
export const MAX_PLAYERS    = 8;
export const MAX_BULLETS    = 512;
export const TICK_MS        = 50;
export const MOVE_SPEED     = 4.5;   // world-units per tick
export const SPAWN_PROTECTION_MS = 2000;
export const RESPAWN_DELAY_MS    = 3000;
export const PREFIX = 'birdseye-arena-v1-';

export const WEAPONS = [
  // 0 — Pistol
  { name: 'Pistol',   damage: 25, cooldown: 500,  bulletSpeed: 16, spread: 0,    count: 1, lifetime: 70 },
  // 1 — Rifle
  { name: 'Rifle',    damage: 8,  cooldown: 120,  bulletSpeed: 24, spread: 0,    count: 1, lifetime: 55 },
  // 2 — Shotgun
  { name: 'Shotgun',  damage: 22, cooldown: 800,  bulletSpeed: 10, spread: 0.30, count: 5, lifetime: 32 },
];

const TWO_PI = Math.PI * 2;

// Constant-time modulo normalization — safe for huge finite inputs
export function normalizeAngle(a) {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI;
}

// Open circle–circle collision (< not <=)
export function collidesCircles(x1, y1, r1, x2, y2, r2) {
  const dx = x2 - x1, dy = y2 - y1;
  const sumR = r1 + r2;
  return dx * dx + dy * dy < sumR * sumR;
}

// Open circle–AABB collision using nearest-point-on-rect
export function collidesCircleRect(cx, cy, cr, rx, ry, rw, rh) {
  const nx = Math.max(rx, Math.min(cx, rx + rw));
  const ny = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < cr * cr;
}

// ─── Default map layout ───────────────────────────────────────────────────────

export const DEFAULT_OBSTACLES = [
  // Central cross
  { x: 820, y: 700, w: 360, h: 30 },
  { x: 980, y: 560, w: 40,  h: 310 },
  // Corner L-barriers (4 corners)
  { x:  80, y:  80, w: 220, h: 30 },
  { x:  80, y:  80, w: 30,  h: 220 },
  { x: 1700, y:  80, w: 220, h: 30 },
  { x: 1890, y:  80, w: 30,  h: 220 },
  { x:  80, y: 1390, w: 220, h: 30 },
  { x:  80, y: 1200, w: 30,  h: 220 },
  { x: 1700, y: 1390, w: 220, h: 30 },
  { x: 1890, y: 1200, w: 30,  h: 220 },
  // Side pillars
  { x: 450, y: 500, w: 30, h: 180 },
  { x: 450, y: 820, w: 30, h: 180 },
  { x: 1520, y: 500, w: 30, h: 180 },
  { x: 1520, y: 820, w: 30, h: 180 },
];

export const DEFAULT_SPAWNS = [
  { x: 150, y: 150 },
  { x: 1850, y: 150 },
  { x: 150, y: 1350 },
  { x: 1850, y: 1350 },
  { x: 1000, y: 120 },
  { x: 1000, y: 1380 },
  { x: 120,  y: 750 },
  { x: 1880, y: 750 },
];

// Pick spawn point furthest from all alive players
function pickSpawn(players, spawns) {
  if (spawns.length === 0) return { x: WORLD_W / 2, y: WORLD_H / 2 };
  let best = spawns[0], bestDist = -1;
  const alive = [...players.values()].filter(p => p.alive);
  for (const sp of spawns) {
    let minDist = Infinity;
    for (const p of alive) {
      const dx = sp.x - p.x, dy = sp.y - p.y;
      minDist = Math.min(minDist, dx * dx + dy * dy);
    }
    if (minDist > bestDist) { bestDist = minDist; best = sp; }
  }
  return best;
}

// ─── GameEngine ───────────────────────────────────────────────────────────────

export class GameEngine {
  constructor(obstacles = DEFAULT_OBSTACLES, spawnPoints = DEFAULT_SPAWNS) {
    this.obstacles   = obstacles;
    this.spawnPoints = spawnPoints;
    this.players     = new Map();   // id → player
    this.bullets     = [];          // array of bullet objects
    this._nextBulletId = 0;
    this._pendingInputs = new Map(); // id → validated input
    this.time        = 0;           // ms elapsed
    this.events      = [];          // kill/damage events for current tick
  }

  // Returns false when room is full
  addPlayer(id, name, color = '#4080ff') {
    if (this.players.size >= MAX_PLAYERS) return false;
    const spawn = pickSpawn(this.players, this.spawnPoints);
    this.players.set(id, {
      id,
      name:    String(name).trim().slice(0, 32) || 'Player',
      color,
      x: spawn.x,  y: spawn.y,
      angle: 0,
      health: MAX_HEALTH,
      kills:  0,   deaths: 0,
      weapon: 0,
      alive:  true,
      respawnAt:    null,
      protectedUntil: this.time + SPAWN_PROTECTION_MS,
      cooldownUntil:  0,
    });
    return true;
  }

  removePlayer(id) {
    this.players.delete(id);
    this._pendingInputs.delete(id);
  }

  // Validates and stores pending input; silently discards invalid inputs
  setInput(playerId, input) {
    if (!this.players.has(playerId)) return;
    if (!input || typeof input !== 'object') return;

    const angle  = input.angle;
    if (typeof angle !== 'number' || !Number.isFinite(angle)) return;

    const weapon = input.weapon;
    if (typeof weapon !== 'number' || ![0, 1, 2].includes(weapon)) return;

    const keys = input.keys;
    if (!keys || typeof keys !== 'object') return;

    this._pendingInputs.set(playerId, {
      keys: {
        w: !!keys.w,   a: !!keys.a,   s: !!keys.s,   d: !!keys.d,
        up:    !!keys.up,   down:  !!keys.down,
        left:  !!keys.left, right: !!keys.right,
      },
      angle:    normalizeAngle(angle),
      shooting: !!input.shooting,
      weapon,
    });
  }

  // Advance simulation by dtMs milliseconds
  tick(dtMs = TICK_MS) {
    this.time  += dtMs;
    this.events = [];
    this._processRespawns();
    this._processInputs(dtMs);
    this._processBullets(dtMs);
  }

  // Full state snapshot (deep-ish copy, safe to send over the wire)
  getState() {
    return {
      players:  [...this.players.values()].map(p => ({ ...p })),
      bullets:  this.bullets.map(b => ({ ...b })),
      events:   [...this.events],
      time:     this.time,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  _processRespawns() {
    for (const p of this.players.values()) {
      if (!p.alive && p.respawnAt !== null && this.time >= p.respawnAt) {
        const spawn = pickSpawn(this.players, this.spawnPoints);
        p.x = spawn.x;  p.y = spawn.y;
        p.health = MAX_HEALTH;
        p.alive  = true;
        p.respawnAt = null;
        p.protectedUntil = this.time + SPAWN_PROTECTION_MS;
        p.angle  = 0;
      }
    }
  }

  _processInputs(dtMs) {
    for (const [id, input] of this._pendingInputs) {
      const p = this.players.get(id);
      if (!p || !p.alive) continue;

      p.angle  = input.angle;
      p.weapon = input.weapon;

      // Movement — diagonal normalized to preserve total speed
      const speed = MOVE_SPEED * dtMs / TICK_MS;
      let dx = 0, dy = 0;
      const k = input.keys;
      if (k.w || k.up)    dy -= 1;
      if (k.s || k.down)  dy += 1;
      if (k.a || k.left)  dx -= 1;
      if (k.d || k.right) dx += 1;
      if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }
      dx *= speed;  dy *= speed;

      this._movePlayer(p, p.x + dx, p.y + dy);

      if (input.shooting && this.time >= p.cooldownUntil) {
        this._shoot(p);
      }
    }
    this._pendingInputs.clear();
  }

  _movePlayer(p, nx, ny) {
    const r = PLAYER_RADIUS;
    // Clamp to world bounds
    const cx = Math.max(r, Math.min(WORLD_W - r, nx));
    const cy = Math.max(r, Math.min(WORLD_H - r, ny));

    // Slide along obstacles: resolve each axis independently
    let fx = cx;
    for (const obs of this.obstacles) {
      if (collidesCircleRect(fx, p.y, r, obs.x, obs.y, obs.w, obs.h)) {
        fx = p.x; break;
      }
    }
    let fy = cy;
    for (const obs of this.obstacles) {
      if (collidesCircleRect(fx, fy, r, obs.x, obs.y, obs.w, obs.h)) {
        fy = p.y; break;
      }
    }
    p.x = fx;  p.y = fy;
  }

  _shoot(p) {
    const wep = WEAPONS[p.weapon];
    p.cooldownUntil = this.time + wep.cooldown;
    for (let i = 0; i < wep.count; i++) {
      if (this.bullets.length >= MAX_BULLETS) break;
      const spread = wep.spread > 0 ? (Math.random() - 0.5) * wep.spread : 0;
      const angle  = p.angle + spread;
      const ox = Math.cos(angle) * (PLAYER_RADIUS + BULLET_RADIUS + 2);
      const oy = Math.sin(angle) * (PLAYER_RADIUS + BULLET_RADIUS + 2);
      this.bullets.push({
        id: this._nextBulletId++,
        x: p.x + ox,  y: p.y + oy,
        vx: Math.cos(angle) * wep.bulletSpeed,
        vy: Math.sin(angle) * wep.bulletSpeed,
        ownerId: p.id,
        weapon:  p.weapon,
        lifetime: wep.lifetime,
      });
    }
  }

  _processBullets(dtMs) {
    const speedScale = dtMs / TICK_MS;
    const nextBullets = [];

    for (const b of this.bullets) {
      b.x += b.vx * speedScale;
      b.y += b.vy * speedScale;
      b.lifetime--;

      // Remove expired or out-of-bounds bullets
      if (b.lifetime <= 0) continue;
      if (b.x < 0 || b.x > WORLD_W || b.y < 0 || b.y > WORLD_H) continue;

      // Obstacle hit
      let blocked = false;
      for (const obs of this.obstacles) {
        if (collidesCircleRect(b.x, b.y, BULLET_RADIUS, obs.x, obs.y, obs.w, obs.h)) {
          blocked = true; break;
        }
      }
      if (blocked) continue;

      // Player hit
      let hit = false;
      for (const p of this.players.values()) {
        if (!p.alive || p.id === b.ownerId) continue;
        if (this.time < p.protectedUntil) continue;     // spawn protection
        if (!collidesCircles(b.x, b.y, BULLET_RADIUS, p.x, p.y, PLAYER_RADIUS)) continue;

        const wep = WEAPONS[b.weapon];
        p.health -= wep.damage;
        hit = true;

        if (p.health <= 0) {
          p.health = 0;
          p.alive  = false;
          p.deaths++;
          p.respawnAt = this.time + RESPAWN_DELAY_MS;
          const killer = this.players.get(b.ownerId);
          if (killer) killer.kills++;
          this.events.push({ kind: 'kill', killer: b.ownerId, victim: p.id });
        } else {
          this.events.push({ kind: 'damage', victim: p.id });
        }
        break;
      }
      if (!hit) nextBullets.push(b);
    }
    this.bullets = nextBullets;
  }
}
