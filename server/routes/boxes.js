const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { injectShop } = require('../middleware/auth');

router.use(injectShop);

const isBoss = (req) => ['boss', 'admin', 'dev'].includes(req.userRole);

// Start of the current reminder period (week = Sunday 00:00, month = 1st)
function periodStart(period) {
  const now = new Date();
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(now.getDate() - now.getDay());
  return d;
}

// Boxes overview — shop count, reminder settings, recent deposits, per-mechanic totals
router.get('/', async (req, res) => {
  try {
    const { rows: shopRows } = await pool.query(
      'SELECT boxes_count, box_reminder_on, box_reminder_target, box_reminder_period, box_reminder_msg FROM shops WHERE id=$1',
      [req.shopId]
    );
    const s = shopRows[0] || {};
    const period = s.box_reminder_period || 'week';
    const start = periodStart(period);

    const { rows: deposits } = await pool.query(
      `SELECT id, mechanic_id, mechanic_name, qty, created_at FROM box_deposits
       WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.shopId]
    );
    // Per-mechanic deposited in the current period
    const { rows: perMech } = await pool.query(
      `SELECT m.id, m.name, m.avatar, COALESCE(SUM(d.qty),0)::int AS deposited
       FROM mechanics m
       LEFT JOIN box_deposits d ON d.mechanic_id = m.id AND d.shop_id = m.shop_id AND d.created_at >= $2
       WHERE m.shop_id = $1
       GROUP BY m.id, m.name, m.avatar
       ORDER BY m.name`, [req.shopId, start]
    );

    res.json({
      count: s.boxes_count || 0,
      reminder: {
        on: !!s.box_reminder_on,
        target: s.box_reminder_target || 0,
        period,
        msg: s.box_reminder_msg || '',
      },
      periodStart: start.toISOString(),
      deposits,
      perMechanic: perMech,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mechanic (or boss) deposits boxes — adds to the shop total and logs who
router.post('/deposit', async (req, res) => {
  const qty = parseInt(req.body.qty);
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Enter how many boxes to deposit' });
  try {
    const name = (req.session.user && req.session.user.name) || null;
    await pool.query(
      'INSERT INTO box_deposits (shop_id, mechanic_id, mechanic_name, qty) VALUES ($1,$2,$3,$4)',
      [req.shopId, req.mechId || null, name, qty]
    );
    const { rows } = await pool.query(
      'UPDATE shops SET boxes_count = COALESCE(boxes_count,0) + $1 WHERE id=$2 RETURNING boxes_count',
      [qty, req.shopId]
    );
    res.json({ ok: true, count: rows[0].boxes_count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Boss sets the shop's box count directly
router.post('/set', async (req, res) => {
  if (!isBoss(req)) return res.status(403).json({ error: 'Boss only' });
  const count = parseInt(req.body.count);
  if (isNaN(count) || count < 0) return res.status(400).json({ error: 'Enter a valid box count' });
  try {
    await pool.query('UPDATE shops SET boxes_count=$1 WHERE id=$2', [count, req.shopId]);
    res.json({ ok: true, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Boss configures the mechanics' box hand-in reminder
router.post('/reminder', async (req, res) => {
  if (!isBoss(req)) return res.status(403).json({ error: 'Boss only' });
  const { on, target, period, msg } = req.body;
  const per = period === 'month' ? 'month' : 'week';
  try {
    await pool.query(
      `UPDATE shops SET box_reminder_on=$1, box_reminder_target=$2, box_reminder_period=$3, box_reminder_msg=$4 WHERE id=$5`,
      [!!on, parseInt(target) || 0, per, (msg || '').slice(0, 200), req.shopId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
