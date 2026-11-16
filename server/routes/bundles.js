const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireBoss, injectShop } = require('../middleware/auth');

router.use(requireBoss, injectShop);

// GET /api/bundles?name=Full Stage 3 — get bundle contents for a price name
// GET /api/bundles — get all bundles grouped by price_name
router.get('/', async (req, res) => {
  try {
    const { name } = req.query;
    if (name) {
      const { rows } = await pool.query(
        `SELECT b.*, s.name AS stock_name, s.quantity AS stock_qty
         FROM bundles b
         JOIN stock_items s ON s.id = b.stock_item_id
         WHERE b.shop_id=$1 AND b.price_name=$2
         ORDER BY s.name`,
        [req.shopId, name]
      );
      return res.json(rows);
    }
    // All bundles grouped
    const { rows } = await pool.query(
      `SELECT b.*, s.name AS stock_name, s.quantity AS stock_qty
       FROM bundles b
       JOIN stock_items s ON s.id = b.stock_item_id
       WHERE b.shop_id=$1
       ORDER BY b.price_name, s.name`,
      [req.shopId]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bundles — add a stock item to a bundle
router.post('/', async (req, res) => {
  const { price_name, stock_item_id, qty } = req.body;
  if (!price_name || !stock_item_id) return res.status(400).json({ error: 'price_name and stock_item_id required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO bundles (shop_id, price_name, stock_item_id, qty)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (shop_id, price_name, stock_item_id) DO UPDATE SET qty=EXCLUDED.qty
       RETURNING *`,
      [req.shopId, price_name, stock_item_id, qty || 1]
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/bundles/:id — update qty
router.patch('/:id', async (req, res) => {
  const { qty } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE bundles SET qty=$1 WHERE id=$2 AND shop_id=$3 RETURNING *`,
      [qty, req.params.id, req.shopId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/bundles/:id — remove a stock item from a bundle
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bundles WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
