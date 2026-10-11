/**
 * Engine unit tests — strict TDD, written slice-by-slice before implementation.
 * Run: node --test tests/engine.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAngle,
  collidesCircles,
  collidesCircleRect,
  GameEngine,
  WEAPONS,
  MAX_HEALTH,
  MAX_PLAYERS,
  MAX_BULLETS,
  PLAYER_RADIUS,
  BULLET_RADIUS,
  SPAWN_PROTECTION_MS,
  RESPAWN_DELAY_MS,
  TICK_MS,
  WORLD_W,
  WORLD_H,
  DEFAULT_SPAWNS,
} from '../engine.js';

// ─── Slice 1: Angle normalization ────────────────────────────────────────────

describe('normalizeAngle', () => {
  test('wraps large positive angle into [0, 2π)', () => {
    const r = normalizeAngle(Math.PI * 7);  // 7π → π
    assert.ok(r >= 0 && r < Math.PI * 2, `got ${r}`);
    assert.ok(Math.abs(r - Math.PI) < 1e-9, `expected π, got ${r}`);
  });

  test('wraps negative angle into [0, 2π)', () => {
    const r = normalizeAngle(-Math.PI / 2);  // -π/2 → 3π/2
    assert.ok(r >= 0 && r < Math.PI * 2, `got ${r}`);
    assert.ok(Math.abs(r - Math.PI * 1.5) < 1e-9, `expected 3π/2, got ${r}`);
  });

  test('handles very large finite input without unbounded loop', () => {
    const r = normalizeAngle(1e15);
    assert.ok(Number.isFinite(r), 'result must be finite');
    assert.ok(r >= 0 && r < Math.PI * 2, `out of range: ${r}`);
  });

  test('identity: angle already in [0,2π) is unchanged', () => {
    const a = 1.234;
    assert.ok(Math.abs(normalizeAngle(a) - a) < 1e-12);
  });
});

// ─── Slice 2: Circle–circle collision ─────────────────────────────────────────

describe('collidesCircles', () => {
  test('returns true when circles overlap', () => {
    assert.equal(collidesCircles(0, 0, 10, 5, 0, 10), true);
  });

  test('returns false when circles are separate', () => {
    assert.equal(collidesCircles(0, 0, 10, 25, 0, 10), false);
  });

  test('returns false when circles touch exactly (open boundary)', () => {
    // distance = 20, sumR = 20 → NOT strictly less → false
    assert.equal(collidesCircles(0, 0, 10, 20, 0, 10), false);
  });
});

// ─── Slice 3: Circle–AABB collision ───────────────────────────────────────────

describe('collidesCircleRect', () => {
  test('returns true when circle center is inside rect', () => {
    assert.equal(collidesCircleRect(50, 50, 5, 0, 0, 100, 100), true);
  });

  test('returns true when circle overlaps rect edge', () => {
    // circle center at x=5, rect starts at x=10: overlap by 9px with radius 14
    assert.equal(collidesCircleRect(5, 50, 14, 10, 10, 100, 100), true);
  });

  test('returns false when circle is clearly outside', () => {
    assert.equal(collidesCircleRect(200, 200, 10, 0, 0, 100, 100), false);
  });

  test('returns false when circle barely misses corner', () => {
    // Corner at (0,0), circle at (-8, -8) radius 10: distance = ~11.3 > 10
    assert.equal(collidesCircleRect(-8, -8, 10, 0, 0, 100, 100), false);
  });
});

// ─── Slice 4: Player creation ─────────────────────────────────────────────────

describe('GameEngine.addPlayer', () => {
  test('creates player with full health at spawn point', () => {
    const eng = new GameEngine([], [{ x: 200, y: 300 }]);
    eng.addPlayer('p1', 'Alice', '#ff0');
    const { players } = eng.getState();
    assert.equal(players.length, 1);
    const p = players[0];
    assert.equal(p.id, 'p1');
    assert.equal(p.name, 'Alice');
    assert.equal(p.health, MAX_HEALTH);
    assert.equal(p.alive, true);
    assert.equal(p.kills, 0);
    assert.equal(p.deaths, 0);
    assert.equal(p.weapon, 0);
    assert.equal(p.x, 200);
    assert.equal(p.y, 300);
  });

  test('rejects more than MAX_PLAYERS', () => {
    const eng = new GameEngine([], [{ x: 100, y: 100 }]);
    for (let i = 0; i < 8; i++) eng.addPlayer(`p${i}`, `P${i}`, '#f00');
    const ok = eng.addPlayer('p8', 'Extra', '#f00');
    assert.equal(ok, false);
    assert.equal(eng.getState().players.length, 8);
  });

  test('removePlayer deletes player', () => {
    const eng = new GameEngine([], [{ x: 100, y: 100 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    eng.removePlayer('p1');
    assert.equal(eng.getState().players.length, 0);
  });
});

// ─── Slice 5: Player movement ─────────────────────────────────────────────────

describe('player movement', () => {
  test('W key moves player in negative-Y direction', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    const before = eng.players.get('p1').y;
    eng.setInput('p1', { keys: { w: true }, angle: 0, shooting: false, weapon: 0 });
    eng.tick(50);
    assert.ok(eng.players.get('p1').y < before, 'y should decrease when pressing W');
  });

  test('S key moves player in positive-Y direction', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    const before = eng.players.get('p1').y;
    eng.setInput('p1', { keys: { s: true }, angle: 0, shooting: false, weapon: 0 });
    eng.tick(50);
    assert.ok(eng.players.get('p1').y > before);
  });

  test('player is clamped to left world boundary', () => {
    const eng = new GameEngine([], [{ x: PLAYER_RADIUS + 1, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    for (let i = 0; i < 200; i++) {
      eng.setInput('p1', { keys: { a: true }, angle: 0, shooting: false, weapon: 0 });
      eng.tick(50);
    }
    assert.ok(eng.players.get('p1').x >= PLAYER_RADIUS, 'must not go past left wall');
  });

  test('player is clamped to right world boundary', () => {
    const eng = new GameEngine([], [{ x: WORLD_W - PLAYER_RADIUS - 1, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    for (let i = 0; i < 200; i++) {
      eng.setInput('p1', { keys: { d: true }, angle: 0, shooting: false, weapon: 0 });
      eng.tick(50);
    }
    assert.ok(eng.players.get('p1').x <= WORLD_W - PLAYER_RADIUS, 'must not go past right wall');
  });

  test('dead player ignores movement input', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    const p = eng.players.get('p1');
    p.alive = false;
    const before = { x: p.x, y: p.y };
    eng.setInput('p1', { keys: { w: true, d: true }, angle: 0, shooting: false, weapon: 0 });
    eng.tick(50);
    const after = eng.players.get('p1');
    assert.equal(after.x, before.x);
    assert.equal(after.y, before.y);
  });
});

// ─── Slice 6: Obstacle collision ─────────────────────────────────────────────

describe('obstacle collision', () => {
  test('player cannot move through a wall obstacle', () => {
    // Wall from x=300 to x=400, full height
    const wall = { x: 300, y: 0, w: 100, h: WORLD_H };
    const eng = new GameEngine([wall], [{ x: 200, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    for (let i = 0; i < 100; i++) {
      eng.setInput('p1', { keys: { d: true }, angle: 0, shooting: false, weapon: 0 });
      eng.tick(50);
    }
    // Player should be stopped at or before x = wall.x - PLAYER_RADIUS
    assert.ok(eng.players.get('p1').x <= wall.x - PLAYER_RADIUS + 1,
      `x=${eng.players.get('p1').x} should be ≤ ${wall.x - PLAYER_RADIUS}`);
  });
});

// ─── Slice 7: Bullet firing + cooldown ───────────────────────────────────────

describe('shooting and cooldown', () => {
  test('shooting creates a bullet', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    eng.players.get('p1').protectedUntil = 0; // disable spawn protection for test
    eng.setInput('p1', { keys: {}, angle: 0, shooting: true, weapon: 0 });
    eng.tick(50);
    assert.equal(eng.bullets.length, 1);
    assert.equal(eng.bullets[0].ownerId, 'p1');
    assert.equal(eng.bullets[0].weapon, 0);
  });

  test('shotgun creates 5 bullets', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    eng.players.get('p1').protectedUntil = 0;
    eng.setInput('p1', { keys: {}, angle: 0, shooting: true, weapon: 2 });
    eng.tick(50);
    assert.equal(eng.bullets.length, WEAPONS[2].count);
  });

  test('pistol cooldown prevents second shot in next tick', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    eng.players.get('p1').protectedUntil = 0;
    // First shot
    eng.setInput('p1', { keys: {}, angle: 0, shooting: true, weapon: 0 });
    eng.tick(50);
    const countAfterFirst = eng.bullets.length;
    assert.ok(countAfterFirst >= 1, 'first shot fired');
    // Second tick — pistol cooldown (500ms) not expired after only 50ms
    eng.setInput('p1', { keys: {}, angle: 0, shooting: true, weapon: 0 });
    eng.tick(50);
    // No new bullet (bullets may still be there or have moved, but not added)
    const countAfterSecond = eng.bullets.length;
    assert.equal(countAfterSecond, countAfterFirst, 'no new bullet during cooldown');
  });

  test('cooldown expires and allows another shot', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    eng.players.get('p1').protectedUntil = 0;
    eng.setInput('p1', { keys: {}, angle: 0, shooting: true, weapon: 0 });
    eng.tick(50);
    const after1 = eng.bullets.length;
    // Advance time past pistol cooldown (500ms)
    for (let i = 0; i < 10; i++) {
      eng.setInput('p1', { keys: {}, angle: 0, shooting: false, weapon: 0 });
      eng.tick(50);
    }
    eng.setInput('p1', { keys: {}, angle: 0, shooting: true, weapon: 0 });
    eng.tick(50);
    const after2 = eng.bullets.length;
    assert.ok(after2 >= 1, 'second shot fired after cooldown');
  });
});

// ─── Slice 8: Damage + death + kill attribution ───────────────────────────────

describe('bullet damage and kills', () => {
  function setupTwo(obs = []) {
    const eng = new GameEngine(obs, [{ x: 200, y: 500 }, { x: 800, y: 500 }]);
    eng.addPlayer('shooter', 'Alice', '#f00');
    eng.addPlayer('target', 'Bob', '#0f0');
    // Remove spawn protection from both
    eng.players.get('shooter').protectedUntil = 0;
    eng.players.get('target').protectedUntil = 0;
    return eng;
  }

  test('bullet at target position deals damage', () => {
    const eng = setupTwo();
    const target = eng.players.get('target');
    // Place a pistol bullet directly on the target
    eng.bullets.push({
      id: 0, x: target.x, y: target.y,
      vx: 0, vy: 0,
      ownerId: 'shooter', weapon: 0, lifetime: 5,
    });
    eng.tick(50);
    assert.ok(eng.players.get('target').health < MAX_HEALTH, 'target took damage');
  });

  test('bullet deals weapon-specific damage', () => {
    const eng = setupTwo();
    const target = eng.players.get('target');
    // Place a rifle bullet (index 1) at target
    eng.bullets.push({
      id: 0, x: target.x, y: target.y,
      vx: 0, vy: 0,
      ownerId: 'shooter', weapon: 1, lifetime: 5,
    });
    eng.tick(50);
    assert.equal(eng.players.get('target').health, MAX_HEALTH - WEAPONS[1].damage);
  });

  test('player dies when health reaches 0', () => {
    const eng = setupTwo();
    const target = eng.players.get('target');
    target.health = WEAPONS[0].damage; // exactly one pistol shot left
    eng.bullets.push({
      id: 0, x: target.x, y: target.y,
      vx: 0, vy: 0,
      ownerId: 'shooter', weapon: 0, lifetime: 5,
    });
    eng.tick(50);
    const t = eng.players.get('target');
    assert.equal(t.alive, false);
    assert.equal(t.health, 0);
    assert.equal(t.deaths, 1);
  });

  test('killer receives a kill on lethal shot', () => {
    const eng = setupTwo();
    const target = eng.players.get('target');
    target.health = 1;
    eng.bullets.push({
      id: 0, x: target.x, y: target.y,
      vx: 0, vy: 0,
      ownerId: 'shooter', weapon: 0, lifetime: 5,
    });
    eng.tick(50);
    assert.equal(eng.players.get('shooter').kills, 1);
  });

  test('shooter does not damage own bullets', () => {
    const eng = setupTwo();
    const shooter = eng.players.get('shooter');
    // Put bullet on the shooter itself — should be ignored
    eng.bullets.push({
      id: 0, x: shooter.x, y: shooter.y,
      vx: 0, vy: 0,
      ownerId: 'shooter', weapon: 0, lifetime: 5,
    });
    eng.tick(50);
    assert.equal(eng.players.get('shooter').health, MAX_HEALTH, 'self-hit ignored');
  });

  test('bullet removed after hitting player', () => {
    const eng = setupTwo();
    const target = eng.players.get('target');
    eng.bullets.push({
      id: 0, x: target.x, y: target.y,
      vx: 0, vy: 0,
      ownerId: 'shooter', weapon: 0, lifetime: 10,
    });
    eng.tick(50);
    assert.equal(eng.bullets.length, 0, 'bullet consumed on hit');
  });
});

// ─── Slice 9: Respawn ─────────────────────────────────────────────────────────

describe('respawn', () => {
  test('dead player respawns after RESPAWN_DELAY_MS with full health', () => {
    const eng = new GameEngine([], [{ x: 400, y: 400 }, { x: 1000, y: 800 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    const p = eng.players.get('p1');
    p.protectedUntil = 0;
    p.health = 1;
    p.alive = false;
    p.respawnAt = eng.time + RESPAWN_DELAY_MS;
    const deathPos = { x: p.x, y: p.y };

    // Tick past respawn time
    const ticks = Math.ceil((RESPAWN_DELAY_MS + 100) / TICK_MS);
    for (let i = 0; i < ticks; i++) eng.tick(TICK_MS);

    const after = eng.players.get('p1');
    assert.equal(after.alive, true);
    assert.equal(after.health, MAX_HEALTH);
  });

  test('dead player does not respawn before RESPAWN_DELAY_MS', () => {
    const eng = new GameEngine([], [{ x: 400, y: 400 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    const p = eng.players.get('p1');
    p.alive = false;
    p.respawnAt = eng.time + RESPAWN_DELAY_MS;

    // Tick less than delay
    const ticks = Math.ceil((RESPAWN_DELAY_MS - 200) / TICK_MS);
    for (let i = 0; i < ticks; i++) eng.tick(TICK_MS);

    assert.equal(eng.players.get('p1').alive, false, 'should not have respawned yet');
  });
});

// ─── Slice 10: Spawn protection ───────────────────────────────────────────────

describe('spawn protection', () => {
  test('protected player takes no damage', () => {
    const eng = new GameEngine([], [{ x: 200, y: 500 }, { x: 800, y: 500 }]);
    eng.addPlayer('shooter', 'Alice', '#f00');
    eng.addPlayer('target', 'Bob', '#0f0');
    eng.players.get('shooter').protectedUntil = 0;
    // target still has spawn protection (time=0, protectedUntil = SPAWN_PROTECTION_MS > 0)
    const target = eng.players.get('target');
    eng.bullets.push({
      id: 0, x: target.x, y: target.y,
      vx: 0, vy: 0,
      ownerId: 'shooter', weapon: 0, lifetime: 5,
    });
    eng.tick(50);
    assert.equal(eng.players.get('target').health, MAX_HEALTH, 'protected player takes no damage');
  });

  test('protection expires after SPAWN_PROTECTION_MS', () => {
    const eng = new GameEngine([], [{ x: 200, y: 500 }, { x: 800, y: 500 }]);
    eng.addPlayer('shooter', 'Alice', '#f00');
    eng.addPlayer('target', 'Bob', '#0f0');
    eng.players.get('shooter').protectedUntil = 0;
    // Advance time past spawn protection
    const ticks = Math.ceil((SPAWN_PROTECTION_MS + 100) / TICK_MS);
    for (let i = 0; i < ticks; i++) eng.tick(TICK_MS);
    const target = eng.players.get('target');
    eng.bullets.push({
      id: 99, x: target.x, y: target.y,
      vx: 0, vy: 0,
      ownerId: 'shooter', weapon: 0, lifetime: 5,
    });
    eng.tick(50);
    assert.ok(eng.players.get('target').health < MAX_HEALTH, 'protection expired — target takes damage');
  });
});

// ─── Slice 11: Malicious / invalid inputs ─────────────────────────────────────

describe('malicious input rejection', () => {
  test('NaN angle is rejected', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    const before = eng.players.get('p1').angle;
    eng.setInput('p1', { keys: {}, angle: NaN, shooting: false, weapon: 0 });
    eng.tick(50);
    assert.equal(eng.players.get('p1').angle, before, 'NaN angle must not update player angle');
  });

  test('Infinite angle is rejected', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    const before = eng.players.get('p1').angle;
    eng.setInput('p1', { keys: {}, angle: Infinity, shooting: false, weapon: 0 });
    eng.tick(50);
    assert.equal(eng.players.get('p1').angle, before);
  });

  test('invalid weapon index is rejected', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    eng.setInput('p1', { keys: {}, angle: 0, shooting: false, weapon: 99 });
    eng.tick(50);
    assert.equal(eng.players.get('p1').weapon, 0, 'invalid weapon rejected, stays at 0');
  });

  test('very large finite angle is normalized not looping', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    eng.setInput('p1', { keys: {}, angle: 1e15, shooting: false, weapon: 0 });
    eng.tick(50);
    const angle = eng.players.get('p1').angle;
    assert.ok(Number.isFinite(angle), 'angle must be finite');
    assert.ok(angle >= 0 && angle < Math.PI * 2, 'angle must be in [0, 2π)');
  });

  test('null input does not crash', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    assert.doesNotThrow(() => {
      eng.setInput('p1', null);
      eng.tick(50);
    });
  });

  test('input for unknown player is silently ignored', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    assert.doesNotThrow(() => {
      eng.setInput('ghost', { keys: { w: true }, angle: 0, shooting: true, weapon: 0 });
      eng.tick(50);
    });
    assert.equal(eng.bullets.length, 0);
  });

  test('bullet with out-of-bounds coords is removed', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    eng.bullets.push({ id: 1, x: -100, y: 500, vx: -10, vy: 0, ownerId: 'p1', weapon: 0, lifetime: 10 });
    eng.tick(50);
    assert.equal(eng.bullets.length, 0, 'OOB bullet removed');
  });
});

// ─── Slice 12: Bullet cap (MAX_BULLETS) ──────────────────────────────────────

describe('MAX_BULLETS hard cap', () => {
  test('engine does not exceed MAX_BULLETS when already at cap', () => {
    const eng = new GameEngine([], [{ x: 500, y: 500 }]);
    eng.addPlayer('p1', 'Alice', '#f00');
    const p = eng.players.get('p1');
    p.protectedUntil = 0;
    // Fill to cap with long-lived bullets that won't expire this tick
    for (let i = 0; i < MAX_BULLETS; i++) {
      eng.bullets.push({ id: i, x: 500, y: 500, vx: 0, vy: 0, ownerId: 'p1', weapon: 0, lifetime: 9999 });
    }
    // Fire shotgun (5 pellets) — none should be added beyond cap
    eng.setInput('p1', { keys: {}, angle: 0, shooting: true, weapon: 2 });
    eng.tick(50);
    assert.ok(eng.bullets.length <= MAX_BULLETS,
      `bullet count ${eng.bullets.length} exceeds MAX_BULLETS ${MAX_BULLETS}`);
  });

  test('max-population + MAX_BULLETS state JSON fits within 262144-char guest receive limit', () => {
    const eng = new GameEngine([], DEFAULT_SPAWNS);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      eng.addPlayer(`player_${i}`, 'A'.repeat(32), '#aabbcc');
    }
    for (let i = 0; i < MAX_BULLETS; i++) {
      eng.bullets.push({ id: i, x: 1000, y: 750, vx: 5, vy: 5, ownerId: 'player_0', weapon: 2, lifetime: 30 });
    }
    const json = JSON.stringify({ t: 'state', state: eng.getState() });
    assert.ok(json.length <= 262144,
      `state JSON length ${json.length} exceeds 262144-char guest receive limit`);
  });
});
