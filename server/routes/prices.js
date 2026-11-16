const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireBoss, injectShop } = require('../middleware/auth');

router.use(injectShop);

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM prices WHERE shop_id=$1 ORDER BY name', [req.shopId]
  );
  res.json(rows);
});

router.post('/', requireBoss, async (req, res) => {
  const { name, price } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'Name and price required' });
  const { rows } = await pool.query(
    `INSERT INTO prices (shop_id, name, price) VALUES ($1,$2,$3)
     ON CONFLICT (shop_id, name) DO UPDATE SET price=EXCLUDED.price RETURNING *`,
    [req.shopId, name.trim(), price]
  );
  res.json(rows[0]);
});

router.delete('/:id', requireBoss, async (req, res) => {
  await pool.query('DELETE FROM prices WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId]);
  res.json({ ok: true });
});

module.exports = router;
