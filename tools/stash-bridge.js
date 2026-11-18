#!/usr/bin/env node
/**
 * stash-bridge.js — reads your in-game ox_inventory stashes (managed by
 * unexis_stashes) straight from MySQL and pushes the item counts up to the
 * Mech Shop Manager app, so the app's stock mirrors the game live.
 *
 * Runs on the GAME-SERVER PC (where MySQL lives). The app can be anywhere
 * (localhost or your Vercel URL) — this script only needs HTTPS out.
 *
 * SETUP (one time, on the game PC):
 *   1. Install Node 18+ (it ships a built-in fetch).
 *   2. In this folder:  npm init -y && npm install mysql2
 *   3. Edit the CONFIG block below (MySQL, app URL, token, stash map).
 *   4. On the app, set the env var  STASH_SYNC_TOKEN  to the SAME token.
 *
 * USAGE:
 *   node stash-bridge.js --list     → list every stash + its items (find your names)
 *   node stash-bridge.js            → sync once, or every intervalSeconds if > 0
 */

const mysql = require('mysql2/promise');

// ─────────────────────────────────────────────────────────────────────────
const CONFIG = {
  mysql: {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',                 // set if your DB has a password
    database: 'qbox_886bef',      // your database name
  },

  // Where the Mech Shop Manager app is reachable
  appUrl: 'https://mech-manager.vercel.app',   // or 'http://localhost:3000' for local
  // Must match the STASH_SYNC_TOKEN env var set on the app
  syncToken: 'CHANGE_ME_to_a_long_random_string',

  // 0 = sync once and exit; otherwise re-sync on this interval (seconds)
  intervalSeconds: 60,

  // Map each ox_inventory stash name  →  your app shop id.
  // Run `node stash-bridge.js --list` first to see the real stash names.
  // Several stashes can point at the same shop (their counts are summed).
  stashMap: {
    // 'Angels_parts_bin_1': 3,
    // 'LSC_main_stash_1': 1,
  },
};
// ─────────────────────────────────────────────────────────────────────────

// Parse an ox_inventory `data` blob (JSON array of slots) → { itemName: totalCount }
function aggregateItems(dataBlob) {
  let slots;
  try { slots = typeof dataBlob === 'string' ? JSON.parse(dataBlob) : dataBlob; } catch { return {}; }
  const out = {};
  const add = (name, count) => {
    if (!name) return;
    const n = String(name).toLowerCase();
    out[n] = (out[n] || 0) + (parseInt(count) || 0);
  };
  if (Array.isArray(slots)) {
    for (const s of slots) { if (s && s.name != null) add(s.name, s.count != null ? s.count : s.amount); }
  } else if (slots && typeof slots === 'object') {
    for (const k of Object.keys(slots)) { const s = slots[k]; if (s && s.name != null) add(s.name, s.count != null ? s.count : s.amount); }
  }
  return out;
}

async function getConn() {
  return mysql.createConnection(CONFIG.mysql);
}

async function listStashes() {
  const conn = await getConn();
  try {
    // Stash definitions (friendly labels) from unexis
    let defs = [];
    try { const [rows] = await conn.query('SELECT * FROM unexstashes'); defs = rows; } catch (e) { /* table may be named differently */ }
    if (defs.length) {
      console.log('\n=== unexstashes (stash definitions) ===');
      defs.forEach(d => console.log(`  id=${d.id}  name/label="${d.name ?? d.labels ?? ''}"  loc/data=${JSON.stringify(d.loc ?? d.locations ?? d.data ?? '')}`.slice(0, 160)));
    }
    // Actual stash contents live in ox_inventory
    const [inv] = await conn.query('SELECT name, data FROM ox_inventory ORDER BY name');
    console.log(`\n=== ox_inventory stashes (${inv.length}) — use these NAMEs in stashMap ===`);
    for (const row of inv) {
      const items = aggregateItems(row.data);
      const summary = Object.entries(items).map(([n, c]) => `${n}×${c}`).join(', ') || '(empty)';
      console.log(`\n  NAME: ${row.name}\n    ${summary}`);
    }
    console.log('');
  } finally { await conn.end(); }
}

async function syncOnce() {
  const stashNames = Object.keys(CONFIG.stashMap);
  if (!stashNames.length) { console.log('stashMap is empty — run with --list, then fill in CONFIG.stashMap.'); return; }

  const conn = await getConn();
  let byShop = {};
  try {
    const [rows] = await conn.query(
      `SELECT name, data FROM ox_inventory WHERE name IN (${stashNames.map(() => '?').join(',')})`,
      stashNames
    );
    for (const row of rows) {
      const shopId = CONFIG.stashMap[row.name];
      if (!shopId) continue;
      byShop[shopId] = byShop[shopId] || {};
      const items = aggregateItems(row.data);
      for (const [n, c] of Object.entries(items)) byShop[shopId][n] = (byShop[shopId][n] || 0) + c;
    }
  } finally { await conn.end(); }

  for (const [shopId, items] of Object.entries(byShop)) {
    try {
      const res = await fetch(`${CONFIG.appUrl}/api/sync/stock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-token': CONFIG.syncToken },
        body: JSON.stringify({ shopId: parseInt(shopId), items }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) console.log(`[${new Date().toLocaleTimeString()}] shop ${shopId}: updated ${j.updated}, created ${j.created} (${Object.keys(items).length} items)`);
      else console.error(`[sync] shop ${shopId} failed: ${res.status} ${j.error || ''}`);
    } catch (e) { console.error(`[sync] shop ${shopId} error: ${e.message}`); }
  }
}

(async () => {
  if (process.argv.includes('--list')) { await listStashes(); return; }
  await syncOnce();
  if (CONFIG.intervalSeconds > 0) {
    console.log(`Syncing every ${CONFIG.intervalSeconds}s — Ctrl+C to stop.`);
    setInterval(() => syncOnce().catch(e => console.error(e.message)), CONFIG.intervalSeconds * 1000);
  }
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
