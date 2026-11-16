const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireBoss, injectShop } = require('../middleware/auth');

router.use(injectShop);

// Get log (boss/admin only)
router.get('/', requireBoss, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM activity_log WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 200',
    [req.shopId]
  );
  res.json(rows);
});

// Clear log (boss/admin only)
router.delete('/', requireBoss, async (req, res) => {
  await pool.query('DELETE FROM activity_log WHERE shop_id=$1', [req.shopId]);
  res.json({ ok: true });
});

module.exports = router;
