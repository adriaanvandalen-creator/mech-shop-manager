const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

// Use a real Postgres when DATABASE_URL is set; otherwise fall back to an
// ephemeral in-memory database so the app can be run/tested with zero setup.
// (In-memory data resets every restart — add DATABASE_URL for persistence.)
const MEMORY_DB = !process.env.DATABASE_URL;
let pool;

if (!MEMORY_DB) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('railway.internal')
      ? false
      : { rejectUnauthorized: false },
    max: 20,              // max simultaneous DB connections
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
} else {
  const { newDb, DataType } = require('pg-mem');
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  // pg-mem implements very few native functions — register the ones this app uses.
  const reg = (name, args, returns, implementation) => {
    try { mem.public.registerFunction({ name, args, returns, implementation, impure:false }); } catch(e){}
  };
  reg('round', [DataType.float, DataType.integer], DataType.float, (x,n)=>{ const f=Math.pow(10, n||0); return Math.round((x||0)*f)/f; });
  reg('round', [DataType.float], DataType.float, (x)=>Math.round(x||0));
  reg('trunc', [DataType.float], DataType.float, (x)=>Math.trunc(x||0));
  reg('to_char', [DataType.timestamp, DataType.text], DataType.text, (d,fmt)=>{ try{return new Date(d).toISOString();}catch(e){return '';} });
  reg('coalesce', [DataType.float, DataType.float], DataType.float, (a,b)=> (a==null?b:a));
  pool = new (mem.adapters.createPg().Pool)();
  console.warn('⚠️  No DATABASE_URL set — running on an IN-MEMORY test database. Data will NOT persist across restarts.');
}

