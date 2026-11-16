const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, injectShop } = require('../middleware/auth');

router.use(requireAuth, injectShop);

// GET /api/clients?q=foo  — search (fuzzy via ILIKE) or list all
router.get('/', async (req, res) => {
  try {
    const { q } = req.query;
    let rows;
    if (q && q.trim()) {
      const pattern = '%' + q.trim().split('').join('%') + '%'; // fuzzy: each char with wildcards
      ({ rows } = await pool.query(
        `SELECT * FROM clients WHERE shop_id=$1 AND name ILIKE $2 ORDER BY name LIMIT 20`,
        [req.shopId, '%' + q.trim() + '%']
      ));
    } else {
      ({ rows } = await pool.query(
        'SELECT * FROM clients WHERE shop_id=$1 ORDER BY name',
        [req.shopId]
      ));
    }
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clients — add a client (upsert by name, case-insensitive)
router.post('/', async (req, res) => {
  const { name, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO clients (shop_id, name, notes)
       VALUES ($1, $2, $3)
       ON CONFLICT (shop_id, name) DO UPDATE SET notes=COALESCE(EXCLUDED.notes, clients.notes)
       RETURNING *`,
      [req.shopId, name.trim(), notes || '']
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/clients/:id — update notes
router.patch('/:id', async (req, res) => {
  const { name, notes } = req.body;
  try {
    const fields = [], vals = [];
    let i = 1;
    if (name) { fields.push(`name=$${i++}`); vals.push(name.trim()); }
    if (notes !== undefined) { fields.push(`notes=$${i++}`); vals.push(notes); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id, req.shopId);
    const { rows } = await pool.query(
      `UPDATE clients SET ${fields.join(',')} WHERE id=$${i++} AND shop_id=$${i++} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/clients/:id — boss/admin only
router.delete('/:id', async (req, res) => {
  const u = req.session?.user;
  if (!u || (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev')) return res.status(403).json({ error: 'Boss only' });
  try {
    await pool.query('DELETE FROM clients WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
