// Require any authenticated session
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// Require boss or admin for the current shop
function requireBoss(req, res, next) {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (u.role !== 'boss' && u.role !== 'admin' && u.role !== 'dev') return res.status(403).json({ error: 'Boss access required' });
  next();
}

// Require admin role
function requireAdmin(req, res, next) {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (u.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Inject shopId from session into req — all data routes use this
function injectShop(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  req.shopId = req.session.user.shopId;
  req.userRole = req.session.user.role;
  req.mechId = req.session.user.mechId;
  next();
}

module.exports = { requireAuth, requireBoss, requireAdmin, injectShop };
