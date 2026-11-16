const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const bcrypt = require('bcryptjs');
const { requireBoss, injectShop } = require('../middleware/auth');

// All routes scoped to session's shop
router.use(injectShop);

// List workers for this shop. Admin/dev also receive the readable PIN.
router.get('/', async (req, res) => {
  const isAdmin = req.userRole === 'admin' || req.userRole === 'dev';
  const cols = isAdmin
    ? 'id, name, avatar, clocked_in, clock_in_time, current_ts_id, pin_plain'
    : 'id, name, avatar, clocked_in, clock_in_time, current_ts_id';
  const { rows } = await pool.query(
    `SELECT ${cols} FROM mechanics WHERE shop_id = $1 ORDER BY name`,
    [req.shopId]
  );
  res.json(rows);
});

// Add worker (boss/admin). The boss sets the worker's initial PIN here.
router.post('/', requireBoss, async (req, res) => {
  const { name, avatar, pin } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (pin && pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 characters' });
  const hash = pin ? await bcrypt.hash(pin, 10) : null;
  const { rows } = await pool.query(
    'INSERT INTO mechanics (shop_id, name, avatar, pin, pin_plain) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, avatar',
    [req.shopId, name.trim(), avatar || '🔧', hash, pin || null]
  );
  await addLog(req.shopId, `${avatar || '🔧'} ${name} added as worker`);
  res.json(rows[0]);
});

// Change a worker PIN — Admin/dev only (the boss can only set it at creation)
router.post('/:id/pin', async (req, res) => {
  if (req.userRole !== 'admin' && req.userRole !== 'dev') {
    return res.status(403).json({ error: 'Only an admin can change a worker PIN' });
  }
  const { pin } = req.body;
  if (!pin || pin.length < 4) return res.status(400).json({ error: 'PIN must be 4+ characters' });
  const hash = await bcrypt.hash(pin, 10);
  const { rowCount } = await pool.query(
    'UPDATE mechanics SET pin = $1, pin_plain = $2 WHERE id = $3 AND shop_id = $4',
    [hash, pin, req.params.id, req.shopId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  await addLog(req.shopId, 'Worker PIN changed by admin');
  res.json({ ok: true });
});

// Clock in
router.post('/:id/clock-in', async (req, res) => {
  const mechId = parseInt(req.params.id);
  // Mechanics can only clock themselves in
  if (req.userRole === 'mechanic' && req.mechId !== mechId) {
    return res.status(403).json({ error: 'Cannot clock in another mechanic' });
  }
  const { rows: mrows } = await pool.query(
    'SELECT * FROM mechanics WHERE id = $1 AND shop_id = $2', [mechId, req.shopId]
  );
  if (!mrows.length) return res.status(404).json({ error: 'Mechanic not found' });
  const m = mrows[0];
  if (m.clocked_in) return res.status(400).json({ error: 'Already clocked in' });

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
  const { rows: tsRows } = await pool.query(
    'INSERT INTO timesheets (shop_id, mechanic_id, mech_name, mech_avatar, clock_in, date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [req.shopId, mechId, m.name, m.avatar, now, dateStr]
  );
  const tsId = tsRows[0].id;
  await pool.query(
    'UPDATE mechanics SET clocked_in=true, clock_in_time=$1, current_ts_id=$2 WHERE id=$3',
    [now, tsId, mechId]
  );
  await addLog(req.shopId, `${m.avatar} ${m.name} clocked IN`);
  res.json({ ok: true, tsId });
});

// Clock out
router.post('/:id/clock-out', async (req, res) => {
  const mechId = parseInt(req.params.id);
  if (req.userRole === 'mechanic' && req.mechId !== mechId) {
    return res.status(403).json({ error: 'Cannot clock out another mechanic' });
  }
  const { rows: mrows } = await pool.query(
    'SELECT * FROM mechanics WHERE id = $1 AND shop_id = $2', [mechId, req.shopId]
  );
  if (!mrows.length) return res.status(404).json({ error: 'Mechanic not found' });
  const m = mrows[0];
  if (!m.clocked_in) return res.status(400).json({ error: 'Not clocked in' });

  const now = new Date();
  const cin = new Date(m.clock_in_time);
  const hrs = ((now - cin) / 3600000).toFixed(2);
  await pool.query(
    'UPDATE timesheets SET clock_out=$1, hours=$2 WHERE id=$3',
    [now, parseFloat(hrs), m.current_ts_id]
  );
  await pool.query(
    'UPDATE mechanics SET clocked_in=false, clock_in_time=NULL, current_ts_id=NULL WHERE id=$1',
    [mechId]
  );
  await addLog(req.shopId, `${m.avatar} ${m.name} clocked OUT (${hrs}h)`);
  res.json({ ok: true, hours: parseFloat(hrs) });
});

// Admin kick (force clock out)
router.post('/:id/kick', async (req, res) => {
  if (req.userRole !== 'admin' && req.userRole !== 'boss') {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const mechId = parseInt(req.params.id);
  const { rows: mrows } = await pool.query(
    'SELECT * FROM mechanics WHERE id = $1 AND shop_id = $2', [mechId, req.shopId]
  );
  if (!mrows.length) return res.status(404).json({ error: 'Not found' });
  const m = mrows[0];
  if (!m.clocked_in) return res.status(400).json({ error: 'Not clocked in' });

  const now = new Date();
  const cin = new Date(m.clock_in_time);
  const hrs = ((now - cin) / 3600000).toFixed(2);
  await pool.query(
    'UPDATE timesheets SET clock_out=$1, hours=$2 WHERE id=$3',
    [now, parseFloat(hrs), m.current_ts_id]
  );
  await pool.query(
    'UPDATE mechanics SET clocked_in=false, clock_in_time=NULL, current_ts_id=NULL WHERE id=$1',
    [mechId]
  );
  await addLog(req.shopId, `🛡️ Admin force-clocked OUT ${m.name}`);
  res.json({ ok: true });
});

// Delete mechanic (boss/admin)
router.delete('/:id', requireBoss, async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM mechanics WHERE id=$1 AND shop_id=$2 RETURNING name', [req.params.id, req.shopId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  await addLog(req.shopId, `Mechanic ${rows[0].name} removed`);
  res.json({ ok: true });
});

async function addLog(shopId, msg) {
  await pool.query('INSERT INTO activity_log (shop_id, message) VALUES ($1, $2)', [shopId, msg]);
}

module.exports = router;
