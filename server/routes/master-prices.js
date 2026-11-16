const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { injectShop } = require('../middleware/auth');

// Public — all shops read master prices (no auth needed, it's a shared list)
router.get('/', injectShop, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM master_prices ORDER BY name');
  res.json(rows);
});

// GET /api/master-prices/hidden — list hidden price IDs for this shop
router.get('/hidden', injectShop, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT master_price_id FROM shop_hidden_prices WHERE shop_id=$1',
      [req.shopId]
    );
    res.json(rows.map(r => r.master_price_id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/master-prices/hidden/:id — hide a price for this shop
router.post('/hidden/:id', injectShop, async (req, res) => {
  const u = req.session?.user;
  if (!u || (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev')) return res.status(403).json({ error: 'Boss only' });
  try {
    await pool.query(
      'INSERT INTO shop_hidden_prices (shop_id, master_price_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.shopId, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/master-prices/hidden/:id — unhide a price for this shop
router.delete('/hidden/:id', injectShop, async (req, res) => {
  const u = req.session?.user;
  if (!u || (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev')) return res.status(403).json({ error: 'Boss only' });
  try {
    await pool.query(
      'DELETE FROM shop_hidden_prices WHERE shop_id=$1 AND master_price_id=$2',
      [req.shopId, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin only — add/update master price
router.post('/', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const { name, price } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'Name and price required' });
  const { rows } = await pool.query(
    `INSERT INTO master_prices (name, price) VALUES ($1,$2)
     ON CONFLICT (name) DO UPDATE SET price=EXCLUDED.price RETURNING *`,
    [name.trim(), price]
  );
  res.json(rows[0]);
});

// Admin only — update an existing master price by id (name and/or price)
router.put('/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const { name, price } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'Name and price required' });
  try {
    const { rows } = await pool.query(
      'UPDATE master_prices SET name=$1, price=$2 WHERE id=$3 RETURNING *',
      [name.trim(), price, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A price with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Admin only — delete master price
router.delete('/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  await pool.query('DELETE FROM master_prices WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Admin only — bulk seed/replace master list
router.post('/bulk', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const { items } = req.body; // [{ name, price }]
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
  for (const item of items) {
    if (!item.name || item.price == null) continue;
    await pool.query(
      `INSERT INTO master_prices (name, price) VALUES ($1,$2)
       ON CONFLICT (name) DO UPDATE SET price=EXCLUDED.price`,
      [item.name.trim(), item.price]
    );
  }
  res.json({ ok: true, count: items.length });
});

module.exports = router;
