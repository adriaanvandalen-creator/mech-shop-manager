const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const bcrypt = require('bcryptjs');

// List all shops (public — for login screen)
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, slug, logo_image, logo_emoji FROM shops ORDER BY name');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Register a new shop
router.post('/register', async (req, res) => {
  const { name, boss_pin } = req.body;
  if (!name || !boss_pin) return res.status(400).json({ error: 'Name and boss PIN required' });
  if (boss_pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 characters' });

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hash = await bcrypt.hash(boss_pin, 10);

  try {
    const { rows } = await pool.query(
      'INSERT INTO shops (name, slug, boss_pin) VALUES ($1, $2, $3) RETURNING id, name, slug',
      [name.trim(), slug, hash]
    );
    // Seed default prices
    await seedPrices(rows[0].id);
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A shop with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Boss login for a shop
// Boss login — by named account
router.post('/:shopId/login/boss', async (req, res) => {
  const { bossId, pin } = req.body;
  const { rows: shopRows } = await pool.query('SELECT * FROM shops WHERE id = $1', [req.params.shopId]);
  if (!shopRows.length) return res.status(404).json({ error: 'Shop not found' });
  const shop = shopRows[0];

  if (bossId) {
    // Named boss account login
    const { rows: bossRows } = await pool.query(
      'SELECT * FROM bosses WHERE id=$1 AND shop_id=$2', [bossId, req.params.shopId]
    );
    if (!bossRows.length) return res.status(404).json({ error: 'Boss not found' });
    const boss = bossRows[0];
    const ok = await bcrypt.compare(pin, boss.pin);
    if (!ok) return res.status(401).json({ error: 'Wrong PIN' });
    req.session.user = { role: 'boss', shopId: shop.id, shopName: shop.name, name: boss.name, avatar: boss.avatar, bossId: boss.id };
    return res.json({ role: 'boss', shopId: shop.id, shopName: shop.name, name: boss.name, avatar: boss.avatar });
  }

  // Legacy fallback — shop-level boss_pin
  const ok = await bcrypt.compare(pin, shop.boss_pin);
  if (!ok) return res.status(401).json({ error: 'Wrong PIN' });
  req.session.user = { role: 'boss', shopId: shop.id, shopName: shop.name, name: 'Boss' };
  res.json({ role: 'boss', shopId: shop.id, shopName: shop.name, name: 'Boss' });
});

// Dev login — hidden, all-shop access. Disabled unless DEV_PIN is set in the environment.
router.post('/login/dev', async (req, res) => {
  const { pin } = req.body;
  const DEV_PIN = process.env.DEV_PIN;
  if (!DEV_PIN) return res.status(403).json({ error: 'Dev login is disabled' });
  if (pin !== DEV_PIN) return res.status(401).json({ error: 'Wrong PIN' });
  const { rows } = await pool.query('SELECT id, name FROM shops ORDER BY name');
  req.session.user = { role: 'dev', name: '[DEV] Schalk', shops: rows };
  res.json({ role: 'dev', name: '[DEV] Schalk', shops: rows });
});

// Dev shop switch
router.post('/login/dev/switch', async (req, res) => {
  const u = req.session.user;
  if (!u || u.role !== 'dev') return res.status(403).json({ error: 'Dev only' });
  const { shopId } = req.body;
  const { rows } = await pool.query('SELECT id, name FROM shops WHERE id=$1', [shopId]);
  if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
  req.session.user = { ...u, shopId: rows[0].id, shopName: rows[0].name };
  res.json({ ok: true, shopId: rows[0].id, shopName: rows[0].name });
});

// Admin login — global, PIN-protected, shop picker like dev
router.post('/login/admin', async (req, res) => {
  const { pin } = req.body;
  const ADMIN_PIN = process.env.ADMIN_PIN;
  if (!ADMIN_PIN) return res.status(500).json({ error: 'ADMIN_PIN not configured' });
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Wrong Admin PIN' });
  const { rows } = await pool.query('SELECT id, name FROM shops ORDER BY name');
  req.session.user = { role: 'admin', name: 'Admin', shops: rows };
  res.json({ role: 'admin', name: 'Admin', shops: rows });
});

// Admin shop switch
router.post('/login/admin/switch', async (req, res) => {
  const u = req.session.user;
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { shopId } = req.body;
  const { rows } = await pool.query('SELECT id, name FROM shops WHERE id=$1', [shopId]);
  if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
  req.session.user = { ...u, shopId: rows[0].id, shopName: rows[0].name };
  res.json({ ok: true, shopId: rows[0].id, shopName: rows[0].name });
});

// Mechanic login
router.post('/:shopId/login/mechanic', async (req, res) => {
  const { mechId, pin } = req.body;
  const { rows } = await pool.query(
    'SELECT * FROM mechanics WHERE id = $1 AND shop_id = $2',
    [mechId, req.params.shopId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Mechanic not found' });

  const mech = rows[0];
  if (mech.pin) {
    if (!pin) return res.status(400).json({ error: 'PIN required', needsPin: true });
    const ok = await bcrypt.compare(pin, mech.pin);
    if (!ok) return res.status(401).json({ error: 'Wrong PIN' });
  }

  req.session.user = {
    role: 'mechanic',
    shopId: parseInt(req.params.shopId),
    shopName: (await pool.query('SELECT name FROM shops WHERE id=$1',[req.params.shopId])).rows[0]?.name,
    mechId: mech.id,
    name: mech.name,
    avatar: mech.avatar
  };
  res.json({ role: 'mechanic', mechId: mech.id, name: mech.name, avatar: mech.avatar });
});

// Update shop theme (boss only)
router.post('/:shopId/theme', async (req, res) => {
  const u = req.session.user;
  if (!u || (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev') || (u.role !== 'dev' && u.shopId !== parseInt(req.params.shopId))) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { theme_color, theme_color2, logo_emoji, logo_image } = req.body;
  // logo_image is base64 data URL — limit to ~500KB
  if (logo_image && logo_image.length > 700000) {
    return res.status(400).json({ error: 'Logo too large. Please use an image under 500KB.' });
  }
  const fields = [theme_color || '#1a6fd4', theme_color2 || '#1558b0', logo_emoji || '🔧', req.params.shopId];
  let query = 'UPDATE shops SET theme_color=$1, theme_color2=$2, logo_emoji=$3';
  if (logo_image !== undefined) {
    query += ', logo_image=$5';
    fields.push(logo_image || null);
  }
  query += ' WHERE id=$4';
  await pool.query(query, fields);
  res.json({ ok: true });
});

// Get shop theme (public — needed before login to show branding)
router.get('/:shopId/theme', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT theme_color, theme_color2, logo_emoji, logo_image, name FROM shops WHERE id=$1',
    [req.params.shopId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// Get/save Full Stage config
router.get('/:shopId/stage-config', async (req, res) => {
  const u = req.session.user;
  if (!u || (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev')) return res.status(403).json({ error: 'Not allowed' });
  const { rows } = await pool.query('SELECT stage_config FROM shops WHERE id=$1', [req.params.shopId]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0].stage_config || {});
});

router.post('/:shopId/stage-config', async (req, res) => {
  const u = req.session.user;
  if (!u || (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev') || (u.role !== 'dev' && u.shopId !== parseInt(req.params.shopId))) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  await pool.query('UPDATE shops SET stage_config=$1 WHERE id=$2', [JSON.stringify(req.body), req.params.shopId]);
  res.json({ ok: true });
});

// Re-seed default prices for existing shop (boss only)
router.post('/:shopId/seed-prices', async (req, res) => {
  const u = req.session.user;
  if (!u || (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev') || (u.role !== 'dev' && u.shopId !== parseInt(req.params.shopId))) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  await seedPrices(req.params.shopId);
  res.json({ ok: true });
});

// Public mechanic list for login screen (names only, no sensitive data)
router.get('/:shopId/mechanics-public', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, avatar FROM mechanics WHERE shop_id = $1 ORDER BY name',
    [req.params.shopId]
  );
  res.json(rows);
});

// Change boss PIN
router.post('/:shopId/change-pin', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'boss' || req.session.user.shopId !== parseInt(req.params.shopId)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { pin } = req.body;
  if (!pin || pin.length < 4) return res.status(400).json({ error: 'PIN too short' });
  const hash = await bcrypt.hash(pin, 10);
  await pool.query('UPDATE shops SET boss_pin=$1 WHERE id=$2', [hash, req.params.shopId]);
  await pool.query('INSERT INTO activity_log (shop_id, message) VALUES ($1,$2)', [req.params.shopId, 'Boss PIN changed']);
  res.json({ ok: true });
});

// Delete shop (dev only) — cascades all data
router.delete('/:shopId', async (req, res) => {
  const u = req.session.user;
  if (!u || u.role !== 'dev') return res.status(403).json({ error: 'Dev only' });
  const { confirm } = req.body;
  const { rows } = await pool.query('SELECT name FROM shops WHERE id=$1', [req.params.shopId]);
  if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
  if (confirm !== rows[0].name) return res.status(400).json({ error: 'Confirmation name does not match' });
  await pool.query('DELETE FROM shops WHERE id=$1', [req.params.shopId]);
  res.json({ ok: true, deleted: rows[0].name });
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// Session status
router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json(req.session.user);
});

async function seedPrices(shopId) {
  // Shops start with no extra prices — master prices cover the standard list.
  // Boss/Admin can add shop-specific extras via the app.
}

module.exports = router;
