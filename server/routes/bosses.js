const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const bcrypt = require('bcryptjs');
const { injectShop, requireBoss } = require('../middleware/auth');

// Public list for login screen — NO auth required (must be before injectShop middleware)
router.get('/public', async (req, res) => {
  const shopId = req.query.shopId;
  if (!shopId) return res.status(400).json({ error: 'shopId required' });
  try {
    const { rows } = await pool.query(
      'SELECT id, name, avatar FROM bosses WHERE shop_id=$1 ORDER BY name',
      [shopId]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.use(injectShop);

// Only admin/dev may manage bosses
function adminOnly(req, res, next) {
  if (req.userRole !== 'admin' && req.userRole !== 'dev') {
    return res.status(403).json({ error: 'Only an admin can manage bosses' });
  }
  next();
}
const MAX_BOSSES = 2;

// List bosses for a shop. Boss sees names+avatars; Admin/dev also see the readable PIN.
router.get('/', requireBoss, async (req, res) => {
  const isAdmin = req.userRole === 'admin' || req.userRole === 'dev';
  const cols = isAdmin ? 'id, name, avatar, pin_plain' : 'id, name, avatar';
  const { rows } = await pool.query(
    `SELECT ${cols} FROM bosses WHERE shop_id=$1 ORDER BY name`,
    [req.shopId]
  );
  res.json(rows);
});

// Assign a boss to this shop (Admin/dev only) — max 2 per shop
router.post('/', adminOnly, async (req, res) => {
  const { name, avatar, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });
  if (pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 characters' });
  const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS n FROM bosses WHERE shop_id=$1', [req.shopId]);
  if (cnt[0].n >= MAX_BOSSES) return res.status(400).json({ error: `This shop already has the maximum of ${MAX_BOSSES} bosses` });
  const hash = await bcrypt.hash(pin, 10);
  try {
    const { rows } = await pool.query(
      'INSERT INTO bosses (shop_id, name, avatar, pin, pin_plain) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, avatar, pin_plain',
      [req.shopId, name.trim(), avatar || '👑', hash, pin]
    );
    await pool.query('INSERT INTO activity_log (shop_id, message) VALUES ($1,$2)', [req.shopId, `Boss assigned: ${name}`]);
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A boss with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Change a boss PIN (Admin/dev only)
router.post('/:id/pin', adminOnly, async (req, res) => {
  const { pin } = req.body;
  if (!pin || pin.length < 4) return res.status(400).json({ error: 'PIN must be 4+ characters' });
  const hash = await bcrypt.hash(pin, 10);
  const { rowCount } = await pool.query('UPDATE bosses SET pin=$1, pin_plain=$2 WHERE id=$3 AND shop_id=$4', [hash, pin, req.params.id, req.shopId]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  await pool.query('INSERT INTO activity_log (shop_id, message) VALUES ($1,$2)', [req.shopId, 'Boss PIN changed by admin']);
  res.json({ ok: true });
});

// Remove a boss (Admin/dev only)
router.delete('/:id', adminOnly, async (req, res) => {
  const { rows } = await pool.query('SELECT name FROM bosses WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  await pool.query('DELETE FROM bosses WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId]);
  await pool.query('INSERT INTO activity_log (shop_id, message) VALUES ($1,$2)', [req.shopId, `Boss removed: ${rows[0].name}`]);
  res.json({ ok: true });
});

module.exports = router;
