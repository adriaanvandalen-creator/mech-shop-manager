const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireBoss, injectShop } = require('../middleware/auth');

router.use(injectShop);

// List tab accounts
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM tab_accounts WHERE shop_id=$1 ORDER BY name', [req.shopId]
  );
  res.json(rows);
});

// Sync existing tab orders that were never charged
router.post('/sync-orders', requireBoss, async (req, res) => {
  // Find all tab orders for this shop
  const { rows: tabOrders } = await pool.query(
    `SELECT * FROM orders WHERE shop_id=$1 AND client_type='tab' AND tab_id IS NOT NULL AND price > 0`,
    [req.shopId]
  );

  let synced = 0;
  for (const o of tabOrders) {
    // Check if a charge already exists for this order
    const { rows: existing } = await pool.query(
      `SELECT id FROM tab_charges WHERE shop_id=$1 AND tab_id=$2 AND description LIKE $3`,
      [req.shopId, o.tab_id, `Order #${o.id}%`]
    );
    if (existing.length) continue; // already charged

    // Post the charge
    await pool.query(
      'UPDATE tab_accounts SET balance = balance + $1 WHERE id=$2 AND shop_id=$3',
      [o.price, o.tab_id, req.shopId]
    );
    await pool.query(
      'INSERT INTO tab_charges (shop_id, tab_id, amount, description, mode) VALUES ($1,$2,$3,$4,$5)',
      [req.shopId, o.tab_id, o.price, `Order #${o.id} — ${o.vehicle || 'Vehicle'} (synced)`, 'charge']
    );
    synced++;
  }

  await addLog(req.shopId, `Tab sync: ${synced} order${synced !== 1 ? 's' : ''} posted to accounts`);
  res.json({ synced });
});

// Create tab account (boss/admin)
router.post('/', requireBoss, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const { rows } = await pool.query(
    'INSERT INTO tab_accounts (shop_id, name) VALUES ($1,$2) RETURNING *', [req.shopId, name.trim()]
  );
  await addLog(req.shopId, `Account added: ${name}`);
  res.json(rows[0]);
});

// Charge or payment
router.post('/:id/charge', async (req, res) => {
  const { amount, description, mode } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const delta = mode === 'payment' ? -Math.abs(amount) : Math.abs(amount);
  await pool.query('UPDATE tab_accounts SET balance = balance + $1 WHERE id=$2 AND shop_id=$3',
    [delta, req.params.id, req.shopId]);
  await pool.query(
    'INSERT INTO tab_charges (shop_id, tab_id, amount, description, mode) VALUES ($1,$2,$3,$4,$5)',
    [req.shopId, req.params.id, amount, description || '', mode || 'charge']
  );

  const { rows: acc } = await pool.query('SELECT name FROM tab_accounts WHERE id=$1', [req.params.id]);
  const label = mode === 'payment' ? 'Payment' : 'Charged';
  await addLog(req.shopId, `${acc[0]?.name}: ${label} R${amount.toLocaleString()} — ${description}`);

  const { rows } = await pool.query('SELECT * FROM tab_accounts WHERE id=$1', [req.params.id]);
  res.json(rows[0]);
});

// Get charges/history for a tab (with optional date range ?start=&end=)
router.get('/:id/charges', async (req, res) => {
  const { start, end } = req.query;
  let query = 'SELECT * FROM tab_charges WHERE tab_id=$1 AND shop_id=$2';
  const params = [req.params.id, req.shopId];
  if (start) { params.push(start); query += ` AND created_at >= $${params.length}`; }
  if (end)   { params.push(end);   query += ` AND created_at <= $${params.length}::date + interval '1 day'`; }
  query += ' ORDER BY created_at DESC';
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// Delete tab account (boss/admin)
router.delete('/:id', requireBoss, async (req, res) => {
  await pool.query('DELETE FROM tab_accounts WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId]);
  res.json({ ok: true });
});

async function addLog(shopId, msg) {
  await pool.query('INSERT INTO activity_log (shop_id, message) VALUES ($1, $2)', [shopId, msg]);
}

module.exports = router;