// Initialize all tables
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      slug      TEXT NOT NULL UNIQUE,
      boss_pin  TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mechanics (
      id        SERIAL PRIMARY KEY,
      shop_id   INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      avatar    TEXT DEFAULT '🔧',
      pin       TEXT,
      clocked_in BOOLEAN DEFAULT FALSE,
      clock_in_time TIMESTAMPTZ,
      current_ts_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id          SERIAL PRIMARY KEY,
      shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      vehicle     TEXT,
      plate       TEXT,
      player      TEXT,
      mechanic_id INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
      mechanic_name TEXT,
      status      TEXT DEFAULT 'pending',
      price       NUMERIC DEFAULT 0,
      parts       JSONB DEFAULT '[]',
      notes       TEXT,
      client_type TEXT DEFAULT 'regular',
      tab_id      INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      done_at     TIMESTAMPTZ
    );
    -- Add columns to existing tables (safe if already exists)
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by TEXT;
    -- (craft_output on stock_items is added after that table is created, below)

    CREATE TABLE IF NOT EXISTS timesheets (
      id          SERIAL PRIMARY KEY,
      shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      mechanic_id INTEGER NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
      mech_name   TEXT,
      mech_avatar TEXT,
      clock_in    TIMESTAMPTZ NOT NULL,
      clock_out   TIMESTAMPTZ,
      hours       NUMERIC,
      date        TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tab_accounts (
      id        SERIAL PRIMARY KEY,
      shop_id   INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      balance   NUMERIC DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tab_charges (
      id         SERIAL PRIMARY KEY,
      shop_id    INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      tab_id     INTEGER NOT NULL REFERENCES tab_accounts(id) ON DELETE CASCADE,
      amount     NUMERIC NOT NULL,
      description TEXT,
      mode       TEXT DEFAULT 'charge',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id        SERIAL PRIMARY KEY,
      shop_id   INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      message   TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prices (
      id      SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name    TEXT NOT NULL,
      price   NUMERIC NOT NULL,
      UNIQUE(shop_id, name)
    );

    CREATE TABLE IF NOT EXISTS master_prices (
      id    SERIAL PRIMARY KEY,
      name  TEXT NOT NULL UNIQUE,
      price NUMERIC NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE shops ADD COLUMN IF NOT EXISTS theme_color TEXT DEFAULT '#1a6fd4';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS theme_color2 TEXT DEFAULT '#1558b0';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS logo_emoji  TEXT DEFAULT '🔧';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS logo_image  TEXT;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS stage_config JSONB DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS stock_items (
      id         SERIAL PRIMARY KEY,
      shop_id    INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      quantity   INTEGER NOT NULL DEFAULT 0,
      price      NUMERIC(10,2) DEFAULT 0,
      image      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS craft_output TEXT DEFAULT 'stock';

    CREATE TABLE IF NOT EXISTS materials (
      id            SERIAL PRIMARY KEY,
      shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      quantity      INTEGER NOT NULL DEFAULT 0,
      unit          TEXT DEFAULT 'units',
      low_threshold INTEGER DEFAULT 10,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock_history (
      id            SERIAL PRIMARY KEY,
      shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      item_id       INTEGER REFERENCES stock_items(id) ON DELETE SET NULL,
      item_name     TEXT,
      delta         INTEGER,
      mode          TEXT,
      note          TEXT,
      mechanic_name TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS craft_recipes (
      id              SERIAL PRIMARY KEY,
      shop_id         INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      stock_item_id   INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
      material_id     INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      qty_needed      INTEGER NOT NULL DEFAULT 1,
      craft_time_mins INTEGER DEFAULT 0,
      craft_level     INTEGER DEFAULT 1,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(stock_item_id, material_id)
    );

    CREATE TABLE IF NOT EXISTS clients (
      id         SERIAL PRIMARY KEY,
      shop_id    INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      notes      TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(shop_id, name)
    );

    CREATE TABLE IF NOT EXISTS shop_hidden_prices (
      shop_id         INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      master_price_id INTEGER NOT NULL REFERENCES master_prices(id) ON DELETE CASCADE,
      PRIMARY KEY (shop_id, master_price_id)
    );

    CREATE TABLE IF NOT EXISTS craft_meta (
      id              SERIAL PRIMARY KEY,
      shop_id         INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      stock_item_id   INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
      craft_time_mins INTEGER DEFAULT 0,
      craft_level     INTEGER DEFAULT 1,
      UNIQUE(shop_id, stock_item_id)
    );

    ALTER TABLE craft_recipes DROP COLUMN IF EXISTS craft_time_mins;
    ALTER TABLE craft_recipes DROP COLUMN IF EXISTS craft_level;

    CREATE TABLE IF NOT EXISTS bosses (
      id        SERIAL PRIMARY KEY,
      shop_id   INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      avatar    TEXT DEFAULT '👑',
      pin       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(shop_id, name)
    );

    CREATE TABLE IF NOT EXISTS bundles (
      id            SERIAL PRIMARY KEY,
      shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      price_name    TEXT NOT NULL,
      stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
      qty           INTEGER NOT NULL DEFAULT 1,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(shop_id, price_name, stock_item_id)
    );

    CREATE TABLE IF NOT EXISTS craft_log (
      id            SERIAL PRIMARY KEY,
      shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      mechanic_id   INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
      mech_name     TEXT,
      mech_avatar   TEXT,
      stock_item_id INTEGER REFERENCES stock_items(id) ON DELETE SET NULL,
      item_name     TEXT NOT NULL,
      qty           INTEGER NOT NULL,
      unit_value    NUMERIC DEFAULT 0,
      total_value   NUMERIC DEFAULT 0,
      crafted_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS material_contributions (
      id            SERIAL PRIMARY KEY,
      shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      mechanic_id   INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
      mech_name     TEXT NOT NULL,
      mech_avatar   TEXT,
      material_id   INTEGER REFERENCES materials(id) ON DELETE SET NULL,
      material_name TEXT NOT NULL,
      qty           INTEGER NOT NULL,
      contributed_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Readable PIN storage so Admin can view/manage PINs (low-stakes in-game PINs).
    -- The bcrypt 'pin' column is still used for authentication.
    ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS pin_plain TEXT;
    ALTER TABLE bosses    ADD COLUMN IF NOT EXISTS pin_plain TEXT;
  `);

  console.log('✅ Database tables ready');

  // Seed master prices from Unity Rejects pricelist (only if empty)
  await seedMasterPrices();

  // Seed additional businesses (Angels & Sons, Redline, …) — env-gated, idempotent
  await seedShops();

  // In-memory test mode: seed demo shops so the app is explorable immediately
  if (MEMORY_DB) await seedDemoData();
}

// ──────────────────────────────────────────────────────────────
//  MECHANIC CRAFTING — materials + craftable parts + recipes
//  (imported from the shop crafting config: asmechanic/redmechanic/lsc)
//  Each: [itemId, level, timeSecs, sellPrice, {material: qtyNeeded}, output]
// ──────────────────────────────────────────────────────────────
const CRAFT_MATERIALS = ['iron','steel','aluminum','copper','rubber','plastic','carbon','metalscrap','screwdriverset','piston'];
const CRAFT_RECIPES = [
  ['piston',               0,  20,       0, { iron:10 }, 'material'],
  ['repair_kit',           0,  20,   20000, { iron:10, steel:10, aluminum:10, piston:4 }, 'stock'],
  ['stage1',              10, 120,       0, { iron:30, plastic:20, steel:33, rubber:10, copper:15, aluminum:22, piston:4 }, 'stock'],
  ['stage2',              15, 120,       0, { iron:66, plastic:30, steel:40, rubber:15, copper:20, aluminum:35, piston:6 }, 'stock'],
  ['stage3',              20, 120,       0, { iron:75, plastic:44, steel:55, rubber:20, copper:30, aluminum:44, piston:8 }, 'stock'],
  ['turbo_lvl_1',         10, 120,  100000, { iron:50, aluminum:40, steel:20 }, 'stock'],
  ['turbo_lvl_2',         15, 120,  100000, { iron:60, aluminum:50, steel:30 }, 'stock'],
  ['turbo_lvl_3',         20, 120,  100000, { iron:70, aluminum:60, steel:40 }, 'stock'],
  ['twin_turbo',          30, 120, 1000000, { iron:1000, aluminum:1250, steel:1000, copper:1000, rubber:1000 }, 'stock'],
  ['slick_tyres',         10,  80,   50000, { steel:50, rubber:50 }, 'stock'],
  ['semi_slick_tyres',    10,  80,   50000, { steel:45, rubber:45 }, 'stock'],
  ['offroad_tyres',       10,  80,   50000, { steel:55, rubber:55 }, 'stock'],
  ['ceramic_brakes',      10,  80,   80000, { steel:55, carbon:55 }, 'stock'],
  ['awd_drivetrain',      15,  80,   80000, { iron:70, aluminum:60, steel:40, rubber:40 }, 'stock'],
  ['rwd_drivetrain',      15,  80,   80000, { iron:45, aluminum:33, steel:25, rubber:15 }, 'stock'],
  ['fwd_drivetrain',      15,  80,   80000, { iron:45, aluminum:33, steel:25, rubber:10 }, 'stock'],
  ['drift_tuning_kit',    15,  80,  100000, { iron:55, aluminum:44, steel:32, rubber:22, metalscrap:36 }, 'stock'],
  ['tyre_replacement',    15,  80,   50000, { steel:15, rubber:15 }, 'stock'],
  ['clutch_replacement',  15,  80,       0, { steel:15, rubber:15, copper:20 }, 'stock'],
  ['suspension_parts',    15,  80,       0, { steel:20, rubber:20, copper:25 }, 'stock'],
  ['brakepad_replacement',15,  80,       0, { steel:20, rubber:20, copper:25 }, 'stock'],
  ['ev_motor',            15,  80,       0, { steel:20, carbon:20 }, 'stock'],
  ['ev_battery',          15,  80,       0, { carbon:20 }, 'stock'],
  ['lighting_controller', 10,  80,   35000, { copper:20, plastic:55 }, 'stock'],
  ['stancing_kit',        10,  80,   20000, { copper:20, iron:55, plastic:55, steel:33 }, 'stock'],
  ['cosmetic_part',       10,  80,   35000, { copper:15, iron:20, plastic:66, steel:55, rubber:55 }, 'stock'],
  ['respray_kit',         10,  80,  100000, { aluminum:33, plastic:42 }, 'stock'],
  ['vehicle_wheels',      10,  80,   35000, { aluminum:33, plastic:42, rubber:55 }, 'stock'],
  ['tyre_smoke_kit',      10,  80,   35000, { steel:20, rubber:55 }, 'stock'],
  ['extras_kit',          10,  80,   35000, { screwdriverset:1, plastic:33, rubber:23 }, 'stock'],
  ['nitrous_bottle',      10,  80,   20000, { plastic:33, rubber:23, steel:23 }, 'stock'],
  ['empty_nitrous_bottle',10,  80,       0, { plastic:33, rubber:23, steel:23 }, 'stock'],
  ['nitrous_install_kit', 15,  80,   25000, { plastic:33, rubber:23, steel:33, screwdriverset:1 }, 'stock'],
];
function prettyName(id) {
  return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Seed a shop's materials, craftable parts and recipes (idempotent per shop)
async function seedCrafting(shopId) {
  // Materials with a healthy starting stock so crafting works out of the box
  const matId = {};
  for (const m of CRAFT_MATERIALS) {
    const startQty = m === 'piston' ? 60 : 1000;
    const r = await pool.query(
      'INSERT INTO materials (shop_id, name, quantity, unit, low_threshold) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [shopId, prettyName(m), startQty, 'units', 50]
    );
    matId[m] = r.rows[0].id;
  }
  // Craftable parts + their recipes
  for (const [itemId, level, timeSecs, price, ings, output] of CRAFT_RECIPES) {
    const si = await pool.query(
      'INSERT INTO stock_items (shop_id, name, quantity, price, craft_output) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [shopId, prettyName(itemId), 0, price, output]
    );
    const stockId = si.rows[0].id;
    await pool.query(
      `INSERT INTO craft_meta (shop_id, stock_item_id, craft_time_mins, craft_level) VALUES ($1,$2,$3,$4)
       ON CONFLICT (shop_id, stock_item_id) DO NOTHING`,
      [shopId, stockId, timeSecs, level]
    );
    for (const [mat, qty] of Object.entries(ings)) {
      if (!matId[mat]) continue;
      await pool.query(
        `INSERT INTO craft_recipes (shop_id, stock_item_id, material_id, qty_needed) VALUES ($1,$2,$3,$4)
         ON CONFLICT (stock_item_id, material_id) DO NOTHING`,
        [shopId, stockId, matId[mat], qty]
      );
    }
  }
}

// Demo content for the zero-setup in-memory test database.
// Boss PIN for every demo shop is 1234.
async function seedDemoData() {
  const demoHash = await bcrypt.hash('1234', 10);
  // Each shop has its OWN workers (distinct names + PINs) so staff are clearly shop-scoped.
  const shops = [
    { name:'Los Santos Customs', slug:'los-santos-customs', emoji:'🔧', c1:'#1a6fd4', c2:'#1558b0', logo:'lsc-logo.png',
      workers:[['Mike','🔧','1111'],['Tony','⚙️','2222'],['Sofia','🛠️','3333']] },
    { name:'Redline', slug:'redline', emoji:'🏁', c1:'#e01f26', c2:'#a8161b', logo:'redline-logo.png',
      workers:[['Ray','🔧','4444'],['Nina','⚙️','5555'],['Dex','🛠️','6666']] },
    { name:'Angels & Sons', slug:'angels-and-sons', emoji:'😇', c1:'#c62828', c2:'#8e1f1f', logo:'angels-and-sons-logo.png',
      workers:[['Gabe','🔧','7777'],['Lena','⚙️','8888'],['Marco','🛠️','9999']] },
  ];
  for (const s of shops) {
    const logo = loadLogoDataUrl(s.logo);
    const { rows } = await pool.query(
      `INSERT INTO shops (name, slug, boss_pin, theme_color, theme_color2, logo_emoji, logo_image)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [s.name, s.slug, demoHash, s.c1, s.c2, s.emoji, logo]
    );
    const shopId = rows[0].id;
    // a named boss (PIN 1234, readable for admin)
    await pool.query('INSERT INTO bosses (shop_id, name, avatar, pin, pin_plain) VALUES ($1,$2,$3,$4,$5)',
      [shopId, 'Boss', '👑', demoHash, '1234']);
    // this shop's own workers, each with their own PIN
    const w = [];
    for (const [mn, ma, mpin] of s.workers) {
      const h = await bcrypt.hash(mpin, 10);
      const r = await pool.query('INSERT INTO mechanics (shop_id, name, avatar, pin, pin_plain) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [shopId, mn, ma, h, mpin]);
      w.push({ id: r.rows[0].id, name: mn });
    }
    // a few sample orders across the board columns, assigned to this shop's workers
    const orders = [
      ['Sultan RS','ABC123','Tony Marconi', w[0].id, w[0].name,'inprogress',450000],
      ['Elegy RH8','RH8-99','Sarah Lin',    null,    null,      'pending',   120000],
      ['Comet S2','FAST01','Deposit',       w[1].id, w[1].name,'pending',    600000],
      ['Kuruma','KRM420','Big Mike',        w[2].id, w[2].name,'done',       80000],
      ['Banshee','BAN777','Jade Cross',     w[0].id, w[0].name,'done',       200000],
    ];
    for (const [veh,plate,player,mid,mname,status,price] of orders) {
      await pool.query(
        `INSERT INTO orders (shop_id, vehicle, plate, player, mechanic_id, mechanic_name, status, price, parts, done_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [shopId, veh, plate, player, mid, mname, status, price,
         JSON.stringify([{ name:'Full Stage 2', price }]),
         status === 'done' ? new Date() : null]
      );
    }
    // materials + craftable parts + recipes for this shop
    await seedCrafting(shopId);
  }
  console.log('✅ Seeded demo data (3 shops · boss PIN 1234 · distinct workers · crafting recipes)');
}

// Unity Rejects master pricelist — admin can edit/add via the app
const MASTER_PRICES = [
  // ── Full Stage 3 (AWD, Stage3 Turbo+Engine, Ceramic Brakes, Tyres) ──
  ['Full Stage 3 (0-500k)',   600000],
  ['Full Stage 3 (500k-1m)',  775000],
  ['Full Stage 3 (1m-1.5m)',  882500],
  ['Full Stage 3 (1.5m-2m)',  902500],
  ['Full Stage 3 (2m-2.5m)', 1012500],
  ['Full Stage 3 (2.5m-3m)', 1095000],
  ['Full Stage 3 (3m+)',     1230000],
  // ── Full Stage 2 ──
  ['Full Stage 2 (0-500k)',   470000],
  ['Full Stage 2 (500k-1m)',  565000],
  ['Full Stage 2 (1m-1.5m)',  625000],
  ['Full Stage 2 (1.5m-2m)',  660000],
  ['Full Stage 2 (2m-2.5m)',  700000],
  ['Full Stage 2 (2.5m-3m)',  750000],
  ['Full Stage 2 (3m+)',      870000],
  // ── Full Stage 1 ──
  ['Full Stage 1 (0-500k)',   350000],
  ['Full Stage 1 (500k-1m)',  380000],
  ['Full Stage 1 (1m-1.5m)',  410000],
  ['Full Stage 1 (1.5m-2m)',  430000],
  ['Full Stage 1 (2m-2.5m)',  450000],
  ['Full Stage 1 (2.5m-3m)',  470000],
  ['Full Stage 1 (3m+)',      490000],
  // ── Flat-rate Full Stage 3 ──
  ['PD/EMS (Full Stage 3 flat)',     400000],
  ['Gangs (Full Stage 3 flat)',      600000],
  ['First Help (Full Stage 3 flat)', 600000],
  ['Pick a Build (Stage 3 min)',     600000],
  // ── Loose Parts ──
  ['Stage 3 Turbo',          100000],
  ['Stage 3 Engine',         100000],
  ['Stage 2 Turbo',          100000],
  ['Stage 2 Engine',         100000],
  ['Stage 1 Turbo',          100000],
  ['Stage 1 Engine',         100000],
  ['Transmission (AWD/RWD/FWD/Race/Drift)', 80000],
  ['Ceramic Brakes',          80000],
  ['Tyres',                   50000],
  ['Twin Turbo',            1000000],
  ['NOS',                     20000],
  ['Nitrous Install Kit',     25000],
  ['Drift Tuning Kit',       100000],
  ['Engine Swap',            100000],
  // ── Cosmetics ──
  ['Paint Layer (per layer)', 100000],
  ['Wheel Smoke',             35000],
  ['Head Lights',             35000],
  ['Under Glow',              35000],
  ['Window Tint',             35000],
  ['Stance Kit',              20000],
  ['Body Parts (per part)',   35000],
  ['Wheel Change (per set)',  35000],
  ['Extras',                  35000],
  ['Repair Kit',              20000],
  // ── Towing & Services ──
  ['Callout Fee',             20000],
  ['In City Tow',             30000],
  ['Out of City Tow',         40000],
  ['EMS/PD In City',          15000],
  ['EMS/PD Out of City',      20000],
  ['Heli Recovery In City',   50000],
  ['Heli Recovery Out of City', 100000],
  // ── Buying (from citizens) ──
  ['Refined Materials (buy)',    75],
  ['Recycle Boxes (buy)',       500],
  ['Stone (buy)',               500],
  // ── Selling — Tools ──
  ['Blow Torch (sell)',        2500],
  ['Cutter (sell)',           10000],
  ['Grinder (sell)',          10000],
  ['Drill (sell)',            10000],
  // ── Selling — Materials ──
  ['Cloth (sell)',              200],
  ['Refined Materials (sell)',  225],
  ['Recycling Boxes (sell)',    750],
  ['Stone (sell)',              750],
];

async function seedMasterPrices() {
  const { rows } = await pool.query('SELECT COUNT(*) FROM master_prices');
  if (parseInt(rows[0].count) > 0) return; // already seeded

  for (const [name, price] of MASTER_PRICES) {
    await pool.query(
      'INSERT INTO master_prices (name, price) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [name, price]
    );
  }
  console.log(`✅ Seeded ${MASTER_PRICES.length} master prices from Unity Rejects pricelist`);
}

// ──────────────────────────────────────────────────────────────
//  BUSINESS / SHOP SEEDING
//  Each shop is a tenant. These are auto-created on startup IF their
//  boss-PIN env var is set (so no secrets live in source). Already
//  existing shops (matched by slug) are left untouched — safe to
//  redeploy. Drop logo PNGs into public/assets and set the env vars.
// ──────────────────────────────────────────────────────────────
const SEED_SHOPS = [
  {
    name:   'Los Santos Customs',          // ← confirm exact display name
    slug:   'los-santos-customs',
    emoji:  '🔧',
    color:  '#1a6fd4',                     // primary (LSC blue)
    color2: '#1558b0',                     // secondary
    logoFile: 'lsc-logo.png',              // place in public/assets/
    pinEnv: 'LSC_BOSS_PIN',
  },
  {
    name:   'Redline',                     // ← confirm exact display name
    slug:   'redline',
    emoji:  '🏁',
    color:  '#ff3b30',                     // primary (red) — adjust to brand
    color2: '#b61f17',                     // secondary (darker red)
    logoFile: 'redline-logo.png',          // place in public/assets/
    pinEnv: 'REDLINE_BOSS_PIN',            // set this env var to enable seeding
  },
  {
    name:   'Angels & Sons',               // ← confirm exact display name
    slug:   'angels-and-sons',
    emoji:  '😇',
    color:  '#4fa8e8',                     // primary — adjust to brand
    color2: '#2f6fb0',                     // secondary
    logoFile: 'angels-and-sons-logo.png',  // place in public/assets/
    pinEnv: 'ANGELS_BOSS_PIN',
  },
];

// Read a logo file from public/assets and return it as a base64 data URL
function loadLogoDataUrl(logoFile) {
  if (!logoFile) return null;
  try {
    const p = path.join(__dirname, '..', 'public', 'assets', logoFile);
    if (!fs.existsSync(p)) return null;
    const ext = path.extname(logoFile).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch (e) {
    console.warn(`⚠️  Could not read logo ${logoFile}: ${e.message}`);
    return null;
  }
}

async function seedShops() {
  for (const s of SEED_SHOPS) {
    const pin = process.env[s.pinEnv];
    if (!pin) {
      console.log(`↷ Skipping seed for "${s.name}" — set ${s.pinEnv} to create it.`);
      continue;
    }
    // Already created? Leave it alone.
    const { rows } = await pool.query('SELECT id FROM shops WHERE slug=$1', [s.slug]);
    if (rows.length) continue;

    const hash = await bcrypt.hash(pin, 10);
    const logo = loadLogoDataUrl(s.logoFile);
    const ins = await pool.query(
      `INSERT INTO shops (name, slug, boss_pin, theme_color, theme_color2, logo_emoji, logo_image)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [s.name, s.slug, hash, s.color, s.color2, s.emoji, logo]
    );
    if (!ins.rows.length) continue; // created concurrently
    const shopId = ins.rows[0].id;
    // a named boss (admin can see/change this PIN) + this shop's craftable parts, materials & recipes
    await pool.query('INSERT INTO bosses (shop_id, name, avatar, pin, pin_plain) VALUES ($1,$2,$3,$4,$5)',
      [shopId, 'Boss', '👑', hash, pin]);
    await seedCrafting(shopId);
    console.log(`✅ Seeded shop "${s.name}"${logo ? ' (with logo)' : ''} + boss + crafting`);
  }
}

module.exports = { pool, initDb, MEMORY_DB };
