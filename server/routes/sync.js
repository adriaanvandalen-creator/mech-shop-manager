const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Machine-to-machine stock sync from the game server (the stash-bridge script).
// Authenticated by a shared token, NOT a user session.
const slug = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const pretty = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

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

    const { rows: stock } = await pool.query('SELECT id, name FROM stock_items WHERE shop_id=$1', [shopId]);
    const bySlug = {};
    stock.forEach(s => { bySlug[slug(s.name)] = s.id; });

    let updated = 0, created = 0;
    for (const [rawName, rawCount] of Object.entries(items)) {
      const qty = Math.max(0, parseInt(rawCount) || 0);
      const key = slug(rawName);
      if (!key) continue;
      if (bySlug[key]) {
        await pool.query('UPDATE stock_items SET quantity=$1 WHERE id=$2 AND shop_id=$3', [qty, bySlug[key], shopId]);
        updated++;
      } else {
        const ins = await pool.query(
          'INSERT INTO stock_items (shop_id, name, quantity, price) VALUES ($1,$2,$3,0) RETURNING id',
          [shopId, pretty(rawName), qty]
        );
        bySlug[key] = ins.rows[0].id;
        created++;
      }
    }
    res.json({ ok: true, shopId, updated, created, received: Object.keys(items).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
