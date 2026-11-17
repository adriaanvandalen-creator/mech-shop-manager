const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireBoss, injectShop } = require('../middleware/auth');

router.use(injectShop);

// List orders — mechanics only see their own
router.get('/', async (req, res) => {
  let query, params;
  if (req.userRole === 'mechanic') {
    query = 'SELECT * FROM orders WHERE shop_id=$1 AND mechanic_id=$2 ORDER BY created_at DESC';
    params = [req.shopId, req.mechId];
  } else {
    query = 'SELECT * FROM orders WHERE shop_id=$1 ORDER BY created_at DESC';
    params = [req.shopId];
  }
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// Create order
router.post('/', async (req, res) => {
  const { vehicle, plate, player, mechanic_id, mechanic_name, price, parts, notes, client_type, tab_id } = req.body;
  const createdBy = (req.session.user && req.session.user.name) ? req.session.user.name : null;
  const { rows } = await pool.query(
    `INSERT INTO orders (shop_id, vehicle, plate, player, mechanic_id, mechanic_name, price, parts, notes, client_type, tab_id, created_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'inprogress') RETURNING *`,
    [req.shopId, vehicle, plate, player, mechanic_id || null, mechanic_name || '', price || 0,
     JSON.stringify(parts || []), notes || '', client_type || 'regular', tab_id || null, createdBy]
  );
  const o = rows[0];
  // Auto-charge tab account when client_type is tab
  if (client_type === 'tab' && tab_id && price > 0) {
    await pool.query(
      'UPDATE tab_accounts SET balance = balance + $1 WHERE id=$2 AND shop_id=$3',
      [price, tab_id, req.shopId]
    );
    await pool.query(
      'INSERT INTO tab_charges (shop_id, tab_id, amount, description, mode) VALUES ($1,$2,$3,$4,$5)',
      [req.shopId, tab_id, price, `Order #${o.id} — ${vehicle || 'Vehicle'}`, 'charge']
    );
  }
  await addLog(req.shopId, `New order — ${vehicle}${player ? ' ('+player+')' : ''} R${(price||0).toLocaleString()} → ${mechanic_name || 'Unassigned'} [${createdBy || 'Unknown'}]`);
  res.json(o);
});

// Update order status/fields
router.patch('/:id', async (req, res) => {
  const { status, price, parts, notes, mechanic_id, mechanic_name, vehicle, plate, player, client_type, tab_id } = req.body;

  // Mechanics can only update orders assigned to them
  const { rows: existing } = await pool.query(
    'SELECT * FROM orders WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId]
  );
  if (!existing.length) return res.status(404).json({ error: 'Not found' });
  if (req.userRole === 'mechanic' && existing[0].mechanic_id !== req.mechId) {
    return res.status(403).json({ error: 'Not your order' });
  }
  // Mechanics cannot edit a completed order (status changes like inprogress→done are still allowed)
  if (req.userRole === 'mechanic' && existing[0].status === 'done' && status === undefined) {
    return res.status(403).json({ error: 'Order already completed — contact your boss to make changes' });
  }

  const fields = [];
  const vals = [];
  let i = 1;
  const add = (col, val) => { fields.push(`${col}=$${i++}`); vals.push(val); };

  if (status !== undefined) add('status', status);
  if (price !== undefined) add('price', price);
  if (parts !== undefined) add('parts', JSON.stringify(parts));
  if (notes !== undefined) add('notes', notes);
  if (mechanic_id !== undefined) add('mechanic_id', mechanic_id);
  if (mechanic_name !== undefined) add('mechanic_name', mechanic_name);
  if (vehicle !== undefined) add('vehicle', vehicle);
  if (plate !== undefined) add('plate', plate);
  if (player !== undefined) add('player', player);
  if (client_type !== undefined) add('client_type', client_type);
  if (tab_id !== undefined) add('tab_id', tab_id);
  // Set done_at exactly when order first transitions to done
  if (status === 'done' && existing[0].status !== 'done') fields.push(`done_at=NOW()`);
  // Clear done_at if reopened
  if (status && status !== 'done' && existing[0].status === 'done') fields.push(`done_at=NULL`);
  fields.push(`updated_at=NOW()`);

  vals.push(req.params.id, req.shopId);
  const { rows } = await pool.query(
    `UPDATE orders SET ${fields.join(',')} WHERE id=$${i++} AND shop_id=$${i++} RETURNING *`,
    vals
  );
  // If price or tab changed on a tab order, adjust the tab balance
  const updated = rows[0];
  const wasTab = existing[0].client_type === 'tab';
  const isTab = (client_type !== undefined ? client_type : existing[0].client_type) === 'tab';
  const effectiveTabId = tab_id !== undefined ? tab_id : existing[0].tab_id;
  if (isTab && effectiveTabId && price !== undefined) {
    const oldPrice = parseFloat(existing[0].price) || 0;
    const newPrice = parseFloat(price) || 0;
    const diff = newPrice - oldPrice;
    if (diff !== 0) {
      await pool.query(
        'UPDATE tab_accounts SET balance = balance + $1 WHERE id=$2 AND shop_id=$3',
        [diff, effectiveTabId, req.shopId]
      );
      await pool.query(
        'INSERT INTO tab_charges (shop_id, tab_id, amount, description, mode) VALUES ($1,$2,$3,$4,$5)',
        [req.shopId, effectiveTabId, Math.abs(diff), `Order #${req.params.id} updated`, diff > 0 ? 'charge' : 'payment']
      );
    }
  }
  // Auto-deduct stock when order is marked done
  if (status === 'done' && existing[0].status !== 'done') {
    const parts = existing[0].parts || [];
    const partsArr = Array.isArray(parts) ? parts : (typeof parts === 'string' ? JSON.parse(parts) : []);
    for (const part of partsArr) {
      if (!part.name) continue;
      const orderQty = parseInt(part.qty) || 1;

      // Check if this part has a bundle definition
      const { rows: bundleRows } = await pool.query(
        `SELECT b.stock_item_id, b.qty, s.quantity AS stock_qty
         FROM bundles b
         JOIN stock_items s ON s.id = b.stock_item_id
         WHERE b.shop_id=$1 AND LOWER(b.price_name)=LOWER($2)`,
        [req.shopId, part.name]
      );

      if (bundleRows.length) {
        // Check if the individual bundle items were already added as explicit line items
        // (happens when boss used the bundle checklist — items added as R0 lines)
        const bundleStockIds = bundleRows.map(b => b.stock_item_id);
        const { rows: explicitCheck } = await pool.query(
          `SELECT s.id FROM stock_items s
           WHERE s.shop_id=$1 AND s.id = ANY($2)
           AND LOWER(s.name) = ANY(SELECT LOWER(p->>'name') FROM jsonb_array_elements($3::jsonb) p)`,
          [req.shopId, bundleStockIds, JSON.stringify(partsArr)]
        );
        if (explicitCheck.length > 0) {
          // Items already on the order as explicit lines — skip bundle deduction to avoid double-deduct
        } else {
          // Deduct each bundle component × order qty
          for (const comp of bundleRows) {
            const deduct = comp.qty * orderQty;
            await pool.query(
              `UPDATE stock_items SET quantity = GREATEST(0, quantity - $1) WHERE id=$2 AND shop_id=$3`,
              [deduct, comp.stock_item_id, req.shopId]
            );
          }
        }
      } else {
        // No bundle — try direct stock item name match (single deduction)
        const { rows: stockRows } = await pool.query(
          `SELECT id FROM stock_items WHERE shop_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`,
          [req.shopId, part.name]
        );
        if (stockRows.length) {
          await pool.query(
            `UPDATE stock_items SET quantity = GREATEST(0, quantity - $1) WHERE id=$2 AND shop_id=$3`,
            [orderQty, stockRows[0].id, req.shopId]
          );
        }
      }
    }
  }

  if (status) {
    const ord = rows[0] || existing[0];
    const primary = ord.player || ord.vehicle || `#${req.params.id}`;
    const secondary = (ord.player && ord.vehicle && ord.vehicle !== ord.player) ? ` (${ord.vehicle})` : '';
    const who = (req.session && req.session.user && req.session.user.name) ? req.session.user.name : 'Boss';
    await addLog(req.shopId, `${primary}${secondary} → ${status} [${who}]`);
  }
  res.json(rows[0]);
});

// Delete order (boss/admin only)
router.delete('/:id', requireBoss, async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM orders WHERE id=$1 AND shop_id=$2 RETURNING id', [req.params.id, req.shopId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  await addLog(req.shopId, `🛡️ Order #${req.params.id} deleted`);
  res.json({ ok: true });
});

async function addLog(shopId, msg) {
  await pool.query('INSERT INTO activity_log (shop_id, message) VALUES ($1, $2)', [shopId, msg]);
}

module.exports = router;
