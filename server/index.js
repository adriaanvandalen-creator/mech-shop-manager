require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const cors = require('cors');
const path = require('path');
const { pool, initDb, MEMORY_DB } = require('./db');

// Never let a stray async error crash the process (keeps the server/function alive).
process.on('unhandledRejection', (e) => console.error('⚠️  unhandledRejection:', e && (e.stack || e.message || e)));
process.on('uncaughtException',  (e) => console.error('⚠️  uncaughtException:', e && (e.stack || e.message || e)));

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' })); // large for base64 images
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));

// Trust Railway's reverse proxy so secure cookies work over HTTPS
app.set('trust proxy', 1);

// Sessions stored in Postgres
app.use(session({
  // Postgres-backed sessions normally; in-memory test mode uses the default store
  ...(MEMORY_DB ? {} : { store: new pgSession({ pool, createTableIfMissing: true }) }),
  secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Ensure the DB schema + seed is ready before any API request.
// Cached so it runs once per process (safe on Vercel serverless cold starts).
let _dbReady = null;
function ensureDb() {
  if (!_dbReady) _dbReady = initDb().catch(err => { _dbReady = null; throw err; });
  return _dbReady;
}
app.use('/api', async (req, res, next) => {
  try { await ensureDb(); next(); }
  catch (e) { console.error('DB init failed:', e && e.message); res.status(503).json({ error: 'Database starting up — please retry' }); }
});

// API Routes
app.use('/api/shops',         require('./routes/shops'));
app.use('/api/mechanics',     require('./routes/mechanics'));
app.use('/api/orders',        require('./routes/orders'));
app.use('/api/timesheets',    require('./routes/timesheets'));
app.use('/api/tabs',          require('./routes/tabs'));
app.use('/api/log',           require('./routes/log'));
app.use('/api/prices',        require('./routes/prices'));
app.use('/api/master-prices', require('./routes/master-prices'));
app.use('/api/vision',        require('./routes/vision'));
app.use('/api/stock',         require('./routes/stock'));
app.use('/api/materials',     require('./routes/materials'));
app.use('/api/recipes',       require('./routes/recipes'));
app.use('/api/clients',       require('./routes/clients'));
app.use('/api/bundles',       require('./routes/bundles'));
app.use('/api/bosses',        require('./routes/bosses'));
app.use('/api/craft-log',     require('./routes/craft-log'));
app.use('/api/boxes',         require('./routes/boxes'));
app.use('/api/sync',          require('./routes/sync'));

// Build version — changes every server restart/deploy
// Stable per-DEPLOYMENT version. On Vercel every function instance must report the
// same value (Date.now() differs per cold start → false "new update" + forced logout).
const BUILD_VERSION =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.VERCEL_DEPLOYMENT_ID ||
  process.env.BUILD_ID ||
  Date.now().toString();
app.get('/api/version', (req, res) => res.json({ version: BUILD_VERSION }));

// Logout endpoint — clears session so user must log in again after reload
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Unknown API routes → JSON 404 (not the HTML app)
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Serve frontend (static assets, then SPA fallback to index.html)
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Final error handler — any route error returns clean JSON instead of hanging
app.use((err, req, res, next) => {
  console.error('Route error:', err && (err.stack || err.message || err));
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// Run a long-running server when executed directly (local / Railway / Render).
// On Vercel this file is imported by api/index.js and exported as a serverless handler.
if (require.main === module) {
  ensureDb()
    .then(() => app.listen(PORT, () => console.log(`🔧 Mech Shop Manager running on port ${PORT}`)))
    .catch(err => { console.error('DB init failed:', err); process.exit(1); });
}

module.exports = app;
