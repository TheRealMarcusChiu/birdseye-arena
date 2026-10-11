/**
 * Birdseye Arena — end-to-end tests
 *
 * Uses real browser contexts (separate Chromium contexts = isolated peers).
 * Default: public PeerJS signaling (real NAT conditions). Set SIGNAL=local for
 * the local signaling server (faster, deterministic, no internet required).
 * Also honours BASE_URL for deployed-site testing.
 *
 * Run:
 *   npm run test:e2e               # public PeerJS signaling (default)
 *   SIGNAL=local npm run test:e2e  # local PeerJS signaling
 *   BASE_URL=https://... npm run test:e2e
 */
'use strict';
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const assert = require('node:assert/strict');
const { chromium } = require('./playwright.cjs');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css',
  '.json': 'application/json',
  '.txt':  'text/plain',
};

// ── Static file server ────────────────────────────────────────────────────────
function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url      = req.url.split('?')[0].replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(ROOT, url);
    if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not found: ' + url);
    }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ── Local PeerJS signaling server ─────────────────────────────────────────────
// PeerServer(options, callback) — callback receives the underlying http.Server
// once it is listening. Port 0 → OS picks a random free port.
async function startLocalSignal() {
  const { PeerServer } = require(path.join(ROOT, 'node_modules', 'peer'));
  return new Promise((resolve, reject) => {
    let resolved = false;
    const peerjs = PeerServer({ port: 0, path: '/peerjs' }, httpSrv => {
      if (resolved) return;
      resolved = true;
      peerjs.__httpSrv = httpSrv;
      peerjs.__port   = httpSrv.address().port;
      resolve(peerjs);
    });
    peerjs.on('error', err => { if (!resolved) { resolved = true; reject(err); } });
  });
}

function signalPort(srv) {
  return srv.__port;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function newPage(browser, url) {
  const ctx  = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('[BROWSER ERROR]', e.message));
  await page.goto(url);
  return page;
}

// Correct 3-arg form: fn, arg, options — ensures timeout is treated as options, not fn arg
async function waitReady(page, timeout = 25000) {
  await page.waitForFunction(() => window.__debug?.ready, undefined, { timeout });
}

async function createRoom(page, name) {
  await page.locator('#btnCreate').click();
  await page.locator('#nameInput').fill(name);
  await page.locator('#createBtn').click();
  await waitReady(page);
  return page.evaluate(() => window.__debug.code);
}

async function joinRoom(page, name, code) {
  await page.locator('#btnJoin').click();
  await page.locator('#nameInput').fill(name);
  await page.locator('#codeInput').fill(code);
  await page.locator('#joinBtn').click();
  await waitReady(page);
}

