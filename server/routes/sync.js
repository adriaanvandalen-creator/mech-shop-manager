const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Machine-to-machine stock sync from the game server (the stash-bridge / mech_bridge).
// Authenticated by a shared token, NOT a user session.
const slug = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const pretty = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// Raw crafting materials → the Materials page (not Stock).
const MATERIAL_SLUGS = new Set(['iron', 'steel', 'aluminum', 'copper', 'rubber', 'plastic', 'carbon', 'metalscrap', 'screwdriverset', 'piston']);
// Craftable parts → the Stock page. Anything not in either set is ignored (junk).
const PART_SLUGS = new Set([
  'repair_kit', 'stage1', 'stage2', 'stage3', 'turbo_lvl_1', 'turbo_lvl_2', 'turbo_lvl_3', 'twin_turbo',
  'slick_tyres', 'semi_slick_tyres', 'offroad_tyres', 'ceramic_brakes', 'awd_drivetrain', 'rwd_drivetrain',
  'fwd_drivetrain', 'drift_tuning_kit', 'tyre_replacement', 'clutch_replacement', 'suspension_parts',
  'brakepad_replacement', 'ev_motor', 'ev_battery', 'lighting_controller', 'stancing_kit', 'cosmetic_part',
  'respray_kit', 'vehicle_wheels', 'tyre_smoke_kit', 'extras_kit', 'nitrous_bottle', 'empty_nitrous_bottle',
  'nitrous_install_kit', 'piston',
]);

// POST /api/sync/stock  { shopId, items: { "<ox_item_name>": count, ... } }
// Header: x-sync-token: <STASH_SYNC_TOKEN>
router.post('/stock', async (req, res) => {
  const token = req.headers['x-sync-token'];
  if (!process.env.STASH_SYNC_TOKEN) return res.status(503).json({ error: 'Sync not enabled (set STASH_SYNC_TOKEN)' });
  if (token !== process.env.STASH_SYNC_TOKEN) return res.status(401).json({ error: 'Bad sync token' });

  const { shopId, items } = req.body || {};
  if (!shopId || !items || typeof items !== 'object') return res.status(400).json({ error: 'shopId and items{} required' });
  try {
    const { rows: shop } = await pool.query('SELECT id FROM shops WHERE id=$1', [shopId]);
    if (!shop.length) return res.status(404).json({ error: 'Shop not found' });

    const { rows: stock } = await pool.query('SELECT id, name, price FROM stock_items WHERE shop_id=$1', [shopId]);
    const { rows: mats } = await pool.query('SELECT id, name FROM materials WHERE shop_id=$1', [shopId]);
    const stockBySlug = {}; stock.forEach(s => { stockBySlug[slug(s.name)] = s.id; });
    const matBySlug = {}; mats.forEach(m => { matBySlug[slug(m.name)] = m.id; });

    let materials = 0, parts = 0, skipped = 0;
    for (const [rawName, rawCount] of Object.entries(items)) {
      const qty = Math.max(0, parseInt(rawCount) || 0);
      const key = slug(rawName);
      if (!key) { skipped++; continue; }

      if (MATERIAL_SLUGS.has(key)) {
        // raw material → Materials page
        if (matBySlug[key]) {
          await pool.query('UPDATE materials SET quantity=$1 WHERE id=$2 AND shop_id=$3', [qty, matBySlug[key], shopId]);
        } else {
          const r = await pool.query('INSERT INTO materials (shop_id, name, quantity, unit, low_threshold) VALUES ($1,$2,$3,$4,$5) RETURNING id', [shopId, pretty(rawName), qty, 'units', 50]);
          matBySlug[key] = r.rows[0].id;
        }
        materials++;
      } else if (PART_SLUGS.has(key)) {
        // crafted part → Stock page
        if (stockBySlug[key]) {
          await pool.query('UPDATE stock_items SET quantity=$1 WHERE id=$2 AND shop_id=$3', [qty, stockBySlug[key], shopId]);
        } else {
          const r = await pool.query('INSERT INTO stock_items (shop_id, name, quantity, price) VALUES ($1,$2,$3,0) RETURNING id', [shopId, pretty(rawName), qty]);
          stockBySlug[key] = r.rows[0].id;
        }
        parts++;
      } else {
        skipped++; // junk (backpack, bottle, can…) — never added
      }
    }

    // Self-heal: remove non-part stock rows left by the old sync (raw materials that
    // landed in Stock, and junk). Only price-0 rows that aren't known parts — this
    // never touches a part you've priced for sale.
    let pruned = 0;
    for (const s of stock) {
      if (!PART_SLUGS.has(slug(s.name)) && Number(s.price || 0) === 0) {
        await pool.query('DELETE FROM stock_items WHERE id=$1 AND shop_id=$2', [s.id, shopId]);
        pruned++;
      }
    }

    res.json({ ok: true, shopId, materials, parts, skipped, pruned, received: Object.keys(items).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
