const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, injectShop } = require('../middleware/auth');

router.use(injectShop);

// List all stock items for shop
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM stock_items WHERE shop_id=$1 ORDER BY name',
    [req.shopId]
  );
  res.json(rows);
});

// Create stock item (boss/admin only)
router.post('/', async (req, res) => {
  const u = req.session.user;
  if (!u || (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev')) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { name, quantity, price, image } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (image && image.length > 700000) return res.status(400).json({ error: 'Image too large' });

  const { rows } = await pool.query(
    `INSERT INTO stock_items (shop_id, name, quantity, price, image)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.shopId, name.trim(), quantity || 0, price || 0, image || null]
  );
  await addLog(req.shopId, `Stock added: ${name} x${quantity || 0}`);
  res.json(rows[0]);
});

// Update stock item (boss/admin only)
router.patch('/:id', async (req, res) => {
  const u = req.session.user;
  if (!u || (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev')) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { name, quantity, price, image } = req.body;
  const fields = [], vals = [];
  let i = 1;
  const add = (col, val) => { fields.push(`${col}=$${i++}`); vals.push(val); };
  if (name !== undefined) add('name', name);
  if (quantity !== undefined) add('quantity', quantity);
  if (price !== undefined) add('price', price);
  if (image !== undefined) add('image', image);
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id, req.shopId);
  const { rows } = await pool.query(
    `UPDATE stock_items SET ${fields.join(',')} WHERE id=$${i++} AND shop_id=$${i++} RETURNING *`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const updated = rows[0];
  if (quantity !== undefined) await syncMaterialFromStock(req.shopId, updated.name, updated.quantity);
  res.json(updated);
});

// Adjust quantity (any authenticated user)
router.post('/:id/adjust', async (req, res) => {
  const { mode, qty, note } = req.body;
  if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
  const delta = mode === 'remove' ? -Math.abs(qty) : Math.abs(qty);
  const { rows } = await pool.query(
    `UPDATE stock_items SET quantity = GREATEST(0, quantity + $1)
     WHERE id=$2 AND shop_id=$3 RETURNING *`,
    [delta, req.params.id, req.shopId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const item = rows[0];
  const u = req.session.user;
  const who = u?.name || u?.role || 'Unknown';
  const action = mode === 'remove' ? `removed ${qty}` : `added ${qty}`;
  await addLog(req.shopId, `Stock: ${item.name} — ${action} by ${who}${note ? ' · ' + note : ''} (now ${item.quantity}x)`);
  await syncMaterialFromStock(req.shopId, item.name, item.quantity);
  // Log to stock_history
  await pool.query(
    `INSERT INTO stock_history (shop_id, item_id, item_name, delta, mode, note, mechanic_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.shopId, item.id, item.name, qty, mode, note || '', who]
  );
  res.json(item);
});

// PATCH craft_output flag
router.patch('/:id/craft-output', async (req, res) => {
  const u = req.session.user;
  if (!u || (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev')) return res.status(403).json({ error: 'Not allowed' });
  const { craft_output } = req.body;
  if (!['stock', 'material'].includes(craft_output)) return res.status(400).json({ error: 'Invalid value' });
  const { rows } = await pool.query(
    'UPDATE stock_items SET craft_output=$1 WHERE id=$2 AND shop_id=$3 RETURNING *',
    [craft_output, req.params.id, req.shopId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// Delete stock item (boss/admin only)
router.delete('/:id', async (req, res) => {
  const u = req.session.user;
  if (!u || (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev')) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { rows } = await pool.query(
    'DELETE FROM stock_items WHERE id=$1 AND shop_id=$2 RETURNING id',
    [req.params.id, req.shopId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Sync matching material quantity when stock_item quantity changes
async function syncMaterialFromStock(shopId, itemName, newQty) {
  try {
    await pool.query(
      `UPDATE materials SET quantity=$1 WHERE shop_id=$2 AND LOWER(name)=LOWER($3)`,
      [newQty, shopId, itemName]
    );
  } catch(e) { /* non-fatal */ }
}

async function addLog(shopId, msg) {
  await pool.query('INSERT INTO activity_log (shop_id, message) VALUES ($1,$2)', [shopId, msg]);
}

module.exports = router;
module.exports.syncMaterialFromStock = syncMaterialFromStock;