// ── Main test suite ────────────────────────────────────────────────────────────
(async () => {
  const usePublic = process.env.SIGNAL !== 'local';

  const fileServer = await startServer();
  const filePort   = fileServer.address().port;
  const BASE       = process.env.BASE_URL || `http://127.0.0.1:${filePort}`;

  let signalServer = null;
  let gameUrl;

  if (usePublic) {
    console.log('Using public PeerJS signaling (BASE =', BASE, ')');
    gameUrl = BASE;
  } else {
    signalServer = await startLocalSignal();
    const sPort = signalPort(signalServer);
    console.log('Using local PeerJS signaling on port', sPort);
    gameUrl = `${BASE}?signal=local&signalHost=127.0.0.1&signalPort=${sPort}`;
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const errors  = [];

  try {
    // ── Test 1: Host creates a 4-letter room ─────────────────────────────────
    const hostPage  = await newPage(browser, gameUrl);
    const guestPage = await newPage(browser, gameUrl);
    hostPage.on ('pageerror', e => errors.push('HOST:  ' + e.message));
    guestPage.on('pageerror', e => errors.push('GUEST: ' + e.message));

    const code = await createRoom(hostPage, 'Host');
    assert.match(code, /^[A-Z]{4}$/, 'room code must be 4 uppercase letters');
    console.log('PASS create room:', code);

    // ── Test 2: Guest joins; both see 2 players with distinct colors ──────────
    await joinRoom(guestPage, 'Guest', code);
    const guestId = await guestPage.evaluate(() => window.__debug.myId);

    await hostPage.waitForFunction(
      gid => window.__debug.players.some(p => p.id === gid),
      guestId, { timeout: 10000 }
    );
    const hostPlayers = await hostPage.evaluate(() => window.__debug.players);
    assert.equal(hostPlayers.length, 2, 'host sees 2 players');
    assert.ok(hostPlayers.every(p => !p.name.includes('<')), 'no raw HTML in names');
    const colors = new Set(hostPlayers.map(p => p.color));
    assert.equal(colors.size, 2, 'distinct player colors');
    console.log('PASS guest joined; 2 players, distinct colors');

    // ── Test 3: Guest movement (W key) reaches host ───────────────────────────
    const initialY = await hostPage.evaluate(
      gid => window.__debug.players.find(p => p.id === gid)?.y,
      guestId
    );
    await guestPage.locator('#canvas').click({ force: true });
    await guestPage.keyboard.down('w');
    try {
      await hostPage.waitForFunction(
        ({ gid, y0 }) => {
          const p = window.__debug.players.find(p => p.id === gid);
          return p && p.y < y0 - 2;
        },
        { gid: guestId, y0: initialY },
        { timeout: 8000 }
      );
      console.log('PASS guest movement (W) received by host');
    } finally {
      await guestPage.keyboard.up('w');
    }

    // ── Test 4: Guest weapon switch reaches host ──────────────────────────────
    await guestPage.keyboard.press('2'); // → rifle (weapon index 1)
    await hostPage.waitForFunction(
      gid => window.__debug.players.find(p => p.id === gid)?.weapon === 1,
      guestId, { timeout: 5000 }
    );
    console.log('PASS guest weapon switch (→ rifle) received by host');

    // ── Test 5: Host shoots — cooldown proves a shot was fired ────────────────
    const hostId = await hostPage.evaluate(() => window.__debug.myId);
    await hostPage.locator('#canvas').click({ force: true });
    await hostPage.mouse.move(400, 300);
    await hostPage.mouse.down();
    await hostPage.waitForFunction(
      hid => {
        const p = window.__debug.players.find(p => p.id === hid);
        return p && p.cooldownUntil > 0;
      },
      hostId, { timeout: 5000 }
    );
    await hostPage.mouse.up();
    console.log('PASS host shooting: cooldown confirmed');

    // ── Test 6: Guest shoots — host registers cooldown ────────────────────────
    await guestPage.keyboard.press('1'); // back to pistol
    await guestPage.locator('#canvas').click({ force: true });
    await guestPage.mouse.move(400, 300);
    await guestPage.mouse.down();
    await hostPage.waitForFunction(
      gid => {
        const p = window.__debug.players.find(p => p.id === gid);
        return p && p.cooldownUntil > 0;
      },
      guestId, { timeout: 5000 }
    );
    await guestPage.mouse.up();
    console.log('PASS guest shooting: host registers cooldown');

    // ── Test 7: Malicious messages don't crash host ───────────────────────────
    const beforeCount = await hostPage.evaluate(() => window.__debug.players.length);
    await guestPage.evaluate(() => {
      const send = window.__debug?.sendRaw;
      if (!send) return;
      send({ t: 'clear' });   // no clear handler for guests
      send({ t: 'input', keys: {}, angle: NaN,  shooting: false, weapon: 99 });
      send({ t: 'input', keys: {}, angle: 1e15, shooting: false, weapon: 0  });
    });
    await guestPage.waitForTimeout(400);
    const afterCount = await hostPage.evaluate(() => window.__debug.players.length);
    assert.equal(afterCount, beforeCount, 'malicious messages did not crash host');
    console.log('PASS malicious input rejected');

    // ── Test 8: Late joiner receives full state snapshot ─────────────────────
    const latePage = await newPage(browser, gameUrl);
    latePage.on('pageerror', e => errors.push('LATE: ' + e.message));
    await joinRoom(latePage, 'Late<img>', code);
    const lateId = await latePage.evaluate(() => window.__debug.myId);

    const latePlayers = await latePage.evaluate(() => window.__debug.players);
    assert.ok(latePlayers.length >= 2, 'late joiner receives existing-player state in welcome');
    // HTML name must not inject elements into the DOM
    const injectedImg = await latePage.evaluate(() => document.querySelector('#hudPlayers img'));
    assert.equal(injectedImg, null, 'HTML name rendered safely, no <img> injected');
    // Host confirms 3 players (waitForFunction with correct 3-arg API)
    await hostPage.waitForFunction(
      () => window.__debug.players.length >= 3,
      undefined, { timeout: 12000 }
    );
    assert.equal(
      await hostPage.evaluate(() => window.__debug.players.length),
      3, 'host sees 3 players after late join'
    );
    console.log('PASS late join snapshot; 3 players; safe name rendering');

    // ── Test 9: Room code collision retry ─────────────────────────────────────
    const collisionPage = await newPage(browser, gameUrl);
    collisionPage.on('pageerror', e => errors.push('COLL: ' + e.message));
    await collisionPage.evaluate(c => { window.__overrideNextCode = c; }, code);
    await collisionPage.locator('#btnCreate').click();
    await collisionPage.locator('#nameInput').fill('Retry');
    await collisionPage.locator('#createBtn').click();
    await waitReady(collisionPage, 30000);
    const newCode = await collisionPage.evaluate(() => window.__debug.code);
    assert.notEqual(newCode, code, 'collision retry produces a different code');
    console.log('PASS room code collision retry — new code:', newCode);
    await collisionPage.locator('#btnLeave').click();

    // ── Test 10: Guest leaves — host sees player removed ──────────────────────
    const countBeforeLeave = await hostPage.evaluate(() => window.__debug.players.length);
    await latePage.locator('#btnLeave').click();
    await hostPage.waitForFunction(
      n => window.__debug.players.length < n,
      countBeforeLeave, { timeout: 8000 }
    );
    console.log('PASS guest leave removes player from host state');

    // ── Test 11: Host ends room — guests are disconnected ─────────────────────
    await hostPage.locator('#btnLeave').click();
    await guestPage.waitForFunction(
      () => !window.__debug.ready,
      undefined, { timeout: 10000 }
    );
    console.log('PASS host ending room disconnects guests');

    // ── Test 12: Host can recreate a new room ─────────────────────────────────
    await hostPage.waitForFunction(
      () => !window.__debug.ready,
      undefined, { timeout: 8000 }
    );
    const code2 = await createRoom(hostPage, 'Host2');
    assert.match(code2, /^[A-Z]{4}$/);
    console.log('PASS host recreated room:', code2);

    // ── Test 13: Guest stays connected under sustained input rate (>5 s) ──────
    // Guest loop sends inputs every 33 ms (~30/s). This verifies the host's
    // rate limit (90/s threshold) doesn't disconnect a well-behaved guest.
    {
      const rateHostPage  = await newPage(browser, gameUrl);
      const rateGuestPage = await newPage(browser, gameUrl);
      rateHostPage .on('pageerror', e => errors.push('RATE-HOST:  ' + e.message));
      rateGuestPage.on('pageerror', e => errors.push('RATE-GUEST: ' + e.message));
      const rateCode = await createRoom(rateHostPage, 'RateHost');
      await joinRoom(rateGuestPage, 'RateGuest', rateCode);
      const rateGuestId = await rateGuestPage.evaluate(() => window.__debug.myId);

      // Hold W key for 6 seconds — guest will send ~180 input packets
      await rateGuestPage.locator('#canvas').click({ force: true });
      await rateGuestPage.keyboard.down('w');
      await rateGuestPage.waitForTimeout(6000);
      await rateGuestPage.keyboard.up('w');

      // Guest must still be connected and host must still see them
      const rateGuestReady = await rateGuestPage.evaluate(() => window.__debug.ready);
      assert.ok(rateGuestReady, 'guest stays connected after 6 s of sustained input');
      const rateHostSees = await rateHostPage.evaluate(
        gid => window.__debug.players.some(p => p.id === gid),
        rateGuestId
      );
      assert.ok(rateHostSees, 'host still sees guest after 6 s of sustained input');
      console.log('PASS sustained 6 s input rate — guest not disconnected');
      await rateHostPage.locator('#btnLeave').click();
    }

    // ── Test 14: Max-population/projectile state decoded via guest receive path ─
    // REGRESSION: guest decode limit must handle full 8-player + 512-bullet state
    // without disconnecting. Uses __testReceiveFromHost to inject the serialized
    // state directly into the guest's receive function, bypassing the network.
    {
      const stressHostPage  = await newPage(browser, gameUrl);
      const stressGuestPage = await newPage(browser, gameUrl);
      stressHostPage .on('pageerror', e => errors.push('STRESS-HOST:  ' + e.message));
      stressGuestPage.on('pageerror', e => errors.push('STRESS-GUEST: ' + e.message));
      const stressCode = await createRoom(stressHostPage, 'StressHost');
      await joinRoom(stressGuestPage, 'StressGuest', stressCode);

      const injectedLen = await stressGuestPage.evaluate(() => {
        const inject = window.__debug?.__testReceiveFromHost;
        if (!inject) return -1;
        const players = [];
        for (let i = 0; i < 8; i++) {
          players.push({
            id: `pid_${i}`, name: 'Player'.padEnd(32, 'X'), color: '#aabbcc',
            x: 1000, y: 750, angle: 0, health: 100, kills: 0, deaths: 0,
            weapon: 0, alive: true, respawnAt: null,
            protectedUntil: 0, cooldownUntil: 0,
          });
        }
        const bullets = [];
        for (let i = 0; i < 512; i++) {
          bullets.push({ id: i, x: 1000, y: 750, vx: 5, vy: 5, ownerId: 'pid_0', weapon: 2, lifetime: 30 });
        }
        const msg = JSON.stringify({ t: 'state', state: { players, bullets, events: [], time: 5000 } });
        inject(msg);
        return msg.length;
      });
      assert.ok(injectedLen > 0, '__testReceiveFromHost hook unavailable or returned unexpected value: ' + injectedLen);
      const stressGuestReady = await stressGuestPage.evaluate(() => window.__debug.ready);
      assert.ok(stressGuestReady, 'guest disconnected after max-population/projectile state injection');
      console.log(`PASS max-population/projectile state decoded by guest receive path (${injectedLen} chars)`);
      await stressHostPage.locator('#btnLeave').click();
    }

    // ── Screenshots ───────────────────────────────────────────────────────────
    await guestPage.screenshot({ path: path.join(ROOT, 'screenshots/guest_lobby.png'), fullPage: true });
    await hostPage.screenshot({  path: path.join(ROOT, 'screenshots/host_game.png'),   fullPage: true });
    console.log('Screenshots saved.');

    // ── No uncaught browser errors ────────────────────────────────────────────
    if (errors.length) console.warn('Browser errors:', errors);
    assert.deepEqual(errors, [], 'uncaught errors: ' + errors.join('; '));
    console.log('PASS no uncaught browser errors');

    console.log('\n✓ All E2E tests passed (' + (usePublic ? 'public' : 'local') + ' signaling).');

  } finally {
    await browser.close();
    fileServer.close();
    if (signalServer) try { signalServer.__httpSrv?.close(); } catch {}
  }
})().catch(e => { console.error('\nE2E FAILED:', e.message || e); process.exit(1); });
