const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { injectShop } = require('../middleware/auth');
// Sync stock_item quantity to match a named material
async function syncStockByName(shopId, name, qty) {
  try {
    await pool.query(`UPDATE stock_items SET quantity=$1 WHERE shop_id=$2 AND LOWER(name)=LOWER($3)`, [qty, shopId, name]);
  } catch(e) {}
}

router.use(injectShop);

// GET — craft history (boss sees all, mechanic sees own)
router.get('/', async (req, res) => {
  try {
    let query, params;
    if (req.userRole === 'mechanic') {
      query = `SELECT * FROM craft_log WHERE shop_id=$1 AND mechanic_id=$2 ORDER BY crafted_at DESC LIMIT 100`;
      params = [req.shopId, req.mechId];
    } else {
      query = `SELECT * FROM craft_log WHERE shop_id=$1 ORDER BY crafted_at DESC LIMIT 200`;
      params = [req.shopId];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /execute — mechanic-safe craft: deduct materials, add stock, log
router.post('/execute', async (req, res) => {
  try {
    const { stock_item_id, item_name, qty, unit_value, ingredients } = req.body;
    // ingredients: [{ material_id, qty_needed, material_stock }]
    if (!stock_item_id || !qty || !ingredients?.length) return res.status(400).json({ error: 'Missing fields' });

    const craftQty = parseInt(qty);
    const uv = parseFloat(unit_value) || 0;
    const total_value = uv * craftQty;
    const u = req.session.user;

    // 1. Deduct each material
    for (const ing of ingredients) {
      const needed = ing.qty_needed * craftQty;
      const newQty = (parseFloat(ing.material_stock) || 0) - needed;
      await pool.query('UPDATE materials SET quantity=$1 WHERE id=$2 AND shop_id=$3', [newQty, ing.material_id, req.shopId]);
    }

    // 2. Add crafted qty to stock OR material, depending on craft_output flag
    const { rows: siRows } = await pool.query('SELECT craft_output, name FROM stock_items WHERE id=$1 AND shop_id=$2', [stock_item_id, req.shopId]);
    const craftOutput = siRows[0]?.craft_output || 'stock';
    if (craftOutput === 'material') {
      // Find matching material by name (case-insensitive) and add qty there
      const itemNameLower = (siRows[0]?.name || '').toLowerCase();
      const { rows: matRows } = await pool.query('SELECT id FROM materials WHERE shop_id=$1 AND LOWER(name)=$2', [req.shopId, itemNameLower]);
      if (matRows.length) {
        const { rows: matUpdated } = await pool.query('UPDATE materials SET quantity = quantity + $1 WHERE id=$2 AND shop_id=$3 RETURNING quantity, name', [craftQty, matRows[0].id, req.shopId]);
        // Sync back to stock_items
        if (matUpdated.length) await syncStockByName(req.shopId, matUpdated[0].name, matUpdated[0].quantity);
      } else {
        // No matching material found — fallback to stock
        await pool.query('UPDATE stock_items SET quantity = quantity + $1 WHERE id=$2 AND shop_id=$3', [craftQty, stock_item_id, req.shopId]);
      }
    } else {
      await pool.query('UPDATE stock_items SET quantity = quantity + $1 WHERE id=$2 AND shop_id=$3', [craftQty, stock_item_id, req.shopId]);
    }

    // 3. Log it
    const { rows } = await pool.query(
      `INSERT INTO craft_log (shop_id, mechanic_id, mech_name, mech_avatar, stock_item_id, item_name, qty, unit_value, total_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.shopId, u.mechId || null, u.name, u.avatar || '🔧',
       stock_item_id, item_name, craftQty, uv, total_value]
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST — log a craft run
router.post('/', async (req, res) => {
  try {
    const { stock_item_id, item_name, qty, unit_value } = req.body;
    const total_value = (parseFloat(unit_value) || 0) * (parseInt(qty) || 0);
    const u = req.session.user;
    const { rows } = await pool.query(
      `INSERT INTO craft_log (shop_id, mechanic_id, mech_name, mech_avatar, stock_item_id, item_name, qty, unit_value, total_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.shopId, u.mechId || null, u.name, u.avatar || '🔧',
       stock_item_id || null, item_name, parseInt(qty), parseFloat(unit_value)||0, total_value]
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
