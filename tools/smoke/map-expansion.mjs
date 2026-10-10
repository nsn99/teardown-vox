#!/usr/bin/env node
/** Browser acceptance: legacy archive/load, export/import, live water, Rapier bridge and map UI. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const out = resolve('shots/map-expansion'); mkdirSync(out, { recursive: true });
const url = process.env.MAP_SMOKE_URL ?? 'http://127.0.0.1:4322/';
const server = process.env.MAP_SMOKE_URL ? null : spawn(process.execPath, ['tools/serve-build.mjs', '4322'], { stdio: 'ignore' });
const report = { checks: [], errors: [], screenshots: [] };
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* server starts asynchronously */ }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) throw new Error('Сервер игры не запустился');
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  page.setDefaultTimeout(60_000);
  page.on('pageerror', e => report.errors.push(e.message));
  const check = (name, data) => { report.checks.push({ name, data }); console.log(name, JSON.stringify(data)); };
  const shot = async name => { await page.screenshot({ path: resolve(out, `${name}.png`) }); report.screenshots.push(`${name}.png`); };
  await page.goto(url);
  await page.locator('#btn-sandbox').click();
  await page.waitForFunction(() => window.tvox?.heist?.sim.physics.rigidBodyDynamics === true);
  assert.equal(await page.evaluate(() => window.tvox.heist.level.id), 'port-expanded');
  check('expanded default and Rapier ready', true);
  await page.keyboard.press('b');
  await page.locator('.world-map').waitFor({ state: 'visible' });
  const time = await page.evaluate(() => window.tvox.heist.sim.world.time);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.tvox.heist.sim.world.time), time);
  await shot('01-map'); check('map pauses simulation', true);
  await page.locator('.world-map [data-close]').click();

  // Existing recording entry point constructs the exact legacy level and freezes frames.
  await page.evaluate(() => window.tvox.captureStart(false));
  await page.waitForFunction(() => document.querySelector('#session-select').value.includes('slot:port:'));
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => document.querySelector('#btn-export-session').click());
  const download = await downloadPromise;
  const legacyFile = resolve(out, 'legacy-session.tvox-session.json'); await download.saveAs(legacyFile);
  const rawLegacy = readFileSync(legacyFile, 'utf8');
  assert.equal(JSON.parse(rawLegacy).save.levelId, 'port');
  // Simulate the pre-upgrade database in this isolated test browser.
  await page.evaluate(async raw => {
    const data = JSON.parse(raw, (_key, v) => {
      if (v?.$tvox === 'u32') return new Uint32Array(v.values);
      if (v?.$tvox === 'map') return new Map(v.values);
      if (v?.$tvox === 'set') return new Set(v.values);
      if (v?.$tvox === 'infinity') return Infinity;
      if (v?.$tvox === '-infinity') return -Infinity;
      return v;
    });
    delete data.save.mapRevision; delete data.save.hydro;
    await new Promise((resolve, reject) => {
      const req = window.indexedDB.open('tvox-session', 1);
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction('checkpoints', 'readwrite'), store = tx.objectStore('checkpoints');
        store.clear(); store.put(data.save, 'latest');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      }; req.onerror = () => reject(req.error);
    });
  }, rawLegacy);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#session-select').options.length === 2);
  await page.locator('#session-select').selectOption('slot:port:legacy-yard:sandbox');
  await page.locator('#btn-load-session').click();
  await page.waitForFunction(() => window.tvox?.heist?.level.id === 'port');
  assert.equal(await page.evaluate(() => [...window.tvox.heist.sim.world.bodies.values()].some(b => b.shapes.some(s => s.name === 'pier'))), true);
  check('old single-slot session archives and loads on the old port', true);
  await page.keyboard.press('Escape');
  await page.locator('#btn-sandbox').click();
  await page.waitForFunction(() => window.tvox?.heist?.level.id === 'port-expanded' && window.tvox.heist.sim.physics.rigidBodyDynamics === true);
  await page.keyboard.press('Escape');
  const flood = await page.evaluate(() => {
    const h = window.tvox.heist, core = [...h.sim.world.bodies.values()].flatMap(b => b.shapes).find(s => s.name === 'hydro-generator');
    core.fill({}, 0); h.update(0); h.hydro.update(98); h.update(.1);
    const fragments = [...h.sim.world.bodies.values()].filter(b => b.shapes.some(s => s.name.startsWith('hydro-service-bridge:frag')));
    const before = fragments.map(b => b.transform.position.y);
    for (let i = 0; i < 60; i++) h.sim.step(1 / 60);
    return { phase: h.hydro.phase, powered: h.hydro.powered, level: h.hydro.level, boatY: h.vehicles.get('boat').position.y,
      cranePowered: h.cranes.get('port-crane').powered, fragments: fragments.length,
      fell: fragments.some((b, i) => b.transform.position.y < before[i] - .1),
      roadWater: h.hydro.surfaceAt({ x: 179, y: 2.4, z: -30 }) };
  });
  assert.equal(flood.phase, 'stable'); assert.equal(flood.powered, false); assert.equal(flood.cranePowered, false);
  assert.ok(Math.abs(flood.boatY - 1.4) < 1e-6); assert.ok(flood.fragments > 0); assert.equal(flood.fell, true); assert.equal(flood.roadWater, null);
  check('live flood and physical bridge collapse', flood);
  await page.evaluate(() => {
    document.querySelector('#menu').hidden = true; document.querySelector('#hud').hidden = true;
    const r = window.tvox.renderer; r.setDaylight('day'); r.setGridPower(false); r.sync(window.tvox.heist.sim.world);
    r.setCamera({ x: -91, y: 36, z: 70 }, -1.09, -.57); r.render();
  });
  await shot('02-hydro-after');
  await page.evaluate(() => {
    const r = window.tvox.renderer; r.setCamera({ x: 40, y: 9, z: -176 }, 0, .02); r.render();
  });
  await shot('03-tunnel');
  await page.evaluate(() => {
    const r = window.tvox.renderer; r.setCamera({ x: 86, y: 14, z: -175 }, -2.6, -.45); r.render();
  });
  await shot('04-far-pier');
  await page.evaluate(() => { document.querySelector('#menu').hidden = false; document.querySelector('#btn-save-session').click(); });
  await page.waitForFunction(() => document.querySelector('#session-status').textContent.startsWith('Сохранено'));
  const exportPromise = page.waitForEvent('download');
  await page.evaluate(() => document.querySelector('#btn-export-session').click());
  const expandedDownload = await exportPromise, expandedFile = resolve(out, 'expanded-session.tvox-session.json');
  await expandedDownload.saveAs(expandedFile);
  const exported = JSON.parse(readFileSync(expandedFile, 'utf8'));
  assert.equal(exported.save.hydro.phase, 'stable'); assert.equal(exported.save.hydro.bridgeCollapsed, true);
  await page.locator('#session-import').setInputFiles(expandedFile);
  await page.waitForFunction(() => document.querySelector('#session-status').textContent.includes('Файл проверен'));
  await page.locator('#btn-load-session').click();
  await page.waitForFunction(() => window.tvox.heist.hydro?.phase === 'stable');
  const archives = await page.evaluate(() => new Promise((resolve, reject) => {
    const req = window.indexedDB.open('tvox-session', 1); req.onsuccess = () => {
      const db = req.result, tx = db.transaction('checkpoints'), store = tx.objectStore('checkpoints');
      const keys = store.getAllKeys(), old = store.get('latest');
      tx.oncomplete = () => { resolve({ keys: keys.result, legacyId: old.result.levelId }); db.close(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  assert.equal(archives.legacyId, 'port'); assert.ok(archives.keys.includes('archive:previous-latest'));
  check('flood export/import and legacy preservation', archives);
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = error.stack; throw error;
} finally {
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); server?.kill('SIGTERM');
}
