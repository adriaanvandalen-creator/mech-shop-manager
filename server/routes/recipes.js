const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, injectShop } = require('../middleware/auth');

router.use(requireAuth, injectShop);

// GET /api/recipes — all ingredients + meta for shop
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cr.id, cr.stock_item_id, cr.material_id, cr.qty_needed,
             COALESCE(cm.craft_time_mins, 0) AS craft_time_mins,
             COALESCE(cm.craft_level, 1)     AS craft_level,
             si.name  AS stock_name,
             si.image AS stock_image,
             si.price AS stock_price,
             m.name   AS material_name,
             m.unit   AS material_unit,
             m.quantity AS material_stock
      FROM craft_recipes cr
      JOIN stock_items si ON si.id = cr.stock_item_id
      JOIN materials   m  ON m.id  = cr.material_id
      LEFT JOIN craft_meta cm ON cm.stock_item_id = cr.stock_item_id AND cm.shop_id = cr.shop_id
      WHERE cr.shop_id = $1
      ORDER BY si.name, m.name
    `, [req.shopId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/recipes — add an ingredient row
router.post('/', async (req, res) => {
  const { stock_item_id, material_id, qty_needed } = req.body;
  if (!stock_item_id || !material_id || !qty_needed) {
    return res.status(400).json({ error: 'stock_item_id, material_id and qty_needed required' });
  }
  try {
    const { rows } = await pool.query(`
      INSERT INTO craft_recipes (shop_id, stock_item_id, material_id, qty_needed)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (stock_item_id, material_id) DO UPDATE SET qty_needed=$4
      RETURNING *
    `, [req.shopId, stock_item_id, material_id, qty_needed]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/recipes/meta — upsert craft_time + level for a stock item
router.put('/meta', async (req, res) => {
  const { stock_item_id, craft_time_mins, craft_level } = req.body;
  if (!stock_item_id) return res.status(400).json({ error: 'stock_item_id required' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO craft_meta (shop_id, stock_item_id, craft_time_mins, craft_level)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (shop_id, stock_item_id) DO UPDATE
        SET craft_time_mins=$3, craft_level=$4
      RETURNING *
    `, [req.shopId, stock_item_id, craft_time_mins||0, craft_level||1]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/recipes/:id — update ingredient qty
router.patch('/:id', async (req, res) => {
  const { qty_needed } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE craft_recipes SET qty_needed=COALESCE($1,qty_needed) WHERE id=$2 AND shop_id=$3 RETURNING *`,
      [qty_needed, req.params.id, req.shopId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/recipes/item/:stockItemId — remove entire recipe (must be before /:id)
router.delete('/item/:stockItemId', async (req, res) => {
  try {
    await pool.query('DELETE FROM craft_recipes WHERE stock_item_id=$1 AND shop_id=$2', [req.params.stockItemId, req.shopId]);
    await pool.query('DELETE FROM craft_meta WHERE stock_item_id=$1 AND shop_id=$2', [req.params.stockItemId, req.shopId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/recipes/:id — remove one ingredient row
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM craft_recipes WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
