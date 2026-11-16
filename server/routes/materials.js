const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireBoss, injectShop } = require('../middleware/auth');

router.use(injectShop);

// List all materials for shop
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM materials WHERE shop_id=$1 ORDER BY name',
    [req.shopId]
  );
  res.json(rows);
});

// Create material (boss/admin only)
router.post('/', requireBoss, async (req, res) => {
  const { name, quantity, unit, low_threshold } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const { rows } = await pool.query(
    `INSERT INTO materials (shop_id, name, quantity, unit, low_threshold)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.shopId, name.trim(), quantity || 0, unit || 'units', low_threshold || 10]
  );
  await addLog(req.shopId, `Material added: ${name} x${quantity || 0}`);
  res.json(rows[0]);
});

// Update material (boss/admin only)
router.patch('/:id', requireBoss, async (req, res) => {
  const { name, quantity, unit, low_threshold } = req.body;
  const fields = [], vals = [];
  let i = 1;
  const add = (col, val) => { fields.push(`${col}=$${i++}`); vals.push(val); };
  if (name !== undefined) add('name', name);
  if (quantity !== undefined) add('quantity', quantity);
  if (unit !== undefined) add('unit', unit);
  if (low_threshold !== undefined) add('low_threshold', low_threshold);
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id, req.shopId);
  const { rows } = await pool.query(
    `UPDATE materials SET ${fields.join(',')} WHERE id=$${i++} AND shop_id=$${i++} RETURNING *`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const updated = rows[0];
  if (quantity !== undefined) await syncStockFromMaterial(req.shopId, updated.name, updated.quantity);
  res.json(updated);
});

// Adjust quantity (any authenticated user)
router.post('/:id/adjust', async (req, res) => {
  const { mode, qty, note } = req.body;
  if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
  const delta = mode === 'remove' ? -Math.abs(qty) : Math.abs(qty);
  const { rows } = await pool.query(
    `UPDATE materials SET quantity = GREATEST(0, quantity + $1)
     WHERE id=$2 AND shop_id=$3 RETURNING *`,
    [delta, req.params.id, req.shopId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const item = rows[0];
  const u = req.session.user;
  const who = u?.name || u?.role || 'Unknown';
  const action = mode === 'remove' ? `used ${qty}` : `restocked ${qty}`;
  await addLog(req.shopId, `Material: ${item.name} — ${action} ${item.unit || 'units'} by ${who}${note ? ' · ' + note : ''} (now ${item.quantity})`);
  await syncStockFromMaterial(req.shopId, item.name, item.quantity);
  // Track contribution when restocking
  if (mode === 'add' && u) {
    const mechId = u.mechId || null;
    const avatar = u.avatar || null;
    await pool.query(
      `INSERT INTO material_contributions (shop_id, mechanic_id, mech_name, mech_avatar, material_id, material_name, qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.shopId, mechId, who, avatar, item.id, item.name, qty]
    );
  }
  res.json(item);
});

// Get material contributions summary (boss/admin/dev only)
router.get('/contributions', async (req, res) => {
  const u = req.session.user;
  if (!u || (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev')) return res.status(403).json({ error: 'Not allowed' });
  const { rows } = await pool.query(
    `SELECT mech_name, mech_avatar, material_name, SUM(qty)::int as total_qty, COUNT(*)::int as contributions, MAX(contributed_at) as last_at
     FROM material_contributions WHERE shop_id=$1
     GROUP BY mech_name, mech_avatar, material_name
     ORDER BY mech_name, material_name`,
    [req.shopId]
  );
  res.json(rows);
});

// Delete material (boss/admin only)
router.delete('/:id', requireBoss, async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM materials WHERE id=$1 AND shop_id=$2 RETURNING id',
    [req.params.id, req.shopId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Sync matching stock_item quantity when material quantity changes
async function syncStockFromMaterial(shopId, materialName, newQty) {
  try {
    await pool.query(
      `UPDATE stock_items SET quantity=$1 WHERE shop_id=$2 AND LOWER(name)=LOWER($3)`,
      [newQty, shopId, materialName]
    );
  } catch(e) { /* non-fatal */ }
}

async function addLog(shopId, msg) {
  await pool.query('INSERT INTO activity_log (shop_id, message) VALUES ($1,$2)', [shopId, msg]);
}

module.exports = router;
