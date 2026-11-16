const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { injectShop } = require('../middleware/auth');

router.use(injectShop);

// List timesheets
router.get('/', async (req, res) => {
  let query, params;
  if (req.userRole === 'mechanic') {
    query = 'SELECT * FROM timesheets WHERE shop_id=$1 AND mechanic_id=$2 ORDER BY clock_in DESC';
    params = [req.shopId, req.mechId];
  } else {
    query = 'SELECT * FROM timesheets WHERE shop_id=$1 ORDER BY clock_in DESC';
    params = [req.shopId];
  }
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// Payroll summary — hours per mechanic for a date range
router.get('/payroll', async (req, res) => {
  const { start, end } = req.query;
  const { rows } = await pool.query(
    `SELECT mechanic_id, mech_name, mech_avatar,
            COUNT(*) as shifts,
            ROUND(SUM(hours)::numeric, 2) as total_hours
     FROM timesheets
     WHERE shop_id=$1 AND clock_out IS NOT NULL
       AND clock_in >= $2 AND clock_in < $3
     GROUP BY mechanic_id, mech_name, mech_avatar
     ORDER BY mech_name`,
    [req.shopId, start, end]
  );
  res.json(rows);
});

// Payroll detail — individual shifts for export
router.get('/payroll/detail', async (req, res) => {
  const { start, end } = req.query;
  const { rows } = await pool.query(
    `SELECT id, mechanic_id, mech_name, mech_avatar,
            clock_in, clock_out,
            ROUND(hours::numeric, 2) as hours,
            date
     FROM timesheets
     WHERE shop_id=$1 AND clock_out IS NOT NULL
       AND clock_in >= $2 AND clock_in < $3
     ORDER BY mech_name, clock_in`,
    [req.shopId, start, end]
  );
  res.json(rows);
});

module.exports = router;
