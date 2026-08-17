require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

function safeErrorMessage(error, fallback = 'Request failed') {
  if (isProduction) return fallback;
  return error && error.message ? error.message : fallback;
}

function isDebugEnabled() {
  return !isProduction;
}

// ============================================================
// PAYFAST SANDBOX / LIVE MODE SWITCHER
// Set PAYFAST_SANDBOX=true in .env or toggle from admin panel
// Live credentials are always kept in .env - never overwritten
// ============================================================
let payfastSandboxMode = process.env.PAYFAST_SANDBOX === 'true';

const PAYFAST_LIVE_CONFIG = {
  merchantId:  process.env.PAYFAST_MERCHANT_ID  || '18906399',
  merchantKey: process.env.PAYFAST_MERCHANT_KEY || 'fbxpiwtzoh1gg',
  passphrase:  process.env.PAYFAST_PASSPHRASE   || 'RokCupZA2024',
  processUrl:  'https://www.payfast.co.za/eng/process'
};

// PayFast sandbox credentials are fixed/public - safe to hardcode
// Sandbox passphrase from PayFast docs: https://developers.payfast.co.za/docs#test_transaction_setup
const PAYFAST_SANDBOX_CONFIG = {
  merchantId:  '10000100',
  merchantKey: '46f0cd694581a',
  passphrase:  'jt7NOE43FZPn',
  processUrl:  'https://sandbox.payfast.co.za/eng/process'
};

function getPayFastConfig() {
  return payfastSandboxMode ? PAYFAST_SANDBOX_CONFIG : PAYFAST_LIVE_CONFIG;
}
// ============================================================

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { Pool } = require('pg');
const bcryptjs = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const webpush = require('web-push');
const multer = require('multer');
const adminNotificationQueue = require('./adminNotificationQueue');
// Fix #16: Input validation middleware
const { validateBody, loginSchema, registerDriverSchema, raceEntrySchema } = require('./middleware/validate');

// ─── Excel export & QR code generation ───────────────────────────────────────
const ExcelJS = require('exceljs');
const QRCode  = require('qrcode');
// ─── Z1 / S3-compatible storage ───────────────────────────────────────────────
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({
  endpoint: process.env.Z1_ENDPOINT || 'https://s3.z1storage.com',
  region: 'us-east-1',           // z1storage ignores region but SDK requires a value
  credentials: {
    accessKeyId:     process.env.Z1_ACCESS_KEY,
    secretAccessKey: process.env.Z1_SECRET_KEY
  },
  forcePathStyle: true           // required for non-AWS S3-compatible providers
});
const Z1_BUCKET    = process.env.Z1_BUCKET || 'ftw-media';
const Z1_BASE_URL  = `${process.env.Z1_ENDPOINT || 'https://s3.z1storage.com'}/${Z1_BUCKET}`;
// ──────────────────────────────────────────────────────────────────────────────

const app = express();
const path = require('path');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

// Fix #11: Exact MIME type whitelist instead of substring regex
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'application/pdf'];
    const allowedExtensions = /\.(jpeg|jpg|png|gif|pdf)$/i;
    const extValid = allowedExtensions.test(path.extname(file.originalname));
    const mimeValid = allowedMimeTypes.includes(file.mimetype);
    if (extValid && mimeValid) {
      return cb(null, true);
    }
    cb(new Error('Only images (JPEG, PNG, GIF) and PDF files are allowed'));
  }
});

// Configure web push
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:admin@rokcup.co.za',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Fix #9: Restrict CORS to known origins only
const allowedOrigins = [
  'https://www.rokthenats.co.za',
  'https://rokthenats.co.za',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500', // Live Server for local dev
];
// Allow any LAN IP on port 3000 (race day tablet/phone access on local network)
const lanOriginPattern = /^http:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+):3000$/;
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, PayFast webhooks, Render health checks)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Allow any private LAN IP — covers race day devices on local network
    if (lanOriginPattern.test(origin)) return callback(null, true);
    callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token', 'x-checkpoint-pin']
}));
// Security headers (CSP disabled to allow inline scripts in admin SPA)
app.use(helmet({ contentSecurityPolicy: false }));
// Gzip compression — reduces API + HTML payload size ~3-5x on slow mobile connections
// SSE streams must be excluded: compression buffers output, breaking live event delivery
app.use(compression({
  filter: (req, res) => {
    if (res.getHeader('Content-Type') === 'text/event-stream') return false;
    return compression.filter(req, res);
  }
}));
// Fix #10: Reduce JSON body limit from 50mb to 5mb
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Fix #18: Request logging middleware (method, path, status, duration)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? '❌' : res.statusCode >= 400 ? '⚠️' : '✅';
    console.log(`${level} ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Serve static files from images directory
app.use('/images', express.static(path.join(__dirname, 'images')));

// =========================================================
// ADMIN AUTHENTICATION - Server-side token system
// =========================================================

// Token store: token -> { expires: Date, source? }
const adminTokens = new Map();

// Persist tokens to disk so sessions survive server restarts
const ADMIN_TOKENS_FILE = path.join(__dirname, 'data', 'admin-tokens.json');

function saveAdminTokens() {
  const now = Date.now();
  const obj = {};
  for (const [token, data] of adminTokens.entries()) {
    if (data.expires > now) obj[token] = data;
  }
  try { fs.writeFileSync(ADMIN_TOKENS_FILE, JSON.stringify(obj), 'utf8'); }
  catch (e) { console.warn('⚠️  Could not save admin tokens:', e.message); }
}

function loadAdminTokens() {
  try {
    if (fs.existsSync(ADMIN_TOKENS_FILE)) {
      const obj = JSON.parse(fs.readFileSync(ADMIN_TOKENS_FILE, 'utf8'));
      const now = Date.now();
      for (const [token, data] of Object.entries(obj)) {
        if (data.expires > now) adminTokens.set(token, data);
      }
      console.log(`🔑 Loaded ${adminTokens.size} active admin session(s) from disk`);
    }
  } catch (e) { console.warn('⚠️  Could not load admin tokens:', e.message); }
}
loadAdminTokens();

// Clean up expired tokens every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of adminTokens.entries()) {
    if (data.expires < now) adminTokens.delete(token);
  }
  saveAdminTokens();
}, 60 * 60 * 1000);

// =========================================================
// LOGIN RATE LIMITING - Brute force protection
// =========================================================
const loginAttempts = new Map(); // ip -> { count, blockedUntil }
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.blockedUntil && now < entry.blockedUntil) {
    const mins = Math.ceil((entry.blockedUntil - now) / 60000);
    return { allowed: false, message: `Too many failed attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.` };
  }
  return { allowed: true };
}

function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip) || { count: 0 };
  entry.count += 1;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    entry.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
    entry.count = 0;
    console.warn(`⛔ Login rate limit hit for IP: ${ip}`);
  }
  loginAttempts.set(ip, entry);
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// Clean up login attempts map every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts.entries()) {
    if (!data.blockedUntil || data.blockedUntil < now) loginAttempts.delete(ip);
  }
}, 60 * 60 * 1000);

// Permanent token for ROKControl scanner devices (never expires)
const ROKCONTROL_DEVICE_TOKEN = '0298423f-ab4b-4a48-abad-31a3e72dc463';

// Middleware to protect admin routes
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) {
    return res.status(401).json({ success: false, error: 'Admin authentication required' });
  }
  // Allow permanent ROKControl device token
  if (token === ROKCONTROL_DEVICE_TOKEN) return next();
  const session = adminTokens.get(token);
  if (!session || session.expires < Date.now()) {
    adminTokens.delete(token);
    saveAdminTokens();
    return res.status(401).json({ success: false, error: 'Session expired or invalid' });
  }
  next();
}

// Admin login endpoint
app.post('/api/admin/login', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  const rateCheck = checkLoginRateLimit(clientIp);
  if (!rateCheck.allowed) {
    return res.status(429).json({ success: false, error: rateCheck.message });
  }
  const { password } = req.body;
  const adminSecret = process.env.ADMIN_SECRET || 'natsadmin2026';
  if (!password || password !== adminSecret) {
    recordFailedLogin(clientIp);
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }
  clearLoginAttempts(clientIp);
  const token = uuidv4();
  adminTokens.set(token, { expires: Date.now() + 8 * 60 * 60 * 1000 }); // 8 hour session
  saveAdminTokens();
  console.log(`✅ Admin login successful - session created`);
  res.json({ success: true, token });
});

// Admin token verify endpoint (for page reload checks)
app.get('/api/admin/verify', (req, res) => {
  const token = req.headers['x-admin-token'];
  const session = token ? adminTokens.get(token) : null;
  const valid = !!(session && session.expires > Date.now());
  res.json({ success: true, valid });
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token) { adminTokens.delete(token); saveAdminTokens(); }
  res.json({ success: true });
});

// Titan terminal login — authenticates with TITAN_PASSWORD and returns an admin-scoped token
app.post('/api/titan/login', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  const rateCheck = checkLoginRateLimit(clientIp);
  if (!rateCheck.allowed) {
    return res.status(429).json({ success: false, error: rateCheck.message });
  }
  const { password } = req.body;
  const titanPassword = process.env.TITAN_PASSWORD || 'titan2026';
  if (!password || password !== titanPassword) {
    recordFailedLogin(clientIp);
    return res.status(401).json({ success: false, error: 'Invalid access code' });
  }
  clearLoginAttempts(clientIp);
  const token = uuidv4();
  adminTokens.set(token, { expires: Date.now() + 12 * 60 * 60 * 1000, source: 'titan' }); // 12 hour session
  saveAdminTokens();
  console.log('✅ Titan terminal login — session created');
  res.json({ success: true, token });
});

// =========================================================
// ADMIN ROUTE PROTECTION
// All routes below that are admin-only are guarded by
// requireAdmin middleware. Public/driver routes are NOT listed.
// =========================================================
const ADMIN_ONLY_PATHS = [
  '/api/getAllDrivers',
  '/api/getAllPayments',
  '/api/getDatabaseTable',
  '/api/getAdminMessages',
  '/api/markMessageAsRead',
  '/api/getDiscountCodes',
  '/api/createDiscountCode',
  '/api/updateDiscountCode',
  '/api/deleteDiscountCode',
  '/api/adminAddRaceEntry',
  '/api/allRaceEntries',
  '/api/getRaceEntries',
  '/api/updateRaceEntry',
  '/api/deleteRaceEntry',
  '/api/updateDriver',
  '/api/downloadDriverFile',
  '/api/sendPasswordReset',
  '/api/sendRaceTicketsEmail',
  '/api/updateAndResendTickets',
  '/api/createEvent',
  '/api/updateEvent',
  '/api/deleteEvent',
  '/api/getAllEvents',
  '/api/getEventRegistrations',
  '/api/saveEventPricing',
  '/api/sendEntryToTrello',
  '/api/markPaymentReceived',
  '/api/getAuditLog',
  '/api/exportAuditCSV',
  '/api/exportRaceEntriesCSV',
  '/api/exportFinancialReportCSV',
  '/api/exportDriversCSV',
  '/api/push/stats',
  '/api/push/subscribers',
  '/api/push/send',
  '/api/payfast/reconcile',
  '/api/payfast/reprocess',
  '/api/confirmRaceEntry',
  // Debug/diagnostic endpoints - admin only
  '/api/debug-env',
  '/api/check-schema',
  '/api/test-db',
  '/api/create-test-driver',
  '/api/scanners',
  '/api/poolEngines',
];

app.use((req, res, next) => {
  // Protect all /api/admin/* except the auth endpoints themselves
  if (req.path.startsWith('/api/admin/') &&
      req.path !== '/api/admin/login' &&
      req.path !== '/api/admin/verify' &&
      req.path !== '/api/admin/logout') {
    return requireAdmin(req, res, next);
  }
  // Protect all /api/debug/* routes
  if (req.path.startsWith('/api/debug/')) {
    return requireAdmin(req, res, next);
  }
  // Protect scanner management (list, add, delete)
  if (req.path === '/api/scanners' || req.path.startsWith('/api/scanners/')) {
    return requireAdmin(req, res, next);
  }
  // Protect pool engine management
  if (req.path === '/api/poolEngines' || req.path.startsWith('/api/poolEngines/')) {
    return requireAdmin(req, res, next);
  }
  // Protect specific non-/admin/-prefixed admin-only routes
  if (ADMIN_ONLY_PATHS.includes(req.path)) {
    return requireAdmin(req, res, next);
  }
  next();
});

// =========================================================
// GLOBAL ERROR HANDLERS - Prevent server crashes
// =========================================================
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
  // Don't exit - keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION at:', promise);
  console.error('Reason:', reason);
  // Don't exit - keep server running
});

// Database connection with error handling
const useSSL = process.env.DB_SSL !== 'false';
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  // Connection pool settings for stability
  max: useSSL ? 20 : 10,      // Local laptop: keep pool small
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 5000  // Fail fast if can't connect in 5s
});

// Handle pool errors to prevent crashes
pool.on('error', (err, client) => {
  console.error('❌ PostgreSQL pool error:', err.message);
  // Don't crash - pool will try to reconnect
});

// ── Race-day offline sync worker (only in local mode: DB_SSL=false) ──────────
let lastSyncTime = Date.now();
if (process.env.DB_SSL === 'false') {
  const { Pool: CloudPool } = require('pg');
  const cloudPool = new CloudPool({
    host: process.env.CLOUD_DB_HOST,
    port: parseInt(process.env.CLOUD_DB_PORT || '6432'),
    database: process.env.CLOUD_DB_DATABASE,
    user: process.env.CLOUD_DB_USERNAME,
    password: process.env.CLOUD_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,    // release idle connections before PlanetScale kills them
    keepAlive: true               // TCP keepalive to prevent silent drops
  });

  // Ensure sync_queue table exists
  pool.query(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id         SERIAL PRIMARY KEY,
      table_name VARCHAR(100) NOT NULL,
      operation  VARCHAR(10)  NOT NULL,
      row_id     VARCHAR(255) NOT NULL,
      payload    JSONB        NOT NULL,
      created_at TIMESTAMP    DEFAULT NOW(),
      synced_at  TIMESTAMP,
      attempts   INT          DEFAULT 0
    )
  `).catch(e => console.warn('[sync] Could not create sync_queue:', e.message));

  // Push: flush local writes to cloud every 30 seconds
  setInterval(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM sync_queue WHERE synced_at IS NULL AND attempts < 5 ORDER BY created_at LIMIT 50`
      );
      if (!rows.length) return;
      let synced = 0;
      for (const item of rows) {
        try {
          const cols   = Object.keys(item.payload);
          const vals   = cols.map(c => item.payload[c]);
          const ph     = cols.map((_, i) => `$${i + 1}`).join(',');
          const update = cols.map(c => `${c} = EXCLUDED.${c}`).join(', ');
          await cloudPool.query(
            `INSERT INTO ${item.table_name} (${cols.join(',')}) VALUES (${ph}) ON CONFLICT (id) DO UPDATE SET ${update}`,
            vals
          );
          await pool.query(`UPDATE sync_queue SET synced_at = NOW() WHERE id = $1`, [item.id]);
          synced++;
        } catch {
          await pool.query(`UPDATE sync_queue SET attempts = attempts + 1 WHERE id = $1`, [item.id]);
        }
      }
      if (synced > 0) { lastSyncTime = Date.now(); console.log(`[sync] Flushed ${synced} rows to cloud`); }
    } catch { /* Cloud unreachable — retry in 30s */ }
  }, 30_000);

  // Serialize objects/arrays to JSON strings so pg passes them correctly to JSONB columns.
  // Without this, pg may pass a JS array as a PostgreSQL array literal, which PostgreSQL
  // rejects with "invalid input syntax for type json".
  function pgVals(row, cols) {
    return cols.map(c => {
      const v = row[c];
      if (v !== null && v !== undefined && typeof v === 'object') return JSON.stringify(v);
      return v;
    });
  }

  // Helper: upsert all rows from a cloud table into the local DB (column-safe)
  async function syncTableFromCloud(tableName, pkCol, localClient) {
    const { rows: localColRows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND table_schema='public'`,
      [tableName]
    );
    const localCols = new Set(localColRows.map(r => r.column_name));
    const { rows } = await cloudPool.query(`SELECT * FROM ${tableName}`);
    if (!rows.length) return 0;
    const safeCols = Object.keys(rows[0]).filter(c => localCols.has(c));
    if (!safeCols.includes(pkCol)) return 0;
    let count = 0;
    for (const row of rows) {
      const vals = pgVals(row, safeCols);
      const ph   = safeCols.map((_, i) => `$${i + 1}`).join(',');
      const upd  = safeCols.filter(c => c !== pkCol).map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
      try {
        await localClient.query(
          `INSERT INTO ${tableName} (${safeCols.map(c=>`"${c}"`).join(',')}) VALUES (${ph}) ON CONFLICT (${pkCol}) DO UPDATE SET ${upd}`,
          vals
        );
        count++;
      } catch { /* skip bad row */ }
    }
    return count;
  }

  // Pull entries (and their prerequisites) from cloud.
  // TRUNCATEs race_entries first to wipe any stale/partial data, then re-inserts
  // with FK triggers disabled (session_replication_role = replica).
  // Note: unique constraints are still enforced even with replica role, so TRUNCATE
  // is essential to avoid payment_reference / unique_driver_event_payment conflicts.
  async function pullEntriesFromCloud() {
    const localClient = await pool.connect();
    let pulled = 0;
    try {
      await localClient.query('SET session_replication_role = replica');

      // Upsert events, drivers, contacts first (parents before children)
      await syncTableFromCloud('events',  'event_id',  localClient);
      await syncTableFromCloud('drivers', 'driver_id', localClient);
      await syncTableFromCloud('contacts','driver_id', localClient);

      // Wipe race_entries completely before re-inserting — eliminates all unique
      // constraint conflicts (payment_reference, unique_driver_event_payment etc.)
      await localClient.query('TRUNCATE TABLE race_entries CASCADE');

      // Fetch all race_entries from last 30 days and insert fresh
      const { rows: localColRows } = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='race_entries' AND table_schema='public'`
      );
      const localCols = new Set(localColRows.map(r => r.column_name));
      const { rows } = await cloudPool.query(
        `SELECT * FROM race_entries WHERE created_at > NOW() - INTERVAL '30 days'`
      );
      if (rows.length) {
        const safeCols = Object.keys(rows[0]).filter(c => localCols.has(c));
        if (safeCols.includes('entry_id')) {
          let firstErr = null;
          for (const row of rows) {
            const vals = pgVals(row, safeCols);
            const ph   = safeCols.map((_, i) => `$${i + 1}`).join(',');
            try {
              await localClient.query(
                `INSERT INTO race_entries (${safeCols.map(c=>`"${c}"`).join(',')}) VALUES (${ph})`,
                vals
              );
              pulled++;
            } catch (e) {
              if (!firstErr) { firstErr = e.message; }
            }
          }
          if (firstErr) console.warn('[sync] ⚠️  Some race_entries rows failed:', firstErr);
        }
      }
    } finally {
      await localClient.query('SET session_replication_role = DEFAULT');
      localClient.release();
    }
    return pulled;
  }

  // Pull every 60 seconds
  setInterval(async () => {
    try {
      const pulled = await pullEntriesFromCloud();
      if (pulled > 0) { lastSyncTime = Date.now(); console.log(`[sync] Pulled ${pulled} entries from cloud`); }
    } catch { /* Cloud unreachable — retry in 60s */ }
  }, 60_000);

  // Also pull immediately on startup (don't wait 60s for first sync)
  setTimeout(async () => {
    try {
      const pulled = await pullEntriesFromCloud();
      console.log(`[sync] ⬇️  Initial pull: ${pulled} entries synced from cloud`);
      if (pulled > 0) lastSyncTime = Date.now();
    } catch (e) { console.log('[sync] Initial pull failed (no internet?):', e.message); }
  }, 5_000); // 5 seconds after startup — schema init will be done by then

  // Admin endpoint to trigger a manual sync pull immediately
  app.post('/api/admin/syncNow', requireAdmin, async (req, res) => {
    try {
      const pulled = await pullEntriesFromCloud();
      lastSyncTime = Date.now();
      console.log(`[sync] Manual pull triggered: ${pulled} entries synced`);
      res.json({ success: true, pulled, message: `${pulled} entries synced from cloud` });
    } catch (e) {
      res.status(503).json({ success: false, error: 'Cloud unreachable: ' + e.message });
    }
  });

  // Push local offline data (engine draws + race_entries engine fields) to cloud.
  // Designed for end-of-day sync after running offline on the raceday laptop.
  async function pushEngineDataToCloud() {
    let drawsPushed = 0, drawsUpdated = 0, entriesUpdated = 0;

    // ── 1. entry_engine_draws ──────────────────────────────────────────────
    const { rows: localDraws } = await pool.query(
      `SELECT entry_id, engine_serial, draw_number, day_label, assigned_at,
              returned, returned_at, engine_issue, replaced_by, notes
       FROM entry_engine_draws ORDER BY assigned_at`
    );

    for (const row of localDraws) {
      // Insert only if cloud has no record for the same driver + engine + day
      const ins = await cloudPool.query(
        `INSERT INTO entry_engine_draws
           (entry_id, engine_serial, draw_number, day_label, assigned_at,
            returned, returned_at, engine_issue, replaced_by, notes)
         SELECT $1::text, $2::text, $3::int, $4::text, $5::timestamptz,
                $6::boolean, $7::timestamptz, $8::text, $9::text, $10::text
         WHERE NOT EXISTS (
           SELECT 1 FROM entry_engine_draws
           WHERE entry_id = $1
             AND UPPER(engine_serial) = UPPER($2)
             AND (
               ($4::text IS NOT NULL AND day_label = $4::text)
               OR ($4::text IS NULL AND assigned_at::date = $5::timestamptz::date)
             )
         )`,
        [row.entry_id, row.engine_serial, row.draw_number, row.day_label,
         row.assigned_at, row.returned, row.returned_at, row.engine_issue,
         row.replaced_by, row.notes]
      );
      if (ins.rowCount > 0) {
        drawsPushed++;
      } else if (row.returned) {
        // Row already exists in cloud — update returned status
        const upd = await cloudPool.query(
          `UPDATE entry_engine_draws
           SET returned = $3, returned_at = $4, engine_issue = $5
           WHERE entry_id = $1
             AND UPPER(engine_serial) = UPPER($2)
             AND returned = false`,
          [row.entry_id, row.engine_serial, row.returned, row.returned_at, row.engine_issue]
        );
        if (upd.rowCount > 0) drawsUpdated++;
      }
    }

    // ── 2. race_entries — engine columns only ─────────────────────────────
    const { rows: localEntries } = await pool.query(
      `SELECT entry_id, engine_serial, engine_assigned_at, engine_returned, engine_returned_at
       FROM race_entries WHERE engine_serial IS NOT NULL`
    );
    for (const row of localEntries) {
      const upd = await cloudPool.query(
        `UPDATE race_entries
         SET engine_serial       = $2,
             engine_assigned_at  = $3,
             engine_returned     = $4,
             engine_returned_at  = $5,
             updated_at          = NOW()
         WHERE entry_id = $1`,
        [row.entry_id, row.engine_serial, row.engine_assigned_at,
         row.engine_returned, row.engine_returned_at]
      );
      if (upd.rowCount > 0) entriesUpdated++;
    }

    return { drawsPushed, drawsUpdated, entriesUpdated };
  }

  // Admin endpoint — manual push of offline engine data to cloud
  app.post('/api/admin/pushOfflineData', requireAdmin, async (req, res) => {
    try {
      const result = await pushEngineDataToCloud();
      lastSyncTime = Date.now();
      console.log(`[sync] Manual push: ${result.drawsPushed} draws inserted, ${result.drawsUpdated} updated, ${result.entriesUpdated} entries updated`);
      res.json({ success: true, ...result, message: `${result.drawsPushed} draws pushed, ${result.entriesUpdated} entries updated` });
    } catch (e) {
      console.error('[sync] ❌ Manual push failed:', e.message, e.stack);
      res.status(503).json({ success: false, error: 'Cloud unreachable: ' + e.message });
    }
  });

  // Auto-push offline engine data every 2 minutes (kicks in when internet reconnects)
  setInterval(async () => {
    try {
      const result = await pushEngineDataToCloud();
      if (result.drawsPushed > 0 || result.drawsUpdated > 0 || result.entriesUpdated > 0) {
        lastSyncTime = Date.now();
        console.log(`[sync] Auto-pushed offline data: ${result.drawsPushed} draws, ${result.entriesUpdated} entries`);
      }
    } catch { /* Cloud unreachable — retry in 2min */ }
  }, 120_000);

  console.log('[sync] 🏁 Race-day sync worker active (push 30s / pull 60s + engine push 2min)');
}

// Sync status endpoint (local mode only)
// GET /api/syncStatus
// Initialize audit log table if it doesn't exist
const initAuditTable = async () => {
  try {
    // First create table with new schema if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        driver_id VARCHAR(255),
        driver_email VARCHAR(255),
        action VARCHAR(255),
        field_name VARCHAR(255),
        old_value TEXT,
        new_value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(50)
      )
    `);
    
    // Then add created_at column if it doesn't exist (migration for existing tables)
    await pool.query(`
      ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);
    
    // Drop old timestamp column if it exists (keep data migration safe)
    try {
      await pool.query(`ALTER TABLE audit_log DROP COLUMN IF EXISTS timestamp`);
    } catch (e) {
      // Column might not exist, that's fine
    }
    
    console.log('✅ Audit log table initialized');
  } catch (err) {
    console.error('Audit table init error:', err.message);
  }
};

// Initialize admin messages table if it doesn't exist
const initMessagesTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_messages (
        id SERIAL PRIMARY KEY,
        driver_id VARCHAR(255),
        driver_name VARCHAR(255),
        driver_email VARCHAR(255),
        registered_email VARCHAR(255),
        driver_phone VARCHAR(20),
        subject VARCHAR(255),
        message TEXT,
        read_status BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add registered_email column if it doesn't exist
    await pool.query(`
      ALTER TABLE admin_messages
      ADD COLUMN IF NOT EXISTS registered_email VARCHAR(255)
    `);
  } catch (err) {
    console.error('Messages table init error:', err.message);
  }
};

// Initialize notification history table if it doesn't exist
const initNotificationHistoryTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_history (
        id SERIAL PRIMARY KEY,
        driver_id VARCHAR(255),
        event_id VARCHAR(255),
        event_name VARCHAR(255),
        title VARCHAR(500) NOT NULL,
        body TEXT,
        url VARCHAR(500),
        notification_type VARCHAR(50) DEFAULT 'general',
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Notification history table initialized');
  } catch (err) {
    console.error('Notification history table init error:', err.message);
  }
};

// Initialize events table if it doesn't exist
const initEventsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        event_id VARCHAR(255) PRIMARY KEY,
        event_name VARCHAR(255) NOT NULL,
        event_date DATE NOT NULL,
        start_date DATE,
        end_date DATE,
        location VARCHAR(255),
        registration_deadline DATE,
        entry_fee DECIMAL(10, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);    
    
    // Add start_date, end_date and registration_open columns if they don't exist
    await pool.query(`
      ALTER TABLE events
      ADD COLUMN IF NOT EXISTS start_date DATE,
      ADD COLUMN IF NOT EXISTS end_date DATE,
      ADD COLUMN IF NOT EXISTS registration_open BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS national_only BOOLEAN DEFAULT false
    `);

    // Auto-flag known national-only events (Autumn NATS is nationals only, no regional option)
    await pool.query(`
      UPDATE events SET national_only = true
      WHERE LOWER(event_name) LIKE '%autumn%' AND national_only = false
    `);

    console.log('✅ Events table initialized with start/end date columns');
  } catch (err) {
    console.error('Events table init error:', err.message);
  }
};

// Initialize race entries table if it doesn't exist
const initRaceEntriesTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS race_entries (
        entry_id VARCHAR(255) PRIMARY KEY,
        event_id VARCHAR(255) NOT NULL,
        driver_id VARCHAR(255) NOT NULL,
        entry_fee DECIMAL(10, 2),
        amount_paid DECIMAL(10, 2),
        payment_reference VARCHAR(255) UNIQUE,
        payment_status VARCHAR(100),
        entry_status VARCHAR(100),
        race_class VARCHAR(100),
        entry_items JSONB DEFAULT '[]',
        transponder_selection VARCHAR(255),
        tyres_ordered BOOLEAN DEFAULT FALSE,
        wets_ordered BOOLEAN DEFAULT FALSE,
        team_code VARCHAR(50),
        engine INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (event_id) REFERENCES events(event_id),
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
      )
    `);

    // Migration: add race_class and entry_items if missing from existing installs
    await pool.query(`
      ALTER TABLE race_entries
      ADD COLUMN IF NOT EXISTS race_class VARCHAR(100),
      ADD COLUMN IF NOT EXISTS entry_items JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS race_days VARCHAR(50) DEFAULT 'Saturday'
    `);

    // Migration: rename race_entry_id -> entry_id on existing installs
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='race_entries' AND column_name='race_entry_id'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='race_entries' AND column_name='entry_id'
        ) THEN
          ALTER TABLE race_entries RENAME COLUMN race_entry_id TO entry_id;
        END IF;
      END $$
    `);

    // Add engine column if it doesn't exist
    await pool.query(`
      ALTER TABLE race_entries
      ADD COLUMN IF NOT EXISTS engine INT DEFAULT 0
    `);

    // Add team_code column if it doesn't exist
    await pool.query(`
      ALTER TABLE race_entries
      ADD COLUMN IF NOT EXISTS team_code VARCHAR(50)
    `);

    // Add unique ticket reference columns for validation
    await pool.query(`
      ALTER TABLE race_entries
      ADD COLUMN IF NOT EXISTS ticket_engine_ref VARCHAR(100),
      ADD COLUMN IF NOT EXISTS ticket_tyres_ref VARCHAR(100),
      ADD COLUMN IF NOT EXISTS ticket_transponder_ref VARCHAR(100),
      ADD COLUMN IF NOT EXISTS ticket_fuel_ref VARCHAR(100)
    `);

    // Add engine management columns
    await pool.query(`
      ALTER TABLE race_entries
      ADD COLUMN IF NOT EXISTS engine_serial VARCHAR(100),
      ADD COLUMN IF NOT EXISTS engine_assigned_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS engine_returned BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS engine_returned_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS engine_issue TEXT,
      ADD COLUMN IF NOT EXISTS replacement_for VARCHAR(100),
      ADD COLUMN IF NOT EXISTS transponder_serial VARCHAR(100),
      ADD COLUMN IF NOT EXISTS transponder_assigned_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS tyre_front_left VARCHAR(100),
      ADD COLUMN IF NOT EXISTS tyre_front_right VARCHAR(100),
      ADD COLUMN IF NOT EXISTS tyre_rear_left VARCHAR(100),
      ADD COLUMN IF NOT EXISTS tyre_rear_right VARCHAR(100),
      ADD COLUMN IF NOT EXISTS tyres_registered_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS tyre_sets JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS fuel_collected BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS fuel_collected_at TIMESTAMP
    `);

    // ✅ FIX #2: Add unique constraint to prevent duplicate entries
    // This ensures we can't accidentally create multiple entries for same driver+event+payment
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'unique_driver_event_payment'
        ) THEN
          ALTER TABLE race_entries 
          ADD CONSTRAINT unique_driver_event_payment 
          UNIQUE (driver_id, event_id, payment_reference);
        END IF;
      END $$;
    `);

    // Custom driver barcodes — up to 3 scannable codes that resolve to this entry
    await pool.query(`
      ALTER TABLE race_entries
      ADD COLUMN IF NOT EXISTS driver_barcode_1 VARCHAR(100),
      ADD COLUMN IF NOT EXISTS driver_barcode_2 VARCHAR(100),
      ADD COLUMN IF NOT EXISTS driver_barcode_3 VARCHAR(100)
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_re_barcode1 ON race_entries(UPPER(driver_barcode_1)) WHERE driver_barcode_1 IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_re_barcode2 ON race_entries(UPPER(driver_barcode_2)) WHERE driver_barcode_2 IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_re_barcode3 ON race_entries(UPPER(driver_barcode_3)) WHERE driver_barcode_3 IS NOT NULL`);
    // Core lookup indexes — event_id and driver_id are the most-queried columns in race_entries
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_re_event_id  ON race_entries(event_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_re_driver_id ON race_entries(driver_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_re_entry_status ON race_entries(entry_status) WHERE entry_status IS NOT NULL`);

    // Ensure msa_license_number exists on drivers table
    await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS msa_license_number VARCHAR(100)`);
    // Season package for entry pricing: null=none, 'engine'=engine included, 'full'=full national package
    await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS national_package VARCHAR(20)`);

    console.log('✅ Race entries table initialized with all columns and unique constraints');
  } catch (err) {
    console.error('Error initializing race entries table:', err);
  }
}

// Initialize event class pricing table
const initEventPricingTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_class_pricing (
        id SERIAL PRIMARY KEY,
        event_id VARCHAR(255) NOT NULL,
        class_name VARCHAR(100) NOT NULL,
        config_json JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (event_id, class_name)
      )
    `);
    console.log('✅ Event class pricing table initialized');
  } catch (err) {
    console.error('Event pricing table init error:', err.message);
  }
};

// Initialize equipment scan log table
async function initEquipmentScanLog() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS equipment_scan_log (
        log_id SERIAL PRIMARY KEY,
        scan_timestamp TIMESTAMP DEFAULT NOW(),
        scan_type VARCHAR(50) NOT NULL,
        barcode_scanned VARCHAR(200),
        entry_id VARCHAR(100),
        driver_id VARCHAR(100),
        driver_name VARCHAR(200),
        equipment_serial VARCHAR(100),
        scanned_by VARCHAR(100) DEFAULT 'Unknown',
        action_result VARCHAR(20) DEFAULT 'success',
        notes TEXT,
        event_id VARCHAR(100),
        race_class VARCHAR(100)
      )
    `);
    
    // Add index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_equipment_scan_timestamp 
      ON equipment_scan_log(scan_timestamp DESC)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_equipment_scan_entry 
      ON equipment_scan_log(entry_id)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_equipment_scan_driver 
      ON equipment_scan_log(driver_id)
    `);

    // Migration: add signature_data column if not present
    await pool.query(`
      ALTER TABLE equipment_scan_log ADD COLUMN IF NOT EXISTS signature_data TEXT
    `).catch(() => {});
    
    console.log('✅ Equipment scan log table initialized');

    // Scanner identity table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scanners (
        scanner_id   SERIAL PRIMARY KEY,
        scanner_name VARCHAR(100) NOT NULL,
        pin_code     VARCHAR(4)   NOT NULL UNIQUE,
        created_at   TIMESTAMP DEFAULT NOW()
      )
    `);
    // Seed the legacy hardcoded PIN as a default scanner if none exist
    await pool.query(`
      INSERT INTO scanners (scanner_name, pin_code)
      SELECT 'Default Scanner', '5667'
      WHERE NOT EXISTS (SELECT 1 FROM scanners)
    `);
    console.log('✅ Scanners table initialized');

    // Pool engines table (for engine draw system)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pool_engines (
        engine_id      SERIAL PRIMARY KEY,
        draw_number    VARCHAR(20)  NOT NULL,
        engine_serial  VARCHAR(100) NOT NULL DEFAULT '',
        seal_number    VARCHAR(100) NOT NULL DEFAULT '',
        carb_number    VARCHAR(100) NOT NULL DEFAULT '',
        airbox_number  VARCHAR(100) NOT NULL DEFAULT '',
        exhaust_number VARCHAR(100) NOT NULL DEFAULT '',
        class          VARCHAR(50)  NOT NULL DEFAULT '',
        notes          TEXT         NOT NULL DEFAULT '',
        active         BOOLEAN      NOT NULL DEFAULT true,
        created_at     TIMESTAMP    DEFAULT NOW(),
        updated_at     TIMESTAMP    DEFAULT NOW(),
        UNIQUE(draw_number, class)
      )
    `);
    // Migration: replace old single-column unique with composite (draw_number, class)
    await pool.query(`ALTER TABLE pool_engines DROP CONSTRAINT IF EXISTS pool_engines_draw_number_key`).catch(() => {});
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'pool_engines_draw_number_class_key'
        ) THEN
          ALTER TABLE pool_engines ADD CONSTRAINT pool_engines_draw_number_class_key UNIQUE (draw_number, class);
        END IF;
      END $$
    `).catch(() => {});
    // Migration: soft-delete support
    await pool.query(`ALTER TABLE pool_engines ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`).catch(() => {});
    console.log('✅ Pool engines table initialized');

    // ── Entry engine draws ─────────────────────────────────────────────────
    // One row per actual draw/return cycle per competitor entry.
    // Supports multiple draws per entry (e.g. fault replacement within same event).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS entry_engine_draws (
        draw_id       SERIAL PRIMARY KEY,
        entry_id      VARCHAR(100) NOT NULL,
        engine_serial VARCHAR(100) NOT NULL,
        draw_number   VARCHAR(50),
        assigned_at   TIMESTAMP DEFAULT NOW(),
        returned      BOOLEAN DEFAULT false,
        returned_at   TIMESTAMP,
        engine_issue  TEXT,
        replaced_by   VARCHAR(100),
        notes         TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_eed_entry_id ON entry_engine_draws(entry_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_eed_serial   ON entry_engine_draws(UPPER(engine_serial))`).catch(() => {});
    // Add day_label column if it doesn't exist yet (migration for existing tables)
    await pool.query(`ALTER TABLE entry_engine_draws ADD COLUMN IF NOT EXISTS day_label VARCHAR(50)`).catch(() => {});
    console.log('✅ Entry engine draws table initialized');

    // ── Access Control ─────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS access_areas (
        area_id       SERIAL PRIMARY KEY,
        area_name     VARCHAR(100) NOT NULL,
        description   TEXT         NOT NULL DEFAULT '',
        max_capacity  INTEGER,
        is_active     BOOLEAN      NOT NULL DEFAULT true,
        created_at    TIMESTAMP    DEFAULT NOW()
      )
    `);
    console.log('✅ access_areas table initialized');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS area_permissions (
        permission_id SERIAL PRIMARY KEY,
        area_id       INTEGER NOT NULL REFERENCES access_areas(area_id) ON DELETE CASCADE,
        race_class    VARCHAR(100),
        window_start  TIME,
        window_end    TIME,
        is_active     BOOLEAN NOT NULL DEFAULT true
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ap_area ON area_permissions(area_id)`).catch(() => {});
    console.log('✅ area_permissions table initialized');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS entry_access_flags (
        flag_id        SERIAL PRIMARY KEY,
        entry_id       VARCHAR(100) NOT NULL,
        flag_type      VARCHAR(50)  NOT NULL DEFAULT 'BLOCK',
        public_message VARCHAR(200) NOT NULL DEFAULT 'Entry flagged — contact Race Director',
        admin_note     TEXT         NOT NULL DEFAULT '',
        flagged_by     VARCHAR(100) NOT NULL DEFAULT 'Admin',
        is_active      BOOLEAN      NOT NULL DEFAULT true,
        created_at     TIMESTAMP    DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_eaf_entry ON entry_access_flags(entry_id) WHERE is_active = true`).catch(() => {});
    console.log('✅ entry_access_flags table initialized');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS access_log (
        log_id             SERIAL PRIMARY KEY,
        entry_id           VARCHAR(100),
        area_id            INTEGER,
        direction          VARCHAR(10) NOT NULL DEFAULT 'IN',
        was_allowed        BOOLEAN     NOT NULL DEFAULT true,
        denial_reason      VARCHAR(200),
        scanned_at         TIMESTAMP   NOT NULL DEFAULT NOW(),
        device_id          VARCHAR(100),
        is_manual_override BOOLEAN     NOT NULL DEFAULT false,
        synced_at          TIMESTAMP   DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_al_area      ON access_log(area_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_al_entry     ON access_log(entry_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_al_scanned   ON access_log(scanned_at DESC)`).catch(() => {});
    console.log('✅ access_log table initialized');

    // Check-in columns on race_entries
    await pool.query(`ALTER TABLE race_entries ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP`).catch(() => {});
    await pool.query(`ALTER TABLE race_entries ADD COLUMN IF NOT EXISTS checked_in_by VARCHAR(100)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_re_checkin ON race_entries(checked_in_at) WHERE checked_in_at IS NOT NULL`).catch(() => {});
    console.log('✅ race_entries check-in columns ready');

  } catch (err) {
    console.error('Equipment scan log init error:', err.message);
  }
}

// Helper function to log equipment scans
const monitorClients = new Set();

// Flag display state (for flag.html)
const flagClients = new Set();
let currentFlag = 'none';

async function logEquipmentScan(scanData) {
  try {
    const result = await pool.query(`
      INSERT INTO equipment_scan_log 
      (scan_type, barcode_scanned, entry_id, driver_id, driver_name, 
       equipment_serial, scanned_by, action_result, notes, event_id, race_class, signature_data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING log_id, scan_timestamp
    `, [
      scanData.scan_type,
      scanData.barcode_scanned,
      scanData.entry_id,
      scanData.driver_id,
      scanData.driver_name,
      scanData.equipment_serial,
      scanData.scanned_by || 'Unknown',
      scanData.action_result || 'success',
      scanData.notes,
      scanData.event_id,
      scanData.race_class,
      scanData.signature_data || null
    ]);
    // Broadcast to live monitor clients
    const row = result.rows[0];
    // Resolve event name for the broadcast (best-effort, non-blocking)
    let broadcastEventName = null;
    if (scanData.event_id) {
      try {
        const evtRow = await pool.query('SELECT event_name FROM events WHERE event_id=$1', [scanData.event_id]);
        if (evtRow.rows.length) broadcastEventName = evtRow.rows[0].event_name;
      } catch(_) {}
    }
    const event = JSON.stringify({
      log_id: row.log_id,
      scan_timestamp: row.scan_timestamp,
      scan_type: scanData.scan_type,
      barcode_scanned: scanData.barcode_scanned,
      driver_name: scanData.driver_name,
      race_class: scanData.race_class,
      equipment_serial: scanData.equipment_serial,
      action_result: scanData.action_result || 'success',
      notes: scanData.notes,
      event_id: scanData.event_id || null,
      event_name: broadcastEventName,
      scanned_by: scanData.scanned_by || 'Unknown'
    });
    for (const client of monitorClients) {
      try { client.write(`data: ${event}\n\n`); } catch (_) { monitorClients.delete(client); }
    }
  } catch (err) {
    console.error('Error logging equipment scan:', err.message);
  }
}

// Initialize engine loans table (manual/practice assignments)
const initEngineLoansTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS engine_loans (
        loan_id       SERIAL PRIMARY KEY,
        engine_serial VARCHAR(100) NOT NULL,
        driver_name   VARCHAR(200) NOT NULL,
        driver_id     VARCHAR(100),
        purpose       VARCHAR(100) DEFAULT 'Practice',
        loan_date     TIMESTAMP NOT NULL DEFAULT NOW(),
        notes         TEXT,
        assigned_by   VARCHAR(100),
        returned_at   TIMESTAMP,
        returned_to   VARCHAR(100),
        return_notes  TEXT,
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_engine_loans_serial ON engine_loans(engine_serial)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_engine_loans_active  ON engine_loans(returned_at) WHERE returned_at IS NULL`);
    console.log('\u2705 Engine loans table initialized');
  } catch (err) {
    console.error('Engine loans init error:', err.message);
  }
};

// Initialize pool engine rentals table
const initPoolEngineRentalsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pool_engine_rentals (
        rental_id VARCHAR(255) PRIMARY KEY,
        driver_id VARCHAR(255) NOT NULL,
        championship_class VARCHAR(100) NOT NULL,
        rental_type VARCHAR(50) NOT NULL,
        amount_paid DECIMAL(10, 2),
        payment_status VARCHAR(50),
        payment_reference VARCHAR(255),
        season_year INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
      )
    `);
    console.log('✅ Pool engine rentals table initialized');
  } catch (err) {
    console.error('Pool engine rentals table init error:', err.message);
  }
};

// Initialize DIR engine contact log table
const initDirEngineContactsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dir_engine_contacts (
        contact_id    SERIAL PRIMARY KEY,
        engine_serial VARCHAR(100),
        person_name   VARCHAR(200) NOT NULL,
        driver_id     VARCHAR(100),
        contact_date  TIMESTAMP NOT NULL DEFAULT NOW(),
        contact_type  VARCHAR(100) DEFAULT 'Inspection',
        outcome       VARCHAR(50) NOT NULL,
        fault_category VARCHAR(100),
        description   TEXT,
        dir_notes     TEXT,
        follow_up     BOOLEAN DEFAULT false,
        follow_up_notes TEXT,
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dir_engine_serial ON dir_engine_contacts(engine_serial)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dir_outcome ON dir_engine_contacts(outcome)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dir_date ON dir_engine_contacts(contact_date)`);
    // Migrations: part swap tracking columns
    await pool.query(`ALTER TABLE dir_engine_contacts ADD COLUMN IF NOT EXISTS part_type   VARCHAR(50)`).catch(()=>{});
    await pool.query(`ALTER TABLE dir_engine_contacts ADD COLUMN IF NOT EXISTS part_number VARCHAR(100)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dir_part_number ON dir_engine_contacts(UPPER(part_number))`).catch(()=>{});
    console.log('✅ DIR engine contacts table initialized');
  } catch (err) {
    console.error('DIR engine contacts table init error:', err.message);
  }
};

// Initialize Discount Codes table
const initDiscountCodesTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS discount_codes (
        code_id VARCHAR(36) PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        description TEXT,
        discount_type VARCHAR(20) NOT NULL,
        discount_value DECIMAL(10, 2) NOT NULL,
        is_active BOOLEAN DEFAULT true,
        usage_limit INTEGER,
        usage_count INTEGER DEFAULT 0,
        valid_from TIMESTAMP,
        valid_until TIMESTAMP,
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Discount codes table initialized');
  } catch (err) {
    console.error('Discount codes table init error:', err.message);
  }
};

// Initialize Event Documents table
const initEventDocumentsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_documents (
        document_id VARCHAR(36) PRIMARY KEY,
        event_id VARCHAR(255) NOT NULL,
        uploaded_by_official VARCHAR(255),
        document_type VARCHAR(100) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(500),
        file_size INT,
        upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (event_id) REFERENCES events(event_id)
      )
    `);

    console.log('✅ Event documents table initialized');
  } catch (err) {
    console.error('Event documents table init error:', err.message);
  }
};

const initMSALicensesTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS msa_licenses (
        document_id VARCHAR(36) PRIMARY KEY,
        driver_id VARCHAR(255) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(500),
        file_size INT,
        file_type VARCHAR(100),
        upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
      )
    `);

    console.log('✅ MSA licenses table initialized');
  } catch (err) {
    console.error('MSA licenses table init error:', err.message);
  }
};

// Initialize PayFast webhooks table for ALL incoming notifications
const initPayFastWebhooksTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payfast_webhooks (
        webhook_id SERIAL PRIMARY KEY,
        m_payment_id VARCHAR(100),
        pf_payment_id VARCHAR(100),
        payment_status VARCHAR(50),
        item_name TEXT,
        item_description TEXT,
        amount_gross DECIMAL(10,2),
        amount_fee DECIMAL(10,2),
        amount_net DECIMAL(10,2),
        reference VARCHAR(255),
        email_address VARCHAR(255),
        name_first VARCHAR(100),
        name_last VARCHAR(100),
        cell_number VARCHAR(50),
        signature VARCHAR(255),
        signature_valid BOOLEAN,
        raw_data JSONB,
        processing_status VARCHAR(50) DEFAULT 'received',
        processing_error TEXT,
        matched_entry_id VARCHAR(100),
        matched_driver_id VARCHAR(100),
        matched_event_id VARCHAR(100),
        reconciled_by VARCHAR(100),
        reconciled_at TIMESTAMP,
        received_at TIMESTAMP DEFAULT NOW(),
        processed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Add index for faster lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_payfast_webhooks_reference ON payfast_webhooks(reference);
      CREATE INDEX IF NOT EXISTS idx_payfast_webhooks_pf_payment_id ON payfast_webhooks(pf_payment_id);
      CREATE INDEX IF NOT EXISTS idx_payfast_webhooks_processing_status ON payfast_webhooks(processing_status);
      CREATE INDEX IF NOT EXISTS idx_payfast_webhooks_received_at ON payfast_webhooks(received_at DESC);
    `);

    console.log('✅ PayFast webhooks table initialized');
  } catch (err) {
    console.error('PayFast webhooks table init error:', err.message);
  }
};

// Fix #15: Gate all table initializations behind SKIP_DB_INIT env var.
// Set SKIP_DB_INIT=true in production after first successful deploy to
// avoid running ~10 extra DB queries on every restart.
const SKIP_DB_INIT = process.env.SKIP_DB_INIT === 'true';

if (SKIP_DB_INIT) {
  console.log('ℹ️  SKIP_DB_INIT=true — skipping table initializations');
} else {
  console.log('🔧 Running database table initializations...');
  Promise.all([
    initAuditTable(),
    initMessagesTable(),
    initNotificationHistoryTable(),
    initEventsTable(),
    initEventPricingTable(),
    initRaceEntriesTable(),
    initEquipmentScanLog(),
    initEngineLoansTable(),
    initPoolEngineRentalsTable(),
    initDirEngineContactsTable(),
    initDiscountCodesTable(),
    initEventDocumentsTable(),
    initMSALicensesTable(),
    initPayFastWebhooksTable(),
  ]).then(() => {
    console.log('✅ Database initialization complete');
    initDefaultEvents();
  }).catch(err => {
    console.error('❌ Database initialization error:', err.message);
  });
}
const initDefaultEvents = async () => {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM events');
    if (result.rows[0].count === 0) {
      // Insert default events
      await pool.query(
        `INSERT INTO events (event_id, event_name, event_date, location, registration_deadline, entry_fee)
         VALUES 
         ($1, $2, $3, $4, $5, $6),
         ($7, $8, $9, $10, $11, $12)`,
        [
          'event_redstar_001', 'Red Star Raceway - Round 1', '2026-02-15', 'Red Star Raceway', '2026-02-10', 2950.00,
          'event_westlake_001', 'Westlake Grand Prix - Round 2', '2026-03-15', 'Westlake', '2026-03-10', 2950.00
        ]
      );
      console.log('✅ Default events created');
    }
  } catch (err) {
    console.error('Error initializing events:', err.message);
  }
};

// Log audit event
const logAuditEvent = async (driver_id, driver_email, action, field_name, old_value, new_value, ip_address = 'unknown') => {
  try {
    await pool.query(
      `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [driver_id, driver_email, action, field_name, old_value, new_value, ip_address]
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
};

// Load email template and replace variables
const loadEmailTemplate = (templateName, variables = {}) => {
  try {
    const templatePath = path.join(__dirname, 'email-templates', `${templateName}.html`);
    let html = fs.readFileSync(templatePath, 'utf8');
    
    // Replace all variables in the template
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      html = html.replace(regex, variables[key]);
    });
    
    return html;
  } catch (err) {
    console.error(`Error loading template ${templateName}:`, err.message);
    return null;
  }
};

// =========================================================
// RACE TICKET GENERATOR - Server-side HTML ticket with barcode
// =========================================================

// Code 39 character patterns for barcode generation
const CODE39_PATTERNS = {
  "0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw",
  "5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn",
  "A":"wnnnnwnnw","B":"nnwnnwnnw","C":"wnwnnwnnn","D":"nnnnwwnnw","E":"wnnnwwnnn",
  "F":"nnwnwwnnn","G":"nnnnnwwnw","H":"wnnnnwwnn","I":"nnwnnwwnn","J":"nnnnwwwnn",
  "K":"wnnnnnnww","L":"nnwnnnnww","M":"wnwnnnnwn","N":"nnnnwnnww","O":"wnnnwnnwn",
  "P":"nnwnwnnwn","Q":"nnnnnnwww","R":"wnnnnnwwn","S":"nnwnnnwwn","T":"nnnnwnwwn",
  "U":"wwnnnnnnw","V":"nwwnnnnnw","W":"wwwnnnnnn","X":"nwnnwnnnw","Y":"wwnnwnnnn",
  "Z":"nwwnwnnnn","-":"nwnnnnwnw",".":"wwnnnnwnn"," ":"nwwnnnwnn","$":"nwnwnwnnn",
  "/":"nwnwnnnwn","+":"nwnnnwnwn","%":"nnnwnwnwn","*":"nwnnwnwnn"
};

// Generate SVG barcode for Code 39
function generateCode39SVG(text, options = {}) {
  const { narrow = 2, wide = 6, height = 60, gap = 2 } = options;
  
  // Ensure uppercase and valid characters - use shorter code for barcode
  const safeText = (text || '').toUpperCase().replace(/[^0-9A-Z \-.$/+%]/g, '-');
  const value = `*${safeText}*`; // Add start/stop characters
  
  let bars = '';
  let x = 8; // Quiet zone
  
  for (const ch of value) {
    const pattern = CODE39_PATTERNS[ch] || CODE39_PATTERNS['-'];
    for (let i = 0; i < pattern.length; i++) {
      const isBar = i % 2 === 0;
      const w = pattern[i] === 'w' ? wide : narrow;
      if (isBar) {
        bars += `<rect x="${x}" y="6" width="${w}" height="${height}" fill="#000"/>`;
      }
      x += w;
    }
    x += gap;
  }
  
  const totalWidth = x + 8; // Add quiet zone
  const totalHeight = height + 24;
  
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" style="width:100%;max-width:280px;height:auto;display:block;margin:0 auto;">
    <rect x="0" y="0" width="${totalWidth}" height="${totalHeight}" fill="#fff" rx="4"/>
    ${bars}
    <text x="${totalWidth/2}" y="${height + 18}" text-anchor="middle" font-family="'Courier New',monospace" font-size="11" font-weight="bold" fill="#000">${safeText}</text>
  </svg>`;
}

// Generate race entry ticket HTML for email - PORTRAIT MODE for mobile
function generateRaceTicketHTML(ticketData) {
  const {
    reference,
    eventName,
    eventDate,
    eventLocation,
    raceClass,
    driverName,
    raceNumber,
    teamCode,
    gatesTime = '07:00',
    practiceTime = '08:00',
    racingTime = '10:30'
  } = ticketData;
  
  // Format date for display
  const dateObj = eventDate ? new Date(eventDate) : new Date();
  const dayName = dateObj.toLocaleDateString('en-ZA', { weekday: 'short' }).toUpperCase();
  const dayNum = dateObj.getDate();
  const monthName = dateObj.toLocaleDateString('en-ZA', { month: 'short' }).toUpperCase();
  const year = dateObj.getFullYear();
  const formattedDate = `${dayName} ${dayNum} ${monthName} ${year}`;
  
  // Generate QR code
  const qrData = reference.toUpperCase();
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=6&data=${encodeURIComponent(qrData)}`;
  
  // Issue timestamp
  const issueStamp = new Date().toLocaleString('en-ZA', { 
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' 
  }).toUpperCase();
  
  // Venue display
  const venueDisplay = (eventLocation || 'TBA').toUpperCase();
  
  return `
    <!-- RACE ENTRY TICKET - PORTRAIT MODE -->
    <div style="margin: 30px 0; border-top: 1px solid #e5e7eb; padding-top: 20px;">
      <div style="font-weight: 700; color: #111827; margin-bottom: 16px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em;">🎟️ Your Race Entry Ticket</div>
      
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 380px; margin: 0 auto; border-collapse: collapse;">
        <tr>
          <td>
            <!-- Main Ticket Card -->
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background-color: #0b2e55; border-radius: 16px; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,0.25);">
              
              <!-- Header with Logo Area -->
              <tr>
                <td style="padding: 24px 20px 16px 20px; text-align: center; background-color: #0b2e55;">
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 13px; letter-spacing: 3px; color: rgba(255,255,255,0.7); margin-bottom: 8px;">ROK CUP SOUTH AFRICA</div>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 11px; letter-spacing: 2px; color: rgba(255,255,255,0.5);">PRESENTS</div>
                </td>
              </tr>
              
              <!-- Event Name -->
              <tr>
                <td style="padding: 0 20px 20px 20px; text-align: center; background-color: #0b2e55;">
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 22px; letter-spacing: 2px; color: #fff; line-height: 1.2; text-shadow: 0 2px 4px rgba(0,0,0,0.3);">${(eventName || 'RACE EVENT').toUpperCase()}</div>
                </td>
              </tr>
              
              <!-- Date Banner -->
              <tr>
                <td style="padding: 0 20px 20px 20px; text-align: center; background-color: #0b2e55;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto; background-color: rgba(255,255,255,0.15); border-radius: 8px;">
                    <tr>
                      <td style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 18px; letter-spacing: 1px; color: #fff; text-align: center; padding: 10px 16px;">${formattedDate}</td>
                    </tr>
                  </table>
                </td>
              </tr>
              
              <!-- Venue & Times -->
              <tr>
                <td style="padding: 0 20px 24px 20px; text-align: center; background-color: #0b2e55;">
                  <div style="font-family: 'Courier New', monospace; font-weight: 800; font-size: 12px; color: rgba(255,255,255,0.9); letter-spacing: 1px; margin-bottom: 8px;">${venueDisplay}</div>
                  <div style="font-family: 'Courier New', monospace; font-weight: 700; font-size: 11px; color: rgba(255,255,255,0.6); letter-spacing: 0.5px;">
                    GATES ${gatesTime} · PRACTICE ${practiceTime} · RACING ${racingTime}
                  </div>
                </td>
              </tr>
              
              <!-- White Content Area -->
              <tr>
                <td>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background: #fff; border-radius: 12px 12px 0 0;">
                    
                    <!-- Perforation Line -->
                    <tr>
                      <td style="padding: 0; height: 12px; background: #fff; position: relative;">
                        <div style="border-top: 2px dashed #ccc; margin: 0 16px;"></div>
                      </td>
                    </tr>
                    
                    <!-- Driver & Class Info -->
                    <tr>
                      <td style="padding: 16px 20px;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="width: 50%; vertical-align: top;">
                              <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #888; letter-spacing: 1px; text-transform: uppercase;">DRIVER</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 14px; font-weight: 800; color: #111; margin-top: 4px;">${(driverName || 'DRIVER').toUpperCase()}</div>
                            </td>
                            <td style="width: 50%; vertical-align: top; text-align: right;">
                              <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #888; letter-spacing: 1px; text-transform: uppercase;">CLASS</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 14px; font-weight: 800; color: #111; margin-top: 4px;">${(raceClass || 'TBA').toUpperCase()}</div>
                              ${raceNumber ? `<div style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: 900; color: #0b2e55; line-height: 1; margin-top: 6px;">#${raceNumber}</div>` : ''}
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    
                    <!-- Team & Pass Type -->
                    <tr>
                      <td style="padding: 0 20px 16px 20px;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="width: 50%; vertical-align: top;">
                              <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #888; letter-spacing: 1px; text-transform: uppercase;">${teamCode ? 'TEAM' : 'SERIES'}</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #333; margin-top: 4px;">${teamCode ? teamCode.toUpperCase() : 'NATS 2026'}</div>
                            </td>
                            <td style="width: 50%; vertical-align: top; text-align: right;">
                              <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #888; letter-spacing: 1px; text-transform: uppercase;">PASS TYPE</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #333; margin-top: 4px;">PADDOCK</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    
                    <!-- QR Code Section -->
                    <tr>
                      <td style="padding: 16px 20px 12px 20px; border-top: 1px solid #eee; text-align: center;">
                        <img src="${qrCodeUrl}" alt="${qrData}" width="160" height="160" style="display:block;margin:0 auto;border-radius:6px;" />
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 900; color: #111; text-align: center; margin-top: 8px; letter-spacing: 0.12em;">${reference}</div>
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; text-align: center; margin-top: 2px;">Scan QR code at the gate for entry</div>
                      </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                      <td style="padding: 12px 20px 16px 20px; background: #f8f9fa; border-top: 1px solid #eee;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; text-transform: uppercase;">
                              ISSUED: ${issueStamp}
                            </td>
                            <td style="text-align: right; font-family: 'Courier New', monospace; font-size: 9px; color: #888; text-transform: uppercase;">
                              QR SCAN ENTRY
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    
                  </table>
                </td>
              </tr>
              
            </table>
          </td>
        </tr>
      </table>
      
      <div style="text-align: center; margin-top: 16px; font-size: 12px; color: #6b7280;">
        Present this ticket at the gate for entry.
      </div>
    </div>
  `;
}

// Generate ENGINE RENTAL ticket HTML - Vortex Engines
// Generate unique ticket reference with barcode
function generateUniqueTicketRef(type, driverId, eventId) {
  const typeCode = {
    'engine': 'ENG',
    'tyres': 'TYR',
    'transponder': 'TX',
    'fuel': 'GAS'
  }[type] || 'TKT';

  let random4Digit;
  if (type === 'engine') {
    // Engine voucher codes: ENG5500–ENG5599
    random4Digit = Math.floor(5500 + Math.random() * 100);
  } else {
    random4Digit = Math.floor(1000 + Math.random() * 9000);
  }

  // Format: TYPEXXXX (e.g., ENG5523, TYR5678, TX9012, GAS3456)
  return `${typeCode}${random4Digit}`;
}

function generateEngineRentalTicketHTML(ticketData) {
  const {
    reference,
    eventName,
    eventDate,
    eventLocation,
    raceClass,
    driverName,
    raceNumber,
    dayLabel = ''
  } = ticketData;
  
  const dateObj = eventDate ? new Date(eventDate) : new Date();
  const formattedDate = dateObj.toLocaleDateString('en-ZA', { 
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' 
  }).toUpperCase();

  // Class colour map
  const classColour = (() => {
    const c = (raceClass || '').toUpperCase();
    if (c.includes('CADET'))             return '#f97316'; // orange
    if (c.includes('MINI') && c.includes('10')) return '#ec4899'; // pink
    if (c.includes('MINI'))              return '#7c3aed'; // purple
    if (c.includes('OK-J') || c.includes('OKJ')) return '#2563eb'; // blue
    if (c.includes('OK-N') || c.includes('OKN')) return '#059669'; // green
    if (c.includes('OK'))                return '#0891b2'; // cyan
    return '#374151'; // gray default
  })();

  const qrData = reference.toUpperCase();
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=6&data=${encodeURIComponent(qrData)}`;

  // Vortex logo URL (hosted) - using text fallback for email compatibility
  const vortexLogoUrl = 'https://www.vortex-rok.com/wp-content/uploads/2020/01/vortex-logo.png';
  
  return `
    <!-- ENGINE RENTAL TICKET - PORTRAIT -->
    <div style="margin: 24px 0;">
      <div style="font-weight: 700; color: #111827; margin-bottom: 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">🏎️ Engine Rental Voucher</div>
      
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 380px; margin: 0 auto;">
        <tr>
          <td>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background-color: #1e3a5f; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 24px rgba(30,58,95,0.3);">
              
              <!-- Header with Logo centered -->
              <tr>
                <td style="padding: 20px 20px 16px 20px; background-color: #1e3a5f; text-align: center;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                    <tr>
                      <td style="width: 70px; height: 70px; border-radius: 50%; background-color: #ffffff; border: 3px solid #f59e0b; text-align: center; vertical-align: middle;">
                        <span style="font-family: Arial, sans-serif; font-size: 11px; font-weight: 900; color: #1e3a5f; letter-spacing: 1px;">VORTEX</span>
                      </td>
                    </tr>
                  </table>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 10px; letter-spacing: 2px; color: #f59e0b; text-transform: uppercase; margin-top: 10px;">Rental Engine</div>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 18px; letter-spacing: 1px; color: #fff; margin-top: 4px;">VORTEX ROK</div>
                  ${dayLabel ? `<div style="font-family:'Courier New',monospace;font-weight:900;font-size:10px;letter-spacing:2px;color:#1e3a5f;background:#f59e0b;padding:5px 14px;border-radius:12px;margin-top:10px;display:inline-block;">${dayLabel.toUpperCase()}</div>` : ''}
                </td>
              </tr>
              
              <!-- White Content Section -->
              <tr>
                <td>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background: #fff; border-radius: 8px 8px 0 0;">
                    <tr>
                      <td style="padding: 16px 20px;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="width: 50%;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">CLASS</div>
                              <div style="display:inline-flex;align-items:center;gap:6px;margin-top:2px;">
                                <span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${classColour};"></span>
                                <span style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 800; color: #111;">${(raceClass || 'TBA').toUpperCase()}</span>
                              </div>
                            </td>
                            <td style="width: 50%; text-align: right; vertical-align: top;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">EVENT</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 11px; font-weight: 700; color: #111; margin-top: 2px;">${formattedDate}</div>
                              ${raceNumber ? `<div style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: 900; color: #1e3a5f; line-height: 1; margin-top: 6px;">#${raceNumber}</div>` : ''}
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 0 20px 16px 20px;">
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">DRIVER</div>
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: #111; margin-top: 2px;">${(driverName || 'DRIVER').toUpperCase()}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 14px 20px; border-top: 1px dashed #ddd; text-align: center;">
                        <img src="${qrCodeUrl}" alt="${qrData}" width="160" height="160"
                             style="display:block;margin:0 auto;border-radius:6px;" />
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 900; color: #111; text-align: center; margin-top: 8px; letter-spacing: 0.12em;">
                          ${reference}
                        </div>
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; text-align: center; margin-top: 2px;">Scan QR code to collect engine</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 12px 20px 14px 20px; background: #fef3c7; border-top: 1px solid #fcd34d;">
                        <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #92400e; line-height: 1.4;">
                          ⚠️ Engine must be collected at paddock on practice day. Present this voucher.
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
}

// Generate TYRE RENTAL ticket HTML - LeVanto Kart Tires
function generateTyreRentalTicketHTML(ticketData) {
  const {
    reference,
    eventName,
    eventDate,
    eventLocation,
    raceClass,
    driverName,
    raceNumber,
    dayLabel = ''
  } = ticketData;
  
  const dateObj = eventDate ? new Date(eventDate) : new Date();
  const formattedDate = dateObj.toLocaleDateString('en-ZA', { 
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' 
  }).toUpperCase();
  
  const qrData = reference.toUpperCase();
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=6&data=${encodeURIComponent(qrData)}`;
  
  // LeVanto logo URL (hosted) - using text fallback for email compatibility
  const levantoLogoUrl = 'https://levfriction.com/wp-content/uploads/2023/03/levanto-logo.png';
  
  return `
    <!-- TYRE RENTAL TICKET - PORTRAIT -->
    <div style="margin: 24px 0;">
      <div style="font-weight: 700; color: #111827; margin-bottom: 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">🛞 Race Tyres Voucher</div>
      
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 380px; margin: 0 auto;">
        <tr>
          <td>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background-color: #1a1a2e; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 24px rgba(26,26,46,0.3);">
              
              <!-- Header with Logo -->
              <tr>
                <td style="padding: 20px 20px 16px 20px; text-align: center; background-color: #1a1a2e;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 12px auto;">
                    <tr>
                      <td style="width: 70px; height: 70px; border-radius: 50%; background-color: #ffffff; border: 3px solid #0ea5e9; text-align: center; vertical-align: middle;">
                        <span style="font-family: Arial, sans-serif; font-size: 9px; font-weight: 900; color: #0ea5e9; letter-spacing: 0.5px;">LeVANTO</span>
                      </td>
                    </tr>
                  </table>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 10px; letter-spacing: 2px; color: #0ea5e9; text-transform: uppercase;">Complete Set</div>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 18px; letter-spacing: 1px; color: #fff; margin-top: 4px;">RACE TYRES</div>
                  ${dayLabel ? `<div style="font-family:'Courier New',monospace;font-weight:900;font-size:10px;letter-spacing:2px;color:#0c4a6e;background:#0ea5e9;padding:5px 14px;border-radius:12px;margin-top:10px;display:inline-block;">${dayLabel.toUpperCase()}</div>` : ''}
                </td>
              </tr>
              
              <!-- White Content Section -->
              <tr>
                <td>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background: #fff; border-radius: 8px 8px 0 0;">
                    <tr>
                      <td style="padding: 16px 20px;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="width: 50%;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">CLASS</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 800; color: #111; margin-top: 2px;">${(raceClass || 'TBA').toUpperCase()}</div>
                            </td>
                            <td style="width: 50%; text-align: right;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">EVENT</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 11px; font-weight: 700; color: #111; margin-top: 2px;">${formattedDate}</div>
                              ${raceNumber ? `<div style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: 900; color: #0ea5e9; line-height: 1; margin-top: 6px;">#${raceNumber}</div>` : ''}
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 0 20px 16px 20px;">
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">DRIVER</div>
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: #111; margin-top: 2px;">${(driverName || 'DRIVER').toUpperCase()}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 14px 20px; border-top: 1px dashed #ddd; text-align: center;">
                        <img src="${qrCodeUrl}" alt="${qrData}" width="160" height="160" style="display:block;margin:0 auto;border-radius:6px;" />
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 900; color: #111; text-align: center; margin-top: 8px; letter-spacing: 0.12em;">${reference}</div>
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; text-align: center; margin-top: 2px;">Scan QR code to collect tyres</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 12px 20px 14px 20px; background: #ecfeff; border-top: 1px solid #a5f3fc;">
                        <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #0e7490; line-height: 1.4;">
                          🛞 Present voucher at paddock on practice day to collect your race tyres.
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
}

// Generate TRANSPONDER RENTAL ticket HTML - MyLaps X2
function generateTransponderRentalTicketHTML(ticketData) {
  const {
    reference,
    eventName,
    eventDate,
    eventLocation,
    raceClass,
    driverName,
    raceNumber,
    dayLabel = ''
  } = ticketData;
  
  const dateObj = eventDate ? new Date(eventDate) : new Date();
  const formattedDate = dateObj.toLocaleDateString('en-ZA', { 
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' 
  }).toUpperCase();
  
  const qrData = reference.toUpperCase();
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=6&data=${encodeURIComponent(qrData)}`;
  
  return `
    <!-- TRANSPONDER RENTAL TICKET - PORTRAIT -->
    <div style="margin: 24px 0;">
      <div style="font-weight: 700; color: #111827; margin-bottom: 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">📡 Transponder Rental Voucher</div>
      
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 380px; margin: 0 auto;">
        <tr>
          <td>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background-color: #4c1d95; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 24px rgba(76,29,149,0.3);">
              
              <!-- Header with Logo -->
              <tr>
                <td style="padding: 20px 20px 16px 20px; text-align: center; background-color: #4c1d95;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 12px auto;">
                    <tr>
                      <td style="width: 70px; height: 70px; border-radius: 50%; background-color: #ffffff; border: 3px solid #a78bfa; text-align: center; vertical-align: middle;">
                        <span style="font-family: Arial, sans-serif; font-size: 9px; font-weight: 900; color: #4c1d95; letter-spacing: 0.5px;">MYLAPS</span>
                      </td>
                    </tr>
                  </table>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 10px; letter-spacing: 2px; color: #a78bfa; text-transform: uppercase;">Race Timing</div>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 18px; letter-spacing: 1px; color: #fff; margin-top: 4px;">TRANSPONDER</div>
                  ${dayLabel ? `<div style="font-family:'Courier New',monospace;font-weight:900;font-size:10px;letter-spacing:2px;color:#3b0764;background:#a78bfa;padding:5px 14px;border-radius:12px;margin-top:10px;display:inline-block;">${dayLabel.toUpperCase()}</div>` : ''}
                </td>
              </tr>
              
              <!-- White Content Section -->
              <tr>
                <td>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background: #fff; border-radius: 8px 8px 0 0;">
                    <tr>
                      <td style="padding: 16px 20px;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="width: 50%;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">CLASS</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 800; color: #111; margin-top: 2px;">${(raceClass || 'TBA').toUpperCase()}</div>
                            </td>
                            <td style="width: 50%; text-align: right;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">EVENT</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 11px; font-weight: 700; color: #111; margin-top: 2px;">${formattedDate}</div>
                              ${raceNumber ? `<div style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: 900; color: #4c1d95; line-height: 1; margin-top: 6px;">#${raceNumber}</div>` : ''}
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 0 20px 16px 20px;">
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">DRIVER</div>
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: #111; margin-top: 2px;">${(driverName || 'DRIVER').toUpperCase()}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 14px 20px; border-top: 1px dashed #ddd; text-align: center;">
                        <img src="${qrCodeUrl}" alt="${qrData}" width="160" height="160" style="display:block;margin:0 auto;border-radius:6px;" />
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 900; color: #111; text-align: center; margin-top: 8px; letter-spacing: 0.12em;">${reference}</div>
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; text-align: center; margin-top: 2px;">Scan QR code to collect transponder</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 12px 20px 14px 20px; background: #f3e8ff; border-top: 1px solid #d8b4fe;">
                        <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #6b21a8; line-height: 1.4;">
                          📡 Collect transponder from timing office. Driver's license required as deposit. Return after final race.
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
}

function generateFuelTicketHTML(ticketData) {
  const {
    reference,
    eventName,
    eventDate,
    eventLocation,
    raceClass,
    driverName,
    raceNumber,
    dayLabel = ''
  } = ticketData;
  
  const dateObj = eventDate ? new Date(eventDate) : new Date();
  const formattedDate = dateObj.toLocaleDateString('en-ZA', { 
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' 
  }).toUpperCase();
  
  const qrData = reference.toUpperCase();
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=6&data=${encodeURIComponent(qrData)}`;
  
  return `
    <!-- FUEL PACKAGE TICKET - PORTRAIT -->
    <div style="margin: 24px 0;">
      <div style="font-weight: 700; color: #111827; margin-bottom: 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">⛽ Race Fuel Package</div>
      
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 380px; margin: 0 auto;">
        <tr>
          <td>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background-color: #065f46; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 24px rgba(6,95,70,0.3);">
              
              <!-- Header with Logo -->
              <tr>
                <td style="padding: 20px 20px 16px 20px; text-align: center; background-color: #065f46;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 12px auto;">
                    <tr>
                      <td style="width: 70px; height: 70px; border-radius: 50%; background-color: #ffffff; border: 3px solid #34d399; text-align: center; vertical-align: middle;">
                        <span style="font-family: Arial, sans-serif; font-size: 32px;">⛽</span>
                      </td>
                    </tr>
                  </table>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 10px; letter-spacing: 2px; color: #6ee7b7; text-transform: uppercase;">Pre-Mixed Racing</div>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 18px; letter-spacing: 1px; color: #fff; margin-top: 4px;">RACE FUEL</div>
                  ${dayLabel ? `<div style="font-family:'Courier New',monospace;font-weight:900;font-size:10px;letter-spacing:2px;color:#022c22;background:#34d399;padding:5px 14px;border-radius:12px;margin-top:10px;display:inline-block;">${dayLabel.toUpperCase()}</div>` : ''}
                </td>
              </tr>
              
              <!-- White Content Section -->
              <tr>
                <td>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background: #fff; border-radius: 8px 8px 0 0;">
                    <tr>
                      <td style="padding: 16px 20px;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="width: 50%;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">CLASS</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 800; color: #111; margin-top: 2px;">${(raceClass || 'TBA').toUpperCase()}</div>
                            </td>
                            <td style="width: 50%; text-align: right;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">EVENT</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 11px; font-weight: 700; color: #111; margin-top: 2px;">${formattedDate}</div>
                              ${raceNumber ? `<div style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: 900; color: #065f46; line-height: 1; margin-top: 6px;">#${raceNumber}</div>` : ''}
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 0 20px 16px 20px;">
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">DRIVER</div>
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: #111; margin-top: 2px;">${(driverName || 'DRIVER').toUpperCase()}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 14px 20px; border-top: 1px dashed #ddd; text-align: center;">
                        <img src="${qrCodeUrl}" alt="${qrData}" width="160" height="160" style="display:block;margin:0 auto;border-radius:6px;" />
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 900; color: #111; text-align: center; margin-top: 8px; letter-spacing: 0.12em;">${reference}</div>
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; text-align: center; margin-top: 2px;">Scan QR code to collect fuel</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 12px 20px 14px 20px; background: #d1fae5; border-top: 1px solid #6ee7b7;">
                        <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #065f46; line-height: 1.4;">
                          ⛽ Fuel available at paddock fuel station. Present voucher for allocation. Pre-measured competition fuel only.
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
}

// Health check
app.all('/api/ping', (req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

// TEST: Preview race ticket HTML (for testing only - remove in production)
app.get('/api/preview-ticket', (req, res) => {
  const baseData = {
    eventName: 'Northern Regions Crown Race',
    eventDate: '2026-02-14',
    eventLocation: 'Red Star Raceway, Mpumalanga',
    raceClass: 'OK-J',
    driverName: 'Max Verstappen',
    teamCode: 'RSR',
    raceNumber: '33'
  };

  const raceTicketHtml        = generateRaceTicketHTML({ ...baseData, reference: `RACE${Math.floor(1000 + Math.random() * 9000)}` });
  const engineTicketHtml      = generateEngineRentalTicketHTML({ ...baseData, reference: `ENG${Math.floor(5500 + Math.random() * 100)}` });
  const tyreTicketHtml        = generateTyreRentalTicketHTML({ ...baseData, reference: `TYR${Math.floor(1000 + Math.random() * 9000)}` });
  const transponderTicketHtml = generateTransponderRentalTicketHTML({ ...baseData, reference: `TX${Math.floor(1000 + Math.random() * 9000)}` });
  const fuelTicketHtml        = generateFuelTicketHTML({ ...baseData, reference: `GAS${Math.floor(1000 + Math.random() * 9000)}` });
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Ticket Preview</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #1a1a2e; padding: 20px; margin: 0; }
        .preview-container { max-width: 500px; margin: 0 auto 30px auto; background: white; padding: 30px; border-radius: 12px; }
        h1 { color: white; text-align: center; margin-bottom: 30px; }
        h2 { color: white; text-align: center; margin: 40px 0 20px 0; font-size: 18px; }
      </style>
    </head>
    <body>
      <h1>🎟️ Race Ticket Preview</h1>
      
      <h2>RACE ENTRY TICKET</h2>
      <div class="preview-container">
        ${raceTicketHtml}
      </div>
      
      <h2>ENGINE RENTAL TICKET</h2>
      <div class="preview-container">
        ${engineTicketHtml}
      </div>
      
      <h2>TYRE RENTAL TICKET</h2>
      <div class="preview-container">
        ${tyreTicketHtml}
      </div>
      
      <h2>TRANSPONDER RENTAL TICKET</h2>
      <div class="preview-container">
        ${transponderTicketHtml}
      </div>
      
      <h2>FUEL PACKAGE TICKET</h2>
      <div class="preview-container">
        ${fuelTicketHtml}
      </div>
    </body>
    </html>
  `);
});

// Debug endpoint to check environment variables
app.get('/api/debug-env', requireAdmin, (req, res) => {
  if (!isDebugEnabled()) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  res.json({
    success: true,
    data: {
      mailchimp_api_key: process.env.MAILCHIMP_API_KEY ? process.env.MAILCHIMP_API_KEY.substring(0, 5) + '...' : 'NOT SET',
      mailchimp_from_email: process.env.MAILCHIMP_FROM_EMAIL || 'NOT SET',
      mailchimp_from_name: process.env.MAILCHIMP_FROM_NAME || 'NOT SET',
      db_host: process.env.DB_HOST ? 'SET' : 'NOT SET',
      node_env: process.env.NODE_ENV || 'NOT SET',
      all_env_keys: Object.keys(process.env)
    }
  });
});

// Test admin registration email
app.post('/api/test-admin-registration-email', requireAdmin, async (req, res) => {
  if (!isDebugEnabled()) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  try {
    const { email } = req.body;
    if (!email) throw new Error('Email is required');

    console.log(`📧 Sending test admin registration email to ${email}...`);

    // Sample driver data
    const testData = {
      driver_id: 'TEST-' + Date.now(),
      first_name: 'Lando',
      last_name: 'Norris',
      email: 'lando.norris@sectcapital.com',
      date_of_birth: '2005-06-15',
      nationality: 'British',
      gender: 'Male',
      id_or_passport_number: '1234567890',
      championship: 'ROK Cup South Africa',
      class: 'OK-N',
      race_number: '1010',
      team_name: 'Sect Capital Racing',
      coach_name: 'Max Verstappen',
      kart_brand: 'Tony Kart',
      engine_type: 'Vortex',
      transponder_number: '1010101',
      contact_name: 'John Norris',
      contact_phone: '0721234567',
      contact_relationship: 'Father',
      contact_emergency: 'Y',
      contact_consent: 'Y',
      medical_allergies: 'None',
      medical_conditions: 'None',
      medical_medication: 'None',
      medical_doctor_phone: '0721112222',
      consent_signed: 'Y',
      media_release_signed: 'Y'
    };

    const adminEmailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 900px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; }
          .header h1 { margin: 0; font-size: 24px; }
          .section { margin: 20px 0; padding: 15px; background: #f9f9f9; border-left: 4px solid #667eea; border-radius: 4px; }
          .section h3 { margin: 0 0 10px 0; color: #667eea; font-size: 16px; }
          .row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 10px 0; }
          .field { margin: 8px 0; }
          .field-label { font-weight: bold; color: #555; font-size: 12px; text-transform: uppercase; }
          .field-value { color: #333; margin-top: 4px; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; text-align: center; }
          .badge { display: inline-block; padding: 4px 8px; background: #667eea; color: white; border-radius: 4px; font-size: 12px; font-weight: bold; }
          .test-badge { background: #f59e0b !important; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>📝 New Driver Registration (TEST)</h1>
            <p style="margin: 5px 0 0 0;">A new driver has registered in the NATS system</p>
          </div>

          <div class="section">
            <h3>👤 Driver Information</h3>
            <div class="row">
              <div class="field">
                <div class="field-label">Driver Name</div>
                <div class="field-value">${testData.first_name} ${testData.last_name}</div>
              </div>
              <div class="field">
                <div class="field-label">Email</div>
                <div class="field-value"><a href="mailto:${testData.email}">${testData.email}</a></div>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Date of Birth</div>
                <div class="field-value">${new Date(testData.date_of_birth).toLocaleDateString('en-ZA')}</div>
              </div>
              <div class="field">
                <div class="field-label">Nationality</div>
                <div class="field-value">${testData.nationality}</div>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Gender</div>
                <div class="field-value">${testData.gender}</div>
              </div>
              <div class="field">
                <div class="field-label">ID/Passport</div>
                <div class="field-value">****${testData.id_or_passport_number.slice(-4)}</div>
              </div>
            </div>
          </div>

          <div class="section">
            <h3>🏎️ Competition Details</h3>
            <div class="row">
              <div class="field">
                <div class="field-label">Championship</div>
                <div class="field-value">${testData.championship}</div>
              </div>
              <div class="field">
                <div class="field-label">Class</div>
                <div class="field-value"><span class="badge">${testData.class}</span></div>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Race Number</div>
                <div class="field-value">${testData.race_number}</div>
              </div>
              <div class="field">
                <div class="field-label">Team Name</div>
                <div class="field-value">${testData.team_name}</div>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Coach/Mentor</div>
                <div class="field-value">${testData.coach_name}</div>
              </div>
              <div class="field">
                <div class="field-label">Transponder Number</div>
                <div class="field-value">${testData.transponder_number}</div>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Kart Brand</div>
                <div class="field-value">${testData.kart_brand}</div>
              </div>
              <div class="field">
                <div class="field-label">Engine Type</div>
                <div class="field-value">${testData.engine_type}</div>
              </div>
            </div>
          </div>

          <div class="section">
            <h3>👨‍👩‍👧 Guardian Information</h3>
            <div class="row">
              <div class="field">
                <div class="field-label">Guardian Name</div>
                <div class="field-value">${testData.contact_name}</div>
              </div>
              <div class="field">
                <div class="field-label">Guardian Phone</div>
                <div class="field-value">${testData.contact_phone}</div>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Relationship</div>
                <div class="field-value">${testData.contact_relationship}</div>
              </div>
              <div class="field">
                <div class="field-label">Emergency Contact</div>
                <div class="field-value">${testData.contact_emergency === 'Y' ? '✅ Yes' : '❌ No'}</div>
              </div>
            </div>
            <div class="field">
              <div class="field-label">Contact Consent</div>
              <div class="field-value">${testData.contact_consent === 'Y' ? '✅ Approved' : '❌ Not approved'}</div>
            </div>
          </div>

          <div class="section">
            <h3>⚕️ Medical Information</h3>
            <div class="field">
              <div class="field-label">Allergies</div>
              <div class="field-value">${testData.medical_allergies}</div>
            </div>
            <div class="field">
              <div class="field-label">Medical Conditions</div>
              <div class="field-value">${testData.medical_conditions}</div>
            </div>
            <div class="field">
              <div class="field-label">Medications</div>
              <div class="field-value">${testData.medical_medication}</div>
            </div>
            <div class="field">
              <div class="field-label">Doctor Phone</div>
              <div class="field-value">${testData.medical_doctor_phone}</div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Consent Signed</div>
                <div class="field-value">${testData.consent_signed === 'Y' ? '✅ Yes' : '❌ No'}</div>
              </div>
              <div class="field">
                <div class="field-label">Media Release Signed</div>
                <div class="field-value">${testData.media_release_signed === 'Y' ? '✅ Yes' : '❌ No'}</div>
              </div>
            </div>
          </div>

          <div class="section">
            <h3>📋 Registration Status</h3>
            <div class="row">
              <div class="field">
                <div class="field-label">Driver ID</div>
                <div class="field-value">${testData.driver_id}</div>
              </div>
              <div class="field">
                <div class="field-label">Status</div>
                <div class="field-value"><span class="badge test-badge">Test Email</span></div>
              </div>
            </div>
            <div class="field">
              <div class="field-label">Registered At</div>
              <div class="field-value">${new Date().toLocaleString('en-ZA')}</div>
            </div>
          </div>

          <div class="footer">
            <p>📧 This is a TEST email showing the format of admin registration notifications.</p>
            <p><a href="https://rokthenats.co.za/admin.html" style="color: #667eea; text-decoration: none; font-weight: bold;">View in Admin Portal →</a></p>
          </div>
        </div>
      </body>
      </html>
    `;

    await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
      key: process.env.MAILCHIMP_API_KEY,
      message: {
        to: [{ email: email }],
        from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
        subject: `[TEST] New Driver Registration - ${testData.first_name} ${testData.last_name} - ${testData.class}`,
        html: adminEmailHtml
      }
    });

    console.log(`✅ Test admin registration email sent to ${email}`);
    res.json({
      success: true,
      data: { 
        message: `Test registration email sent to ${email}`,
        testDriver: {
          name: `${testData.first_name} ${testData.last_name}`,
          email: testData.email,
          class: testData.class,
          race_number: testData.race_number
        }
      }
    });
  } catch (err) {
    console.error('❌ Test email error:', err.message);
    res.status(400).json({ success: false, error: { message: safeErrorMessage(err, 'Unable to send test email') } });
  }
});

// Test email endpoint
app.post('/api/test-email', requireAdmin, async (req, res) => {
  if (!isDebugEnabled()) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  try {
    const { email, driver_id } = req.body;
    if (!email) throw new Error('Email required');
    
    const test_driver_id = driver_id || 'TEST-' + Date.now();
    
    console.log(`📧 Sending test registration email to ${email}...`);
    console.log(`Using Mailchimp API key: ${process.env.MAILCHIMP_API_KEY ? 'Present' : 'Missing'}`);
    console.log(`From email: ${process.env.MAILCHIMP_FROM_EMAIL}`);
    
    try {
      const emailHtml = loadEmailTemplate('registration-confirmation', {});
      const mailchimpResponse = await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: email }],
          from_email: process.env.MAILCHIMP_FROM_EMAIL,
          subject: 'Welcome to the 2026 ROK Cup South Africa NATS',
          html: emailHtml
        }
      });
      
      console.log(`✅ Test email sent successfully to ${email}`, mailchimpResponse.data);
      res.json({
        success: true,
        data: { message: `Test email sent to ${email}` }
      });
    } catch (mailErr) {
      console.error('⚠️ Mailchimp API error:', mailErr.message);
      if (mailErr.response) {
        console.error('Mailchimp response status:', mailErr.response.status);
        console.error('Mailchimp response data:', mailErr.response.data);
      }
      // Return success anyway for testing - email endpoint is configured but API key issue
      console.log(`ℹ️ Email endpoint is functional. Mailchimp API error (likely API key issue)`);
      res.json({
        success: true,
        data: { 
          message: `Test email endpoint is functional. Email would be sent to ${email}. (Mailchimp API key needs verification)` 
        }
      });
    }
  } catch (err) {
    console.error('❌ Test email error:', err.message);
    res.status(400).json({ success: false, error: { message: safeErrorMessage(err, 'Unable to send test email') } });
  }
});

// Test endpoint to check database
// Sync status — shows whether we're in cloud or local mode and queue depth
app.get('/api/syncStatus', requireAdmin, async (req, res) => {
  if (!isDebugEnabled()) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  const isLocal = process.env.DB_SSL === 'false';
  let queueDepth = 0;
  let cloudReachable = null;
  if (isLocal) {
    try {
      const { rows } = await pool.query(`SELECT COUNT(*) as c FROM sync_queue WHERE synced_at IS NULL`);
      queueDepth = parseInt(rows[0].c);
    } catch { /* table may not exist yet */ }
    try {
      const { Pool: CP } = require('pg');
      const cp = new CP({ host: process.env.CLOUD_DB_HOST, port: parseInt(process.env.CLOUD_DB_PORT||'6432'), database: process.env.CLOUD_DB_DATABASE, user: process.env.CLOUD_DB_USERNAME, password: process.env.CLOUD_DB_PASSWORD, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 4000, max: 1 });
      await cp.query('SELECT 1');
      await cp.end();
      cloudReachable = true;
    } catch { cloudReachable = false; }
  }
  res.json({
    mode: isLocal ? 'local' : 'cloud',
    queueDepth,
    cloudReachable,
    lastSyncAgo: isLocal ? `${Math.round((Date.now() - lastSyncTime) / 1000)}s ago` : 'N/A'
  });
});

app.get('/api/test-db', requireAdmin, async (req, res) => {
  if (!isDebugEnabled()) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  try {
    // Get drivers table columns
    const driversInfo = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'drivers'
      ORDER BY ordinal_position
    `);

    // Get sample drivers
    const drivers = await pool.query('SELECT * FROM drivers LIMIT 3');

    res.json({
      success: true,
      data: {
        drivers_columns: driversInfo.rows.map(r => ({ name: r.column_name, type: r.data_type })),
        sample_drivers: drivers.rows
      }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: safeErrorMessage(err, 'Unable to inspect database') } });
  }
});

// Get driver profile by ID
app.post('/api/getDriverProfile', requireAdmin, async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) {
      return res.status(400).json({ success: false, error: { message: 'Driver ID required' } });
    }

    const result = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const driver = result.rows[0];
    if (!driver) {
      return res.status(404).json({ success: false, error: { message: 'Driver not found' } });
    }

    const contacts = await pool.query('SELECT * FROM contacts WHERE driver_id = $1', [driver_id]);
    const medical = await pool.query('SELECT * FROM medical_consent WHERE driver_id = $1', [driver_id]);
    const points = await pool.query('SELECT * FROM points WHERE driver_id = $1', [driver_id]);

    console.log(`✅ Retrieved driver profile: ${driver_id}`);
    res.json({
      success: true,
      data: {
        driver: driver,
        contacts: contacts.rows,
        medical: medical.rows[0] || {},
        points: points.rows
      }
    });
  } catch (err) {
    console.error('❌ getDriverProfile error:', err.message);
    res.status(400).json({ success: false, error: { message: safeErrorMessage(err, 'Unable to load profile') } });
  }
});

// Get driver profile by email
app.post('/api/getDriverProfileByEmail', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: { message: 'Email required' } });
    }

    const contactResult = await pool.query('SELECT driver_id FROM contacts WHERE email = $1', [email.toLowerCase()]);
    if (contactResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Email not found' } });
    }

    const driver_id = contactResult.rows[0].driver_id;
    const result = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const driver = result.rows[0];
    if (!driver) {
      return res.status(404).json({ success: false, error: { message: 'Driver not found' } });
    }

    const contacts = await pool.query('SELECT * FROM contacts WHERE driver_id = $1', [driver_id]);
    const medical = await pool.query('SELECT * FROM medical_consent WHERE driver_id = $1', [driver_id]);
    const points = await pool.query('SELECT * FROM points WHERE driver_id = $1', [driver_id]);

    console.log(`✅ Retrieved driver by email: ${email}`);
    res.json({
      success: true,
      data: {
        driver: driver,
        contacts: contacts.rows,
        medical: medical.rows[0] || {},
        points: points.rows
      }
    });
  } catch (err) {
    console.error('❌ getDriverProfileByEmail error:', err.message);
    res.status(400).json({ success: false, error: { message: safeErrorMessage(err, 'Unable to load profile') } });
  }
});

// Login with password endpoint (for frontend compatibility)
app.post('/api/loginWithPassword', validateBody(loginSchema), async (req, res) => {
  // Rate limit check
  const clientIp = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
  const rateCheck = checkLoginRateLimit(clientIp);
  if (!rateCheck.allowed) {
    return res.status(429).json({ success: false, error: { message: rateCheck.message } });
  }

  try {
    const { email, password } = req.body;
    if (!email || !password) {
      recordFailedLogin(clientIp);
      // Generic message - don't reveal which field is missing
      return res.status(400).json({ success: false, error: { message: 'Invalid email or password' } });
    }

    const contactResult = await pool.query('SELECT driver_id FROM contacts WHERE email = $1', [email.toLowerCase()]);
    if (contactResult.rows.length === 0) {
      console.warn(`⚠️ Login attempt with non-existent email: ${email}`);
      recordFailedLogin(clientIp);
      return res.status(400).json({ success: false, error: { message: 'Invalid email or password' } });
    }

    const driver_id = contactResult.rows[0].driver_id;
    const result = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const driver = result.rows[0];
    if (!driver) {
      recordFailedLogin(clientIp);
      return res.status(400).json({ success: false, error: { message: 'Invalid email or password' } });
    }

    if (!driver.password_hash) {
      console.warn(`⚠️ Driver ${driver_id} has no password set`);
      recordFailedLogin(clientIp);
      return res.status(400).json({ success: false, error: { message: 'Password not set for this account. Please use the reset link.' } });
    }

    const passwordMatch = await bcryptjs.compare(password, driver.password_hash);
    if (!passwordMatch) {
      console.warn(`⚠️ Failed login attempt for ${email}`);
      recordFailedLogin(clientIp);
      return res.status(400).json({ success: false, error: { message: 'Invalid email or password' } });
    }

    // Successful login - clear rate limit counter
    clearLoginAttempts(clientIp);

    const contacts = await pool.query('SELECT * FROM contacts WHERE driver_id = $1', [driver_id]);
    const medical = await pool.query('SELECT * FROM medical_consent WHERE driver_id = $1', [driver_id]);
    const points = await pool.query('SELECT * FROM points WHERE driver_id = $1', [driver_id]);

    console.log(`✅ Successful login: ${email}`);
    
    adminNotificationQueue.addToBatch({
      action: 'User Login',
      userEmail: email,
      details: {
        driverName: `${driver.first_name} ${driver.last_name}`,
        driverClass: driver.class,
        loginTime: new Date().toLocaleString()
      }
    });
    
    res.json({
      success: true,
      data: {
        driver: driver,
        contacts: contacts.rows,
        medical: medical.rows[0] || {},
        points: points.rows
      }
    });
  } catch (err) {
    console.error('❌ loginWithPassword error:', err.message);
    res.status(400).json({ success: false, error: { message: 'Login failed. Please try again.' } });
  }
});

// DEBUG: Get database schema for contacts table
app.get('/api/debug/contacts-schema', requireAdmin, async (req, res) => {
  if (!isDebugEnabled()) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  try {
    // Try SHOW COLUMNS instead (works better with PlanetScale)
    const result = await pool.query(`SHOW COLUMNS FROM contacts`);
    res.json({ 
      success: true, 
      columns: result.rows,
      columnNames: result.rows.map(r => r.Field)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: safeErrorMessage(err, 'Unable to inspect schema'), hint: 'Try /api/debug/contacts-sample instead' });
  }
});

// DEBUG: Get sample row from contacts table to see what data exists
app.get('/api/debug/contacts-sample', requireAdmin, async (req, res) => {
  if (!isDebugEnabled()) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM contacts LIMIT 1`
    );
    if (result.rows.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No data in contacts table yet',
        sampleRow: null
      });
    }
    
    const sampleRow = result.rows[0];
    res.json({ 
      success: true, 
      sampleRow: sampleRow,
      columnNames: Object.keys(sampleRow)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: safeErrorMessage(err, 'Unable to inspect sample data') });
  }
});

// Register new driver
app.post('/api/registerDriver', validateBody(registerDriverSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    console.log('📥 registerDriver request received:', {
      first_name: req.body.first_name,
      last_name: req.body.last_name,
      email: req.body.email
    });

    const {
      first_name, last_name, email, date_of_birth, nationality, gender, id_or_passport_number,
      championship, class: klass, race_number, team_name, coach_name, kart_brand, engine_type, transponder_number,
      consent_signed, media_release_signed,
      password,
      contact_name, contact_phone, contact_relationship, contact_emergency, contact_consent,
      medical_allergies, medical_conditions, medical_medication, medical_doctor_phone,
      medical, contacts,
      license_b64, license_name, license_mime,
      photo_b64, photo_name, photo_mime
    } = req.body;

    if (!email) throw new Error('Email is required');
    if (!first_name) throw new Error('First name is required');
    if (!last_name) throw new Error('Last name is required');
    if (!password) throw new Error('Password is required');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');

    // Check if email already exists
    const existingEmail = await pool.query(
      'SELECT driver_id FROM contacts WHERE email = $1',
      [email.toLowerCase()]
    );
    if (existingEmail.rows.length > 0) {
      throw new Error('Email address already registered. Please use a different email or log in with your existing account.');
    }

    const driver_id = uuidv4();
    console.log(`✅ Generated driver_id: ${driver_id}`);

    // Hash password
    const password_hash = await bcryptjs.hash(password, 10);
    console.log(`✅ Password hashed for ${email}`);

    await client.query('BEGIN');

    // Insert driver with basic fields AND password_hash

    console.log(`📝 Registering driver: ${first_name} ${last_name} (${email})`);
    try {
      await client.query(
        `INSERT INTO drivers (driver_id, first_name, last_name, status, password_hash)
        VALUES ($1, $2, $3, $4, $5)`,
        [driver_id, first_name, last_name, 'Pending', password_hash]
      );
      console.log(`✅ Driver inserted: ${driver_id}`);
    } catch (insertErr) {
      console.error('❌ Driver insert error:', insertErr.message);
      await client.query('ROLLBACK');
      throw new Error('Failed to create driver record: ' + insertErr.message);
    }

    // Try to update with additional optional fields
    try {
      await client.query(
        `UPDATE drivers SET date_of_birth = $1, nationality = $2, gender = $3,
          championship = $4, class = $5, race_number = $6,
          team_name = $7, coach_name = $8, kart_brand = $9, engine_type = $10,
          transponder_number = $11, license_number = $12, msa_license_number = $12
        WHERE driver_id = $13`,
        [date_of_birth, nationality, gender, championship, klass,
          race_number, team_name, coach_name, kart_brand, engine_type, transponder_number, id_or_passport_number, driver_id]
      );
      console.log(`✅ Driver additional fields updated`);
    } catch (e) {
      console.log('⚠️ Could not update additional driver fields:', e.message);
    }

    // Insert email as first contact - REQUIRED
    try {
      const contact_id = uuidv4();
      await client.query(
        `INSERT INTO contacts (contact_id, driver_id, full_name, email, phone_mobile, relationship, emergency_contact, consent_contact)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [contact_id, driver_id, contact_name || null, email.toLowerCase(), contact_phone || null, 
         contact_relationship || 'Guardian', contact_emergency === 'Y' ? true : false, contact_consent === 'Y' ? true : false]
      );
      console.log(`✅ Guardian contact saved: ${contact_name || 'N/A'} (${email})`);
    } catch (e) {
      console.error('❌ Could not insert contact:', e.message);
      await client.query('ROLLBACK');
      throw new Error('Failed to save contact information: ' + e.message);
    }

    // Try to insert other contacts
    if (contacts && contacts.length > 0) {
      for (const contact of contacts) {
        try {
          const contact_id = uuidv4();
          await client.query(
            `INSERT INTO contacts (contact_id, driver_id, email)
            VALUES ($1, $2, $3)`,
            [contact_id, driver_id, contact.email]
          );
        } catch (e) {
          console.log('⚠️ Could not insert additional contact:', e.message);
        }
      }
    }

    // Try to insert medical consent
    if (medical_allergies || medical_conditions || medical_medication || medical_doctor_phone || consent_signed || media_release_signed) {
      try {
        await client.query(
          `INSERT INTO medical_consent (driver_id, allergies, medical_conditions, medication, doctor_phone, consent_signed, media_release_signed)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [driver_id, medical_allergies || null, medical_conditions || null, medical_medication || null, 
           medical_doctor_phone || null, consent_signed === 'Y' ? true : false, media_release_signed === 'Y' ? true : false]
        );
        console.log(`✅ Medical consent saved`);
      } catch (e) {
        console.log('⚠️ Could not insert medical consent:', e.message);
      }
    } else if (medical) {
      // Legacy support: if medical object is passed (backwards compatibility)
      try {
        await client.query(
          `INSERT INTO medical_consent (driver_id, allergies, medical_conditions, medication)
          VALUES ($1, $2, $3, $4)`,
          [driver_id, medical.allergies, medical.medical_conditions, medical.medication]
        );
      } catch (e) {
        console.log('⚠️ Could not insert medical consent:', e.message);
      }
    }

    await client.query('COMMIT');
    console.log(`✅ Transaction committed for driver ${driver_id}`);
    
    // Log to audit trail
    await logAuditEvent(driver_id, email, 'DRIVER_REGISTERED', 'driver_created', '', `${first_name} ${last_name}`);
    
    // Send confirmation email
    try {
      console.log(`📧 Sending confirmation email to ${email}...`);
      const emailHtml = loadEmailTemplate('registration-confirmation');
      if (!emailHtml) {
        throw new Error('Failed to load email template');
      }
      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: email }],
          from_email: process.env.MAILCHIMP_FROM_EMAIL,
          subject: 'Welcome to the 2026 ROK Cup South Africa NATS',
          html: emailHtml
        }
      });
      console.log(`✅ Confirmation email sent to ${email}`);
    } catch (emailErr) {
      console.error('❌ Email error:', emailErr.message);
      // Log but don't block registration
    }

    // Send admin notification with all registration details
    try {
      const adminEmailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 900px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; }
            .header h1 { margin: 0; font-size: 24px; }
            .section { margin: 20px 0; padding: 15px; background: #f9f9f9; border-left: 4px solid #667eea; border-radius: 4px; }
            .section h3 { margin: 0 0 10px 0; color: #667eea; font-size: 16px; }
            .row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 10px 0; }
            .field { margin: 8px 0; }
            .field-label { font-weight: bold; color: #555; font-size: 12px; text-transform: uppercase; }
            .field-value { color: #333; margin-top: 4px; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; text-align: center; }
            .badge { display: inline-block; padding: 4px 8px; background: #667eea; color: white; border-radius: 4px; font-size: 12px; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>📝 New Driver Registration</h1>
              <p style="margin: 5px 0 0 0;">A new driver has registered in the NATS system</p>
            </div>

            <div class="section">
              <h3>👤 Driver Information</h3>
              <div class="row">
                <div class="field">
                  <div class="field-label">Driver Name</div>
                  <div class="field-value">${first_name} ${last_name}</div>
                </div>
                <div class="field">
                  <div class="field-label">Email</div>
                  <div class="field-value"><a href="mailto:${email}">${email}</a></div>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Date of Birth</div>
                  <div class="field-value">${date_of_birth ? new Date(date_of_birth).toLocaleDateString('en-ZA') : 'Not provided'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Nationality</div>
                  <div class="field-value">${nationality || 'Not provided'}</div>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Gender</div>
                  <div class="field-value">${gender || 'Not provided'}</div>
                </div>
                <div class="field">
                  <div class="field-label">ID/Passport</div>
                  <div class="field-value">${id_or_passport_number ? '****' + id_or_passport_number.slice(-4) : 'Not provided'}</div>
                </div>
              </div>
            </div>

            <div class="section">
              <h3>🏎️ Competition Details</h3>
              <div class="row">
                <div class="field">
                  <div class="field-label">Championship</div>
                  <div class="field-value">${championship || 'Not provided'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Class</div>
                  <div class="field-value"><span class="badge">${klass || 'Not provided'}</span></div>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Race Number</div>
                  <div class="field-value">${race_number || 'Not assigned'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Team Name</div>
                  <div class="field-value">${team_name || 'No team'}</div>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Coach/Mentor</div>
                  <div class="field-value">${coach_name || 'Not provided'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Transponder Number</div>
                  <div class="field-value">${transponder_number || 'Not provided'}</div>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Kart Brand</div>
                  <div class="field-value">${kart_brand || 'Not provided'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Engine Type</div>
                  <div class="field-value">${engine_type || 'Not provided'}</div>
                </div>
              </div>
            </div>

            <div class="section">
              <h3>👨‍👩‍👧 Guardian Information</h3>
              <div class="row">
                <div class="field">
                  <div class="field-label">Guardian Name</div>
                  <div class="field-value">${contact_name || 'Not provided'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Guardian Phone</div>
                  <div class="field-value">${contact_phone || 'Not provided'}</div>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Relationship</div>
                  <div class="field-value">${contact_relationship || 'Not specified'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Emergency Contact</div>
                  <div class="field-value">${contact_emergency === 'Y' ? '✅ Yes' : '❌ No'}</div>
                </div>
              </div>
              <div class="field">
                <div class="field-label">Contact Consent</div>
                <div class="field-value">${contact_consent === 'Y' ? '✅ Approved' : '❌ Not approved'}</div>
              </div>
            </div>

            <div class="section">
              <h3>⚕️ Medical Information</h3>
              <div class="field">
                <div class="field-label">Allergies</div>
                <div class="field-value">${medical_allergies || 'None reported'}</div>
              </div>
              <div class="field">
                <div class="field-label">Medical Conditions</div>
                <div class="field-value">${medical_conditions || 'None reported'}</div>
              </div>
              <div class="field">
                <div class="field-label">Medications</div>
                <div class="field-value">${medical_medication || 'None reported'}</div>
              </div>
              <div class="field">
                <div class="field-label">Doctor Phone</div>
                <div class="field-value">${medical_doctor_phone || 'Not provided'}</div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Consent Signed</div>
                  <div class="field-value">${consent_signed === 'Y' ? '✅ Yes' : '❌ No'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Media Release Signed</div>
                  <div class="field-value">${media_release_signed === 'Y' ? '✅ Yes' : '❌ No'}</div>
                </div>
              </div>
            </div>

            <div class="section">
              <h3>📋 Registration Status</h3>
              <div class="row">
                <div class="field">
                  <div class="field-label">Driver ID</div>
                  <div class="field-value">${driver_id}</div>
                </div>
                <div class="field">
                  <div class="field-label">Status</div>
                  <div class="field-value"><span class="badge" style="background: #f59e0b;">Pending Approval</span></div>
                </div>
              </div>
              <div class="field">
                <div class="field-label">Registered At</div>
                <div class="field-value">${new Date().toLocaleString('en-ZA')}</div>
              </div>
            </div>

            <div class="footer">
              <p>📧 This is an automated notification from the NATS Driver Registry system.</p>
              <p><a href="https://rokthenats.co.za/admin.html" style="color: #667eea; text-decoration: none; font-weight: bold;">View in Admin Portal →</a></p>
            </div>
          </div>
        </body>
        </html>
      `;

      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: 'john@rokcup.co.za', name: 'Admin' }],
          from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
          subject: `[NEW REGISTRATION] ${first_name} ${last_name} - ${klass || 'Class TBD'}`,
          html: adminEmailHtml
        }
      });
      
      console.log(`📧 Admin notification sent to john@rokcup.co.za`);
    } catch (adminEmailErr) {
      console.error('⚠️ Admin email sending failed:', adminEmailErr.message);
      // Don't block registration if admin email fails
    }
    
    res.json({
      success: true,
      data: {
        driver_id: driver_id,
        status: 'Pending',
        message: 'Registration submitted successfully. Your registration is pending admin approval. Check your email for confirmation.'
      }
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback error:', rollbackErr);
    }
    console.error('❌ Registration error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  } finally {
    client.release();
  }
});

// Admin: Resend welcome email to driver
app.post('/api/admin/resendWelcomeEmail', async (req, res) => {
  try {
    const { driver_id, email } = req.body;
    if (!driver_id || !email) {
      throw new Error('Driver ID and email are required');
    }

    console.log(`📧 Admin resending welcome email to driver ${driver_id} at ${email}...`);
    
    try {
      const emailHtml = loadEmailTemplate('registration-confirmation');
      if (!emailHtml) {
        throw new Error('Failed to load email template');
      }
      
      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: email }],
          from_email: process.env.MAILCHIMP_FROM_EMAIL,
          subject: 'Welcome to the 2026 ROK Cup South Africa NATS',
          html: emailHtml
        }
      });
      
      console.log(`✅ Welcome email resent to ${email}`);
      res.json({
        success: true,
        data: { message: 'Welcome email sent successfully' }
      });
    } catch (emailErr) {
      console.error('❌ Email error:', emailErr.message);
      throw new Error('Failed to send email: ' + emailErr.message);
    }
  } catch (err) {
    console.error('❌ Resend welcome email error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Request password reset
app.post('/api/requestPasswordReset', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) throw new Error('Email is required');

    console.log(`🔐 Password reset requested for: ${email}`);

    const contactResult = await pool.query(
      'SELECT driver_id FROM contacts WHERE email = $1',
      [email.toLowerCase()]
    );

    // Always return generic success for security
    if (contactResult.rows.length === 0) {
      console.log(`⚠️ Password reset request for non-existent email: ${email}`);
      return res.json({
        success: true,
        data: { message: 'If that email exists, a reset link has been sent.' }
      });
    }

    const driver_id = contactResult.rows[0].driver_id;
    const reset_token = crypto.randomBytes(32).toString('hex');
    const reset_token_hash = crypto.createHash('sha256').update(reset_token).digest('hex');
    const reset_token_expiry = new Date(Date.now() + 3600000); // 1 hour

    await pool.query(
      'UPDATE drivers SET reset_token = $1, reset_token_expiry = $2 WHERE driver_id = $3',
      [reset_token_hash, reset_token_expiry, driver_id]
    );
    console.log(`✅ Reset token saved to database for driver: ${driver_id}`);

    // Send email
    const resetLink = `https://rokthenats.co.za/reset-password.html?token=${reset_token}&email=${encodeURIComponent(email)}`;
    const emailHtml = loadEmailTemplate('password-reset', {
      RESET_LINK: resetLink
    });
    await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
      key: process.env.MAILCHIMP_API_KEY,
      message: {
        to: [{ email: email }],
        from_email: process.env.MAILCHIMP_FROM_EMAIL,
        subject: 'Reset Your NATS Driver Registry Password',
        html: emailHtml
      }
    }).catch(err => console.error('⚠️ Email error:', err.message));

    console.log(`✅ Reset email sent to: ${email}`);
    res.json({
      success: true,
      data: { message: 'If that email exists, a reset link has been sent.' }
    });
  } catch (err) {
    console.error('❌ requestPasswordReset error:', err.message);
    res.status(400).json({ success: false, error: { message: safeErrorMessage(err, 'Unable to process password reset request') } });
  }
});

// Reset password
app.post('/api/resetPassword', async (req, res) => {
  try {
    const { token, email, newPassword } = req.body;
    if (!token || !email || !newPassword) throw new Error('Missing required fields');
    if (newPassword.length < 8) throw new Error('Password must be at least 8 characters');

    const token_hash = crypto.createHash('sha256').update(token).digest('hex');

    const contactResult = await pool.query(
      'SELECT driver_id FROM contacts WHERE email = $1',
      [email.toLowerCase()]
    );

    if (contactResult.rows.length === 0) throw new Error('Email not found');

    const driver_id = contactResult.rows[0].driver_id;
    const driverResult = await pool.query(
      'SELECT reset_token, reset_token_expiry FROM drivers WHERE driver_id = $1',
      [driver_id]
    );

    const driver = driverResult.rows[0];
    if (!driver || driver.reset_token !== token_hash) throw new Error('Invalid reset token');
    if (new Date() > driver.reset_token_expiry) throw new Error('Reset token has expired');

    const password_hash = await bcryptjs.hash(newPassword, 10);

    await pool.query(
      'UPDATE drivers SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL WHERE driver_id = $2',
      [password_hash, driver_id]
    );

    // Log to audit trail
    await logAuditEvent(driver_id, email, 'PASSWORD_RESET', 'password', 'old_password', 'new_password_set');

    console.log(`✅ Password reset successfully for driver: ${driver_id}`);
    res.json({
      success: true,
      data: { message: 'Password reset successfully. You can now log in with your new password.' }
    });
  } catch (err) {
    console.error('❌ resetPassword error:', err.message);
    res.status(400).json({ success: false, error: { message: safeErrorMessage(err, 'Unable to reset password') } });
  }
});

// Store payment
app.post('/api/storePayment', async (req, res) => {
  try {
    const { driver_id, amount, status, reference } = req.body;
    if (!driver_id || !amount) throw new Error('Missing required fields');

    console.log(`💳 Storing payment: driver=${driver_id}, amount=${amount}, status=${status}`);
    
    await pool.query(
      `INSERT INTO payments (driver_id, amount, status, reference, payment_date)
      VALUES ($1, $2, $3, $4, NOW())`,
      [driver_id, amount, status || 'Pending', reference]
    );

    console.log(`✅ Payment recorded successfully: ${reference}`);
    res.json({ success: true, data: { message: 'Payment recorded' } });
  } catch (err) {
    console.error('❌ storePayment error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get payment history
app.post('/api/getPaymentHistory', async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) throw new Error('Driver ID required');

    console.log(`📊 Retrieving payment history for driver: ${driver_id}`);
    
    const result = await pool.query(
      'SELECT * FROM payments WHERE driver_id = $1 ORDER BY created_at DESC',
      [driver_id]
    );

    console.log(`✅ Retrieved ${result.rows.length} payment records for driver ${driver_id}`);
    
    res.json({
      success: true,
      data: { payments: result.rows }
    });
  } catch (err) {
    console.error('❌ getPaymentHistory error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get ALL payments for admin (Payment Log tab)
app.post('/api/getAllPayments', async (req, res) => {
  try {
    console.log(`📊 Admin retrieving all payments`);
    
    // Get all race entries with payment info, joined with driver and event details
    // Email is in contacts table, not drivers table
    const result = await pool.query(`
      SELECT 
        re.entry_id,
        re.event_id,
        re.driver_id,
        re.payment_reference,
        re.payment_status,
        re.entry_status,
        re.amount_paid,
        re.race_class,
        re.race_number,
        re.entry_items,
        re.team_code,
        re.created_at,
        d.first_name,
        d.last_name,
        c.email,
        e.event_name,
        e.event_date
      FROM race_entries re
      LEFT JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN contacts c ON re.driver_id = c.driver_id
      LEFT JOIN events e ON re.event_id = e.event_id
      WHERE re.payment_reference IS NOT NULL
      ORDER BY re.created_at DESC
      LIMIT 500
    `);
    
    // Get direct payments from payments table (e.g., season packages, direct PayFast payments)
    let directPayments = [];
    try {
      const paymentsResult = await pool.query(`
        SELECT 
          p.payment_id,
          p.driver_id,
          p.merchant_payment_id as payment_reference,
          p.payment_status,
          p.amount_gross,
          p.amount_net,
          p.item_name,
          p.item_description,
          p.created_at,
          p.completed_at,
          d.first_name,
          d.last_name,
          c.email
        FROM payments p
        LEFT JOIN drivers d ON p.driver_id = d.driver_id
        LEFT JOIN contacts c ON p.driver_id = c.driver_id
        ORDER BY p.created_at DESC
        LIMIT 100
      `);
      directPayments = paymentsResult.rows;
    } catch (paymentsErr) {
      console.log('Direct payments query error:', paymentsErr.message);
    }
    
    // Also get pool engine rentals
    let poolRentals = [];
    try {
      const poolResult = await pool.query(`
        SELECT 
          per.rental_id,
          per.driver_id,
          per.championship_class,
          per.rental_type,
          per.amount_paid,
          per.payment_status,
          per.payment_reference,
          per.season_year,
          per.created_at,
          d.first_name,
          d.last_name,
          c.email
        FROM pool_engine_rentals per
        LEFT JOIN drivers d ON per.driver_id = d.driver_id
        LEFT JOIN contacts c ON per.driver_id = c.driver_id
        ORDER BY per.created_at DESC
        LIMIT 100
      `);
      poolRentals = poolResult.rows;
    } catch (poolErr) {
      console.log('Pool engine rentals query error:', poolErr.message);
    }

    console.log(`✅ Retrieved ${result.rows.length} race entries, ${directPayments.length} direct payments, ${poolRentals.length} pool rentals`);
    
    res.json({
      success: true,
      data: { 
        payments: result.rows,
        directPayments: directPayments,
        poolRentals: poolRentals
      }
    });
  } catch (err) {
    console.error('❌ getAllPayments error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Store Race Entry Payment Intent
app.post('/api/storeRaceEntryPayment', async (req, res) => {
  try {
    const { driver_id, race_class, amount, reference, has_engine_rental } = req.body;
    if (!driver_id || !race_class || !amount) throw new Error('Missing required fields');

    console.log(`🏎️ Storing race entry payment: driver=${driver_id}, class=${race_class}, amount=${amount}`);
    
    await pool.query(
      `INSERT INTO payments (driver_id, amount, status, reference, payment_date)
       VALUES ($1, $2, $3, $4, NOW())`,
      [driver_id, amount, 'Pending', reference]
    );

    console.log(`✅ Race entry payment intent stored: ${reference}`);
    res.json({ success: true, data: { message: 'Payment intent stored', reference } });
  } catch (err) {
    console.error('❌ storeRaceEntryPayment error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Register Race Entry (Free - for promo codes)
app.post('/api/registerRaceEntry', validateBody(raceEntrySchema), async (req, res) => {
  try {
    const { driver_id, race_class, entry_items, total_amount, has_engine_rental, promo_code } = req.body;
    if (!driver_id || !race_class) throw new Error('Missing required fields');

    console.log(`🏎️ Registering free race entry: driver=${driver_id}, class=${race_class}, items=${JSON.stringify(entry_items)}`);

    // Create race entry record
    const race_id = `race_${driver_id}_${Date.now()}`;
    await pool.query(
      `INSERT INTO race_entries (driver_id, race_id, race_class, entry_items, total_amount, payment_status, entry_date)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [driver_id, race_id, race_class, JSON.stringify(entry_items), total_amount || 0, 'Completed']
    );

    // Update driver's next race status to "Registered"
    await pool.query(
      'UPDATE drivers SET next_race_entry_status = $1 WHERE driver_id = $2',
      ['Registered', driver_id]
    );

    // If engine rental was included, update that status too
    if (has_engine_rental) {
      await pool.query(
        'UPDATE drivers SET next_race_engine_rental_status = $1 WHERE driver_id = $2',
        ['Registered', driver_id]
      );
      console.log(`✅ Engine rental status updated for driver ${driver_id}`);
    }

    // Log the action
    await logAuditEvent(driver_id, 'driver', 'RACE_ENTRY_REGISTERED', 'race_class', '', race_class);

    console.log(`✅ Free race entry registered successfully: ${race_id}`);
    res.json({ 
      success: true, 
      data: { 
        message: 'Race entry registered successfully',
        race_id: race_id
      } 
    });
  } catch (err) {
    console.error('❌ registerRaceEntry error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Complete Race Entry After Payment (called after PayFast callback)
app.post('/api/completeRaceEntryPayment', async (req, res) => {
  try {
    const { payment_reference, driver_id, race_class, has_engine_rental } = req.body;
    if (!payment_reference || !driver_id || !race_class) throw new Error('Missing required fields');

    console.log(`✅ Completing race entry payment: payment=${payment_reference}, driver=${driver_id}`);

    // Get payment details
    const paymentResult = await pool.query(
      'SELECT * FROM payments WHERE reference = $1 LIMIT 1',
      [payment_reference]
    );

    if (paymentResult.rows.length === 0) {
      throw new Error('Payment not found');
    }

    const payment = paymentResult.rows[0];

    // Update payment status to Completed
    await pool.query(
      'UPDATE payments SET status = $1 WHERE reference = $2',
      ['Completed', payment_reference]
    );

    // Create race entry record
    const race_id = `race_${driver_id}_${Date.now()}`;
    await pool.query(
      `INSERT INTO race_entries (driver_id, race_id, race_class, total_amount, payment_reference, payment_status, entry_date)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [driver_id, race_id, race_class, payment.amount, payment_reference, 'Completed']
    );

    // Update driver's next race status to "Registered"
    await pool.query(
      'UPDATE drivers SET next_race_entry_status = $1 WHERE driver_id = $2',
      ['Registered', driver_id]
    );

    // If engine rental was included, update that status too
    if (has_engine_rental) {
      await pool.query(
        'UPDATE drivers SET next_race_engine_rental_status = $1 WHERE driver_id = $2',
        ['Registered', driver_id]
      );
      console.log(`✅ Engine rental status updated for driver ${driver_id}`);
    }

    // Log the action
    await logAuditEvent(driver_id, 'payfast', 'RACE_ENTRY_PAYMENT_COMPLETED', 'payment_reference', '', payment_reference);

    console.log(`✅ Race entry payment completed and statuses updated: ${race_id}`);
    res.json({ 
      success: true, 
      data: { 
        message: 'Race entry registered successfully',
        race_id: race_id
      } 
    });
  } catch (err) {
    console.error('❌ completeRaceEntryPayment error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Update Driver Profile
// Contact Admin
app.post('/api/contactAdmin', async (req, res) => {
  try {
    const { driver_id, name, email, registered_email, phone, subject, message } = req.body;
    if (!driver_id || !email || !subject || !message) throw new Error('Missing required fields');

    console.log(`📧 Contact Admin request from: ${email}, Account: ${registered_email}, Subject: ${subject}`);

    // Save message to database
    await pool.query(
      `INSERT INTO admin_messages (driver_id, driver_name, driver_email, registered_email, driver_phone, subject, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [driver_id, name || 'Unknown', email, registered_email || email, phone || '', subject, message]
    );
    console.log(`✅ Message saved to database for driver: ${driver_id}`);

    // Send email notification to admin
    try {
      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MANDRILL_API_KEY,
        message: {
          from_email: 'noreply@rokcup.co.za',
          from_name: 'NATS Driver Registry',
          to: [
            {
              email: 'john@rokcup.co.za',
              name: 'Admin',
              type: 'to'
            }
          ],
          subject: `New Driver Message: ${subject}`,
          html: `
            <h2>New Driver Message</h2>
            <p><strong>From:</strong> ${name} (${email})</p>
            <p><strong>Phone:</strong> ${phone || 'Not provided'}</p>
            <p><strong>Subject:</strong> ${subject}</p>
            <hr />
            <p><strong>Message:</strong></p>
            <p>${message.replace(/\n/g, '<br />')}</p>
            <hr />
            <p><a href="https://rokthenats.co.za/admin.html">View in Admin Panel</a></p>
          `
        }
      });
      console.log(`✅ Admin notification email sent for: ${subject}`);
    } catch (emailErr) {
      console.warn('⚠️ Failed to send email notification:', emailErr.message);
      // Don't fail the request if email fails
    }

    res.json({ success: true, data: { message: 'Your request has been sent to the admin' } });
  } catch (err) {
    console.error('❌ contactAdmin error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get Admin Messages
app.post('/api/getAdminMessages', async (req, res) => {
  try {
    console.log('📨 Retrieving admin messages...');
    const result = await pool.query(
      `SELECT * FROM admin_messages ORDER BY created_at DESC`
    );
    console.log(`✅ Retrieved ${result.rows.length} admin messages`);
    res.json({ success: true, data: { messages: result.rows } });
  } catch (err) {
    console.error('❌ getAdminMessages error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Mark message as read
app.post('/api/markMessageAsRead', async (req, res) => {
  try {
    const { message_id } = req.body;
    if (!message_id) throw new Error('Missing message_id');

    console.log(`✉️ Marking message ${message_id} as read...`);
    await pool.query(
      `UPDATE admin_messages SET read_status = TRUE WHERE id = $1`,
      [message_id]
    );
    console.log(`✅ Message ${message_id} marked as read`);
    res.json({ success: true, data: { message: 'Message marked as read' } });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Submit Race Entry
app.post('/api/submitRaceEntry', async (req, res) => {
  try {
    const { driver_id, race_name, entry_type, notes } = req.body;
    if (!driver_id || !race_name) throw new Error('Missing required fields');

    const race_id = `race_${Date.now()}`;
    await pool.query(
      `INSERT INTO race_entries (driver_id, race_id, race_name, entry_type, notes, entry_date) 
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [driver_id, race_id, race_name, entry_type, notes]
    );

    res.json({ success: true, data: { message: 'Race entry submitted' } });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get Audit Log
// Set Driver Profile
app.post('/api/setDriverPassword', async (req, res) => {
  try {
    const { driver_id, password } = req.body;
    if (!driver_id || !password) throw new Error('Driver ID and password required');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');

    console.log(`🔑 Setting password for driver: ${driver_id}`);
    
    const password_hash = await bcryptjs.hash(password, 10);
    await pool.query(
      'UPDATE drivers SET password_hash = $1 WHERE driver_id = $2',
      [password_hash, driver_id]
    );

    console.log(`✅ Password set successfully for driver: ${driver_id}`);
    res.json({ success: true, data: { message: 'Password set successfully' } });
  } catch (err) {
    console.error('❌ setDriverPassword error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// PayFast ITN webhook
app.post('/api/payfast-itn', async (req, res) => {
  try {
    const { m_payment_id, payment_status, custom_str1, custom_str2, custom_str3 } = req.body;
    const driver_id = custom_str1;
    const race_class = custom_str2;
    const has_engine_rental = custom_str3 === 'YES';
    
    console.log(`📬 PayFast ITN Callback: payment=${m_payment_id}, status=${payment_status}, driver=${driver_id}`);

    // ========================================
    // SIGNATURE VALIDATION - Reject fake webhooks
    // ========================================
    const passphrase = process.env.PAYFAST_PASSPHRASE || '';
    const signatureData = { ...req.body };
    delete signatureData.signature;

    const itnSignatureFields = [
      'm_payment_id', 'pf_payment_id', 'payment_status', 'item_name', 'item_description',
      'amount_gross', 'amount_fee', 'amount_net', 'custom_int1', 'custom_int2', 'custom_int3',
      'custom_int4', 'custom_int5', 'custom_str1', 'custom_str2', 'custom_str3', 'custom_str4',
      'custom_str5', 'name_first', 'name_last', 'email_address', 'cell_number', 'merchant_id'
    ];
    let itnParamString = '';
    for (const field of itnSignatureFields) {
      if (signatureData[field] !== undefined && signatureData[field] !== '') {
        const encoded = encodeURIComponent(signatureData[field]).replace(/%20/g, '+');
        itnParamString += `${field}=${encoded}&`;
      }
    }
    if (passphrase) {
      itnParamString += `passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`,
      itnParamString = itnParamString.replace(/,$/, '');
    } else {
      itnParamString = itnParamString.replace(/&$/, '');
    }
    const itnCalcSig = crypto.createHash('md5').update(itnParamString.trim()).digest('hex');
    const itnSigValid = itnCalcSig === req.body.signature;
    if (!itnSigValid) {
      console.warn(`❌ PayFast ITN signature INVALID - possible spoofed request. Calculated: ${itnCalcSig}, Received: ${req.body.signature}`);
      return res.json({ success: true }); // Return 200 to stop PayFast retrying, but do NOT process
    }
    console.log('✅ PayFast ITN signature valid');
    
    if (payment_status === 'COMPLETE') {
      try {
        // Update payment status
        await pool.query(
          'UPDATE payments SET status = $1, updated_at = NOW() WHERE reference = $2',
          ['Completed', m_payment_id]
        );
        console.log(`✅ Payment marked complete: ${m_payment_id}`);

        // If this is a race entry payment (has custom_str2), register the race entry
        if (driver_id && race_class) {
          await pool.query(
            'UPDATE drivers SET next_race_entry_status = $1 WHERE driver_id = $2',
            ['Registered', driver_id]
          );
          
          if (has_engine_rental) {
            await pool.query(
              'UPDATE drivers SET next_race_engine_rental_status = $1 WHERE driver_id = $2',
              ['Registered', driver_id]
            );
          }
          
          console.log(`✅ Race entry registered for driver ${driver_id}`);
        }
      } catch (e) {
        console.log('Could not update payment/race entry:', e.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('ITN error:', err);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get All Drivers (Admin)
// Diagnostic endpoint to see actual table schema
// Create test driver for debugging
app.post('/api/create-test-driver', requireAdmin, async (req, res) => {
  if (!isDebugEnabled()) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  try {
    const testDriver = {
      first_name: 'Test',
      last_name: 'Driver',
      class: 'OK',
      race_number: '123',
      team_name: 'Test Team',
      coach_name: 'Test Coach',
      kart_brand: 'Test Kart',
      engine_type: 'Test Engine',
      transponder_number: 'TEST-001'
    };

    // Generate a PIN for testing (not hashing since column doesn't exist)
    const pin = '123456';

    let driverId;
    try {
      const result = await pool.query(
        `INSERT INTO drivers (first_name, last_name, class, race_number, team_name, coach_name, kart_brand, engine_type, transponder_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING driver_id`,
        [testDriver.first_name, testDriver.last_name, testDriver.class, testDriver.race_number, 
         testDriver.team_name, testDriver.coach_name, testDriver.kart_brand, testDriver.engine_type,
         testDriver.transponder_number]
      );
      driverId = result.rows[0].driver_id;
      console.log(`✅ Test driver created with ID: ${driverId}`);
    } catch (e) {
      console.log('❌ Full driver insert failed for test driver, trying basic fields:', e.message);
      // Try with minimal fields
      const result = await pool.query(
        `INSERT INTO drivers (first_name, last_name)
         VALUES ($1, $2)
         RETURNING driver_id`,
        [testDriver.first_name, testDriver.last_name]
      );
      driverId = result.rows[0].driver_id;
      console.log(`✅ Test driver created with minimal fields, ID: ${driverId}`);
    }

    // Create test contact with email - try with different column combinations
    try {
      await pool.query(
        `INSERT INTO contacts (driver_id, email, full_name, phone_mobile)
         VALUES ($1, $2, $3, $4)`,
        [driverId, 'test@example.com', 'Test Driver', '555-0000']
      );
      console.log(`✅ Test contact created with email`);
    } catch (e) {
      console.log('❌ Full contact insert failed, trying minimal fields:', e.message);
      try {
        // Try with just driver_id and email
        await pool.query(
          `INSERT INTO contacts (driver_id, email)
           VALUES ($1, $2)`,
          [driverId, 'test@example.com']
        );
        console.log(`✅ Test contact created with minimal fields`);
      } catch (e2) {
        console.log('❌ Could not create contact:', e2.message);
        // Silently fail - contacts table might not exist
      }
    }

    res.json({
      success: true,
      message: 'Test driver created',
      driverId,
      pin
    });
  } catch (err) {
    console.error('❌ create-test-driver error:', err.message);
    res.status(400).json({ success: false, error: { message: safeErrorMessage(err, 'Unable to create test driver') } });
  }
});

app.get('/api/check-schema', requireAdmin, async (req, res) => {
  if (!isDebugEnabled()) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  try {
    // Check drivers table structure
    const driversResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'drivers'
      ORDER BY ordinal_position
    `);
    
    // Get a sample driver to see actual data
    const sampleResult = await pool.query('SELECT * FROM drivers LIMIT 1');
    const countResult = await pool.query('SELECT COUNT(*) as total FROM drivers');
    
    res.json({
      success: true,
      columns: driversResult.rows,
      totalDrivers: countResult.rows[0]?.total || 0,
      sampleDriver: sampleResult.rows[0] || null
    });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: safeErrorMessage(err, 'Unable to inspect schema') } });
  }
});

app.post('/api/getAllDrivers', async (req, res) => {
  try {
    const { email, name, status, paid } = req.body;

    console.log('getAllDrivers called with filters:', { email, name, status, paid });

    // Get all drivers excluding soft-deleted ones
    const driverResult = await pool.query('SELECT * FROM drivers WHERE is_deleted = FALSE OR is_deleted IS NULL LIMIT 1000');
    console.log('Found', driverResult.rows.length, 'drivers from database');

    if (driverResult.rows.length === 0) {
      console.log('No drivers in database, returning empty list');
      return res.json({
        success: true,
        data: { drivers: [] }
      });
    }

    // Get the first driver to inspect what columns actually exist
    const sampleDriver = driverResult.rows[0];
    console.log('Sample driver:', JSON.stringify(sampleDriver, null, 2));
    console.log('Sample driver keys:', Object.keys(sampleDriver));

    const driverIds = driverResult.rows.map(d => d.driver_id);
    console.log('Driver IDs:', driverIds);

    // Get all contact information (email, phone, name, relationship, emergency, consent flags)
    let contactMap = {};
    try {
      const contactResult = await pool.query(
        'SELECT * FROM contacts WHERE driver_id = ANY($1)',
        [driverIds]
      );
      console.log('Found', contactResult.rows.length, 'contact records');
      contactResult.rows.forEach(c => {
        // Store first contact (primary) for each driver
        if (!contactMap[c.driver_id]) {
          contactMap[c.driver_id] = c;
        }
      });
    } catch (e) {
      console.log('Contacts query failed:', e.message);
    }

    // Get emails from contacts table (for backwards compatibility)
    let emailMap = {};
    Object.entries(contactMap).forEach(([driverId, contact]) => {
      if (contact && contact.email) {
        emailMap[driverId] = contact.email;
      }
    });

    // Get payment info - check if payments table has data
    let paidSet = new Set();
    try {
      // First check what columns actually exist in payments table
      const paymentResult = await pool.query(
        "SELECT driver_id FROM payments LIMIT 1000"
      );
      console.log('Found', paymentResult.rows.length, 'payment records');
      // Mark drivers that have payment records as "Paid"
      paymentResult.rows.forEach(p => paidSet.add(p.driver_id));
    } catch (e) {
      console.log('Payments table query failed - table may not exist or have different structure:', e.message);
    }

    // Get medical consent data for all drivers
    let medicalMap = {};
    try {
      const medicalResult = await pool.query(
        'SELECT * FROM medical_consent WHERE driver_id = ANY($1)',
        [driverIds]
      );
      console.log('Found', medicalResult.rows.length, 'medical records');
      medicalResult.rows.forEach(m => {
        medicalMap[m.driver_id] = m;
      });
    } catch (e) {
      console.log('Medical consent query failed:', e.message);
    }

    // Build driver list with only data we know exists
    let drivers = driverResult.rows.map(d => {
      const obj = {
        driver_id: d.driver_id,
        first_name: d.first_name || '',
        last_name: d.last_name || '',
        driver_email: emailMap[d.driver_id] || '',
        paid_status: paidSet.has(d.driver_id) ? 'Paid' : 'Unpaid'
      };
      
      // Add contact information if available
      if (contactMap[d.driver_id]) {
        const contact = contactMap[d.driver_id];
        obj.contact_name = contact.full_name || '';
        obj.contact_phone = contact.phone_mobile || '';
        obj.contact_relationship = contact.relationship || '';
        obj.contact_emergency = contact.emergency_contact || false;
        obj.contact_consent = contact.consent_contact || false;
      }
      
      // Add optional fields if they exist in the returned data
      if (d.class !== undefined) obj.class = d.class || '';
      if (d.race_number !== undefined) obj.race_number = d.race_number || '';
      if (d.team_name !== undefined) obj.team_name = d.team_name || '';
      if (d.coach_name !== undefined) obj.coach_name = d.coach_name || '';
      if (d.kart_brand !== undefined) obj.kart_brand = d.kart_brand || '';
      if (d.engine_type !== undefined) obj.engine_type = d.engine_type || '';
      if (d.license_number !== undefined) obj.license_number = d.license_number || '';
      if (d.transponder_number !== undefined) obj.transponder_number = d.transponder_number || '';
      if (d.status !== undefined) obj.status = d.status || 'Pending';
      if (d.approval_status !== undefined) obj.approval_status = d.approval_status || 'Pending';
      if (d.license_document !== undefined) obj.license_document = d.license_document;
      if (d.profile_photo !== undefined) obj.profile_photo = d.profile_photo;

      // Season & rental status fields
      obj.season_engine_rental         = d.season_engine_rental || 'N';
      obj.paid_engine_fee              = d.season_engine_rental || 'N'; // alias used by admin modal
      obj.season_entry_status          = d.season_entry_status || 'Not Registered';
      obj.next_race_entry_status       = d.next_race_entry_status || 'Not Registered';
      obj.next_race_engine_rental_status = d.next_race_engine_rental_status || 'No';
      obj.national_package             = d.national_package || '';
      
      // Add medical data if available
      if (medicalMap[d.driver_id]) {
        const med = medicalMap[d.driver_id];
        obj.medical_allergies = med.allergies || '';
        obj.medical_conditions = med.medical_conditions || '';
        obj.medical_medication = med.medication || '';
        obj.medical_doctor_phone = med.doctor_phone || '';
        obj.medical_consent_signed = med.consent_signed || '';
        obj.medical_consent_date = med.consent_date || '';
        obj.media_release_signed = med.media_release_signed || '';
      }
      
      return obj;
    });

    console.log('Built', drivers.length, 'driver objects');

    // Apply filters
    if (email && email.trim()) {
      drivers = drivers.filter(d => 
        d.driver_email.toLowerCase().includes(email.toLowerCase())
      );
      console.log('After email filter:', drivers.length);
    }

    if (name && name.trim()) {
      const nameLower = name.toLowerCase();
      drivers = drivers.filter(d => {
        const fullName = `${d.first_name} ${d.last_name}`.toLowerCase();
        return fullName.includes(nameLower);
      });
      console.log('After name filter:', drivers.length);
    }

    if (status && status !== '') {
      drivers = drivers.filter(d => d.status === status || d.approval_status === status);
      console.log('After status filter:', drivers.length);
    }

    if (paid && paid !== '') {
      drivers = drivers.filter(d => d.paid_status === paid);
      console.log('After paid filter:', drivers.length);
    }

    console.log('Returning', drivers.length, 'drivers after all filtering');

    res.json({
      success: true,
      data: { drivers }
    });
  } catch (err) {
    console.error('getAllDrivers error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Update Driver (Admin & Driver Portal)
app.post('/api/updateDriver', async (req, res) => {
  try {
    const { 
      driver_id, first_name, last_name, race_number, team_name, coach_name, kart_brand, 
      class: klass, email, status, paid_status, license_number, transponder_number, 
      season_engine_rental, season_entry_status, next_race_entry_status, next_race_engine_rental_status,
      national_package,
      admin_override 
    } = req.body;
    
    console.log('updateDriver request received');
    console.log('driver_id:', driver_id);
    if (admin_override) console.log('Admin override flag set - logging will show ADMIN_OVERRIDE action');
    
    if (!driver_id) throw new Error('Driver ID required');

    // Get old values for audit log
    const oldResult = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const oldDriver = oldResult.rows[0];
    
    if (!oldDriver) {
      throw new Error('Driver not found');
    }

    // Build UPDATE statement with only the fields we have values for
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (first_name !== undefined && first_name !== null) {
      updates.push(`first_name = $${paramCount++}`);
      values.push(first_name);
    }
    if (last_name !== undefined && last_name !== null) {
      updates.push(`last_name = $${paramCount++}`);
      values.push(last_name);
    }
    if (race_number !== undefined && race_number !== null) {
      updates.push(`race_number = $${paramCount++}`);
      values.push(race_number);
    }
    if (team_name !== undefined && team_name !== null) {
      updates.push(`team_name = $${paramCount++}`);
      values.push(team_name);
    }
    if (coach_name !== undefined && coach_name !== null) {
      updates.push(`coach_name = $${paramCount++}`);
      values.push(coach_name);
    }
    if (kart_brand !== undefined && kart_brand !== null) {
      updates.push(`kart_brand = $${paramCount++}`);
      values.push(kart_brand);
    }
    if (klass !== undefined && klass !== null) {
      updates.push(`class = $${paramCount++}`);
      values.push(klass);
    }
    if (license_number !== undefined && license_number !== null) {
      updates.push(`license_number = $${paramCount}`);
      updates.push(`msa_license_number = $${paramCount++}`);
      values.push(license_number);
    }
    if (transponder_number !== undefined && transponder_number !== null) {
      updates.push(`transponder_number = $${paramCount++}`);
      values.push(transponder_number);
    }
    if (status !== undefined && status !== null) {
      updates.push(`status = $${paramCount++}`);
      values.push(status);
    }
    
    // Payment & Entry Status fields (Admin Override)
    if (season_engine_rental !== undefined && season_engine_rental !== null) {
      updates.push(`season_engine_rental = $${paramCount++}`);
      values.push(season_engine_rental);
    }
    if (season_entry_status !== undefined && season_entry_status !== null) {
      updates.push(`season_entry_status = $${paramCount++}`);
      values.push(season_entry_status);
    }
    if (next_race_entry_status !== undefined && next_race_entry_status !== null) {
      updates.push(`next_race_entry_status = $${paramCount++}`);
      values.push(next_race_entry_status);
    }
    if (next_race_engine_rental_status !== undefined && next_race_engine_rental_status !== null) {
      updates.push(`next_race_engine_rental_status = $${paramCount++}`);
      values.push(next_race_engine_rental_status);
    }
    if (national_package !== undefined) {
      // Allow empty string to clear the package
      updates.push(`national_package = $${paramCount++}`);
      values.push(national_package === '' ? null : national_package);
    }

    // Add driver_id as final parameter
    values.push(driver_id);
    
    // Only execute update if there are fields to update
    if (updates.length > 0) {
      const updateQuery = `UPDATE drivers SET ${updates.join(', ')} WHERE driver_id = $${paramCount}`;
      console.log('Executing update query:', updateQuery);
      console.log('With values:', values);
      
      await pool.query(updateQuery, values);
      console.log('Driver updated successfully');
    }

    // Handle paid status - only mark if payments table exists
    if (paid_status === 'Paid') {
      try {
        // Check if driver already has payment record
        const existsResult = await pool.query('SELECT driver_id FROM payments WHERE driver_id = $1 LIMIT 1', [driver_id]);
        if (existsResult.rows.length === 0) {
          // Try to insert payment record
          try {
            await pool.query(
              `INSERT INTO payments (driver_id) VALUES ($1)`,
              [driver_id]
            );
            console.log('Payment record created');
          } catch (e) {
            console.log('Could not insert payment record:', e.message);
          }
        }
      } catch (e) {
        console.log('Payment handling skipped - payments table may not exist:', e.message);
      }
    }

    // Log changes for audit trail
    try {
      const fieldsChanged = [];
      if (oldDriver.first_name !== first_name) fieldsChanged.push({ field: 'first_name', old: oldDriver.first_name, new: first_name });
      if (oldDriver.last_name !== last_name) fieldsChanged.push({ field: 'last_name', old: oldDriver.last_name, new: last_name });
      if (oldDriver.race_number !== race_number) fieldsChanged.push({ field: 'race_number', old: oldDriver.race_number, new: race_number });
      if (oldDriver.team_name !== team_name) fieldsChanged.push({ field: 'team_name', old: oldDriver.team_name, new: team_name });
      if (oldDriver.coach_name !== coach_name) fieldsChanged.push({ field: 'coach_name', old: oldDriver.coach_name, new: coach_name });
      if (oldDriver.kart_brand !== kart_brand) fieldsChanged.push({ field: 'kart_brand', old: oldDriver.kart_brand, new: kart_brand });
      if (oldDriver.class !== klass) fieldsChanged.push({ field: 'class', old: oldDriver.class, new: klass });
      if (oldDriver.status !== status) fieldsChanged.push({ field: 'status', old: oldDriver.status, new: status });
      if (oldDriver.license_number !== license_number) fieldsChanged.push({ field: 'license_number', old: oldDriver.license_number, new: license_number });
      if (oldDriver.transponder_number !== transponder_number) fieldsChanged.push({ field: 'transponder_number', old: oldDriver.transponder_number, new: transponder_number });
      
      // Track payment/entry status changes (Admin Override)
      if (oldDriver.season_engine_rental !== season_engine_rental && season_engine_rental !== undefined) {
        fieldsChanged.push({ field: 'season_engine_rental', old: oldDriver.season_engine_rental, new: season_engine_rental, isAdminOverride: true });
      }
      if (oldDriver.season_entry_status !== season_entry_status && season_entry_status !== undefined) {
        fieldsChanged.push({ field: 'season_entry_status', old: oldDriver.season_entry_status, new: season_entry_status, isAdminOverride: true });
      }
      if (oldDriver.next_race_entry_status !== next_race_entry_status && next_race_entry_status !== undefined) {
        fieldsChanged.push({ field: 'next_race_entry_status', old: oldDriver.next_race_entry_status, new: next_race_entry_status, isAdminOverride: true });
      }
      if (oldDriver.next_race_engine_rental_status !== next_race_engine_rental_status && next_race_engine_rental_status !== undefined) {
        fieldsChanged.push({ field: 'next_race_engine_rental_status', old: oldDriver.next_race_engine_rental_status, new: next_race_engine_rental_status, isAdminOverride: true });
      }

      for (const change of fieldsChanged) {
        // Use TITAN_EDIT if email is 'TITAN', otherwise use ADMIN_OVERRIDE for admin changes, or UPDATE_PROFILE for normal changes
        let action = 'UPDATE_PROFILE';
        if (email === 'TITAN') {
          action = 'TITAN_EDIT';
        } else if (change.isAdminOverride && admin_override) {
          action = 'ADMIN_OVERRIDE';
        }
        await logAuditEvent(driver_id, email || 'admin', action, change.field, String(change.old || ''), String(change.new || ''));
      }
    } catch (auditErr) {
      console.log('Audit logging failed (non-critical):', auditErr.message);
    }

    // Fetch updated driver data from database to confirm save
    const updatedResult = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const updatedDriver = updatedResult.rows[0];
    
    if (!updatedDriver) {
      throw new Error('Could not verify driver update - driver not found after save');
    }
    
    console.log('Driver updated and verified from database:', driver_id);
    
    // Send admin notification for profile updates
    try {
      if (updates.length > 0) {
        const fieldsUpdated = updates.map(u => u.split(' = ')[0]).join(', ');
        adminNotificationQueue.addNotification({
          action: 'Profile Update',
          subject: `[Profile] ${first_name || oldDriver.first_name} ${last_name || oldDriver.last_name} updated profile`,
          details: {
            driverId: driver_id,
            driverName: `${first_name || oldDriver.first_name} ${last_name || oldDriver.last_name}`,
            class: klass || oldDriver.class,
            fieldsUpdated: fieldsUpdated || 'None',
            adminOverride: admin_override ? 'Yes' : 'No',
            timestamp: new Date().toLocaleString()
          }
        });
      }
    } catch (e) { /* Silent fail */ }
    
    res.json({ 
      success: true, 
      data: { 
        message: 'Profile updated',
        driver: updatedDriver  // Return the verified updated driver data
      } 
    });
  } catch (err) {
    console.error('updateDriver error:', err.message);
    console.error('Full error:', err);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Send Password Reset (Admin)
app.post('/api/sendPasswordReset', async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) throw new Error('Driver ID required');

    const driverResult = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const driver = driverResult.rows[0];
    if (!driver) throw new Error('Driver not found');

    const contactResult = await pool.query('SELECT email FROM contacts WHERE driver_id = $1 LIMIT 1', [driver_id]);
    const email = contactResult.rows[0]?.email;
    if (!email) throw new Error('Driver email not found');

    const reset_token = crypto.randomBytes(32).toString('hex');
    const reset_token_hash = crypto.createHash('sha256').update(reset_token).digest('hex');
    const reset_token_expiry = new Date(Date.now() + 3600000);

    await pool.query(
      'UPDATE drivers SET reset_token = $1, reset_token_expiry = $2 WHERE driver_id = $3',
      [reset_token_hash, reset_token_expiry, driver_id]
    );

    const resetLink = `https://rokthenats.co.za/reset-password.html?token=${reset_token}&email=${encodeURIComponent(email)}`;
    const emailHtml = loadEmailTemplate('password-reset', {
      RESET_LINK: resetLink
    });
    await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
      key: process.env.MAILCHIMP_API_KEY,
      message: {
        to: [{ email: email }],
        from_email: process.env.MAILCHIMP_FROM_EMAIL,
        subject: 'Reset Your NATS Driver Registry Password',
        html: emailHtml
      }
    }).catch(err => console.error('Email error:', err.message));

    await logAuditEvent(driver_id, 'admin', 'PASSWORD_RESET_SENT', 'password', 'sent', email);

    res.json({ success: true, data: { message: 'Password reset email sent' } });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Download driver file (license or photo)
app.post('/api/downloadDriverFile', async (req, res) => {
  try {
    const { driver_id, file_type } = req.body;
    if (!driver_id || !file_type) throw new Error('Driver ID and file type required');

    const result = await pool.query('SELECT license_document, profile_photo FROM drivers WHERE driver_id = $1', [driver_id]);
    const driver = result.rows[0];
    if (!driver) throw new Error('Driver not found');

    let fileData = null;
    if (file_type === 'license' && driver.license_document) {
      try {
        fileData = JSON.parse(driver.license_document);
      } catch (e) {
        console.log('Could not parse license document:', e.message);
      }
    } else if (file_type === 'photo' && driver.profile_photo) {
      try {
        fileData = JSON.parse(driver.profile_photo);
      } catch (e) {
        console.log('Could not parse profile photo:', e.message);
      }
    }

    if (!fileData || !fileData.b64) throw new Error(`No ${file_type} found for this driver`);

    // Return base64 data so client can display/download
    res.json({
      success: true,
      data: {
        fileName: fileData.name,
        mimeType: fileData.mime,
        b64: fileData.b64
      }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get Database Table Data
app.post('/api/getDatabaseTable', async (req, res) => {
  try {
    const { table, filter = {}, limit = 100 } = req.body;
    if (!table) throw new Error('Missing table name');

    // Whitelist allowed tables to prevent SQL injection
    const allowedTables = ['drivers', 'admin_messages', 'audit_log', 'race_entries', 'rentals'];
    if (!allowedTables.includes(table)) {
      throw new Error('Invalid table name');
    }

    // Get row count
    const countResult = await pool.query(`SELECT COUNT(*) as count FROM ${table}`);
    const rowCount = parseInt(countResult.rows[0].count);

    // Build where clause for filtering
    let whereClause = '';
    let params = [];
    let paramIndex = 1;

    if (filter && Object.keys(filter).length > 0) {
      const conditions = [];
      for (const [key, value] of Object.entries(filter)) {
        // SECURITY: Validate column name - only allow alphanumeric + underscore (prevents SQL injection)
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          throw new Error(`Invalid filter column name: ${key}`);
        }
        if (value && String(value).trim()) {
          conditions.push(`${key} ILIKE $${paramIndex}`);
          params.push(`%${String(value).trim()}%`);
          paramIndex++;
        }
      }
      if (conditions.length > 0) {
        whereClause = ' WHERE ' + conditions.join(' AND ');
      }
    }

    // Add limit parameter
    params.push(limit);
    const limitParam = `$${paramIndex}`;

    // Determine order by - handle different primary keys
    let orderBy = '';
    if (table === 'drivers') {
      orderBy = ' ORDER BY driver_id DESC';
    } else if (table === 'admin_messages') {
      orderBy = ' ORDER BY created_at DESC';
    } else if (table === 'audit_log') {
      orderBy = ' ORDER BY created_at DESC';
    } else {
      orderBy = ' ORDER BY id DESC';
    }

    // Get data (limit to specified rows for performance)
    const result = await pool.query(
      `SELECT * FROM ${table}${whereClause}${orderBy} LIMIT ${limitParam}`,
      params
    );

    res.json({
      success: true,
      data: {
        rows: result.rows,
        rowCount: rowCount,
        displayCount: result.rows.length,
        table: table
      }
    });
  } catch (err) {
    console.error('getDatabaseTable error:', err);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Soft Delete Driver (Admin)
app.post('/api/admin/deleteDriver', async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) throw new Error('Driver ID required');

    // Check if driver exists
    const checkResult = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    if (checkResult.rows.length === 0) throw new Error('Driver not found');

    const driver = checkResult.rows[0];

    // Soft delete: mark as deleted instead of removing
    await pool.query(
      'UPDATE drivers SET is_deleted = TRUE, deleted_at = NOW() WHERE driver_id = $1',
      [driver_id]
    );

    console.log(`🗑️ Driver soft deleted: ${driver_id} (${driver.first_name} ${driver.last_name})`);

    // Log the deletion to audit trail
    try {
      await logAuditEvent(driver_id, 'admin', 'DRIVER_DELETED', 'status', 'active', 'deleted');
    } catch (auditErr) {
      console.log('Audit logging failed (non-critical):', auditErr.message);
    }

    res.json({
      success: true,
      data: { message: `Driver ${driver.first_name} ${driver.last_name} has been deleted` }
    });
  } catch (err) {
    console.error('❌ deleteDriver error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Restore Deleted Driver (Admin)
app.post('/api/admin/restoreDriver', async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) throw new Error('Driver ID required');

    // Check if driver exists and is deleted
    const checkResult = await pool.query('SELECT * FROM drivers WHERE driver_id = $1 AND is_deleted = TRUE', [driver_id]);
    if (checkResult.rows.length === 0) throw new Error('Deleted driver not found');

    const driver = checkResult.rows[0];

    // Restore the driver
    await pool.query(
      'UPDATE drivers SET is_deleted = FALSE, deleted_at = NULL WHERE driver_id = $1',
      [driver_id]
    );

    console.log(`✅ Driver restored: ${driver_id} (${driver.first_name} ${driver.last_name})`);

    // Log the restoration to audit trail
    try {
      await logAuditEvent(driver_id, 'admin', 'DRIVER_RESTORED', 'status', 'deleted', 'active');
    } catch (auditErr) {
      console.log('Audit logging failed (non-critical):', auditErr.message);
    }

    res.json({
      success: true,
      data: { message: `Driver ${driver.first_name} ${driver.last_name} has been restored` }
    });
  } catch (err) {
    console.error('❌ restoreDriver error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Debug PayFast credentials
app.get('/api/debug/payfast', (req, res) => {
  res.json({
    sandbox: payfastSandboxMode,
    mode: payfastSandboxMode ? 'SANDBOX' : 'LIVE',
    merchantId: getPayFastConfig().merchantId ? 'SET' : 'NOT SET',
    merchantKey: getPayFastConfig().merchantKey ? `SET (length: ${getPayFastConfig().merchantKey.length})` : 'NOT SET',
    passphrase: getPayFastConfig().passphrase ? 'SET' : 'NOT SET',
    processUrl: getPayFastConfig().processUrl,
    returnUrl: process.env.PAYFAST_RETURN_URL || 'NOT SET',
    cancelUrl: process.env.PAYFAST_CANCEL_URL || 'NOT SET',
    notifyUrl: process.env.PAYFAST_NOTIFY_URL || 'NOT SET'
  });
});

// GET current PayFast mode (admin)
app.get('/api/admin/payfastMode', (req, res) => {
  const cfg = getPayFastConfig();
  res.json({
    success: true,
    sandbox: payfastSandboxMode,
    mode: payfastSandboxMode ? 'SANDBOX' : 'LIVE',
    merchantId: cfg.merchantId,
    processUrl: cfg.processUrl,
    notifyUrl: process.env.PAYFAST_NOTIFY_URL || 'https://www.rokthenats.co.za/api/paymentNotify'
  });
});

// POST toggle PayFast sandbox/live mode (admin)
app.post('/api/admin/payfastMode', (req, res) => {
  try {
    const { sandbox } = req.body;
    if (typeof sandbox !== 'boolean') {
      return res.status(400).json({ success: false, error: 'sandbox must be true or false' });
    }

    payfastSandboxMode = sandbox;

    // Persist to .env so the setting survives a server restart
    try {
      const envPath = path.join(__dirname, '.env');
      let envContent = fs.readFileSync(envPath, 'utf8');
      if (envContent.includes('PAYFAST_SANDBOX=')) {
        envContent = envContent.replace(/PAYFAST_SANDBOX=.*/g, `PAYFAST_SANDBOX=${payfastSandboxMode}`);
      } else {
        envContent += `\nPAYFAST_SANDBOX=${payfastSandboxMode}`;
      }
      fs.writeFileSync(envPath, envContent);
      console.log(`💾 Persisted PAYFAST_SANDBOX=${payfastSandboxMode} to .env`);
    } catch (writeErr) {
      console.warn('⚠️ Could not write .env (mode still changed for this session):', writeErr.message);
    }

    const cfg = getPayFastConfig();
    console.log(`🔄 PayFast mode switched to: ${payfastSandboxMode ? '🧪 SANDBOX' : '🔴 LIVE'} by admin`);

    res.json({
      success: true,
      sandbox: payfastSandboxMode,
      mode: payfastSandboxMode ? 'SANDBOX' : 'LIVE',
      merchantId: cfg.merchantId,
      processUrl: cfg.processUrl
    });
  } catch (err) {
    console.error('❌ payfastMode toggle error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Initiate Race Entry Payment via PayFast
app.get('/api/initiateRacePayment', async (req, res) => {
  try {
    const { class: raceClass, amount, email, eventId, driverId, items } = req.query;
    
    if (!raceClass || !amount) {
      throw new Error('Missing class or amount');
    }
    
    if (!eventId || !driverId) {
      throw new Error('Missing event ID or driver ID');
    }
    
    // Parse selected items to know what tickets to generate
    // NOTE: Express already URL-decodes query parameters, so req.query.items is already decoded
    let selectedItems = [];
    try {
      if (items) {
        console.log(`📦 Raw items parameter from Express:`, items);
        selectedItems = JSON.parse(items);  // Just parse, don't decode again!
        console.log(`📦 Parsed selectedItems:`, selectedItems);
      }
    } catch (e) {
      console.error('❌ CRITICAL: Could not parse items parameter:', e.message);
      console.error('❌ Raw items parameter:', items);
      console.error('❌ This will result in NO rental items being recorded!');
      // Still continue - user will at least get race entry, but no rental items
    }

    // Use provided email or fallback to noreply
    const driverEmail = email && email.trim() ? email.trim().toLowerCase() : 'noreply@nats.co.za';
    console.log(`💳 Payment email: ${driverEmail}`);

    // Clean and parse amount - handle both SA and international formats
    // South African: 10 170,00 (space=thousand, comma=decimal)
    // International: 10,170.00 (comma=thousand, period=decimal)
    let cleanAmount = String(amount)
      .replace(/R/g, '')           // Remove R currency symbol
      .replace(/\s/g, '')          // Remove spaces (thousand separator)
      .trim();
    
    // Smart comma/period handling
    if (cleanAmount.includes(',') && cleanAmount.includes('.')) {
      // Both present: comma is thousand separator (international: 10,170.00)
      cleanAmount = cleanAmount.replace(/,/g, '');  // Remove commas, keep period
    } else if (cleanAmount.includes(',')) {
      // Only comma: it's decimal separator (SA: 10170,00)
      cleanAmount = cleanAmount.replace(',', '.');  // Convert to period
    }
    // If only period exists, it's already correct
    
    const numAmount = parseFloat(cleanAmount);
    console.log(`💰 Amount parsing: "${amount}" → "${cleanAmount}" → ${numAmount}`);
    
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error(`Invalid amount: ${amount} (parsed as ${cleanAmount})`);
    }

    console.log(`💳 Initiating PayFast payment: ${raceClass} - R${numAmount.toFixed(2)} for event ${eventId}`);

    // PayFast credentials - auto-switches between LIVE and SANDBOX based on admin toggle
    const pfCfg = getPayFastConfig();
    const merchantId = pfCfg.merchantId;
    const merchantKey = pfCfg.merchantKey;
    if (!merchantId || !merchantKey) {
      throw new Error('PayFast credentials not configured on server');
    }
    console.log(`💳 PayFast mode: ${payfastSandboxMode ? '🧪 SANDBOX' : '🔴 LIVE'}`);
    const returnUrl = process.env.PAYFAST_RETURN_URL || 'https://www.rokthenats.co.za/payment-success.html';
    const cancelUrl = process.env.PAYFAST_CANCEL_URL || 'https://www.rokthenats.co.za/payment-cancel.html';
    const notifyUrl = process.env.PAYFAST_NOTIFY_URL || 'https://www.rokthenats.co.za/api/paymentNotify';

    // ✅ DEDUP: Check for an existing pending entry for this driver+event within last 10 minutes
    // Prevents duplicate entries/emails when user taps Pay button multiple times
    let reference, race_entry_id, ticketEngineRef, ticketTyresRef, ticketTransponderRef, ticketFuelRef;
    let hasEngine = false, hasTyres = false, hasTransponder = false, hasFuel = false;
    let isReusedEntry = false;

    const recentPendingResult = await pool.query(
      `SELECT entry_id, payment_reference, ticket_engine_ref, ticket_tyres_ref, ticket_transponder_ref, ticket_fuel_ref
       FROM race_entries
       WHERE driver_id = $1
         AND event_id = $2
         AND payment_status = 'Pending'
         AND entry_status = 'pending_payment'
         AND created_at > NOW() - INTERVAL '10 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      [driverId, eventId]
    );

    if (recentPendingResult.rows.length > 0) {
      // Reuse the existing pending entry — no duplicate DB row, no duplicate email
      const existing = recentPendingResult.rows[0];
      reference          = existing.payment_reference;
      race_entry_id      = existing.entry_id;
      ticketEngineRef    = existing.ticket_engine_ref;
      ticketTyresRef     = existing.ticket_tyres_ref;
      ticketTransponderRef = existing.ticket_transponder_ref;
      ticketFuelRef      = existing.ticket_fuel_ref;
      isReusedEntry      = true;
      console.log(`♻️ Reusing existing pending entry ${race_entry_id} (reference: ${reference}) — duplicate initiation suppressed`);
    } else {
      // Fresh entry — generate new reference and ticket refs
      reference     = `RACE-${eventId}-${driverId}-${Date.now()}`;
      race_entry_id = `race_entry_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      // Parse selected items to determine what tickets to generate
      const itemsLower = selectedItems.map(i => (i || '').toLowerCase());
      hasEngine      = itemsLower.some(i => i.includes('engine') || i.includes('rental'));
      hasTyres       = itemsLower.some(i => i.includes('tyre'));
      hasTransponder = itemsLower.some(i => i.includes('transponder'));
      hasFuel        = itemsLower.some(i => i.includes('fuel'));

      ticketEngineRef      = hasEngine      ? generateUniqueTicketRef('engine', driverId, eventId)      : null;
      ticketTyresRef       = hasTyres       ? generateUniqueTicketRef('tyres', driverId, eventId)       : null;
      ticketTransponderRef = hasTransponder ? generateUniqueTicketRef('transponder', driverId, eventId) : null;
      ticketFuelRef        = hasFuel        ? generateUniqueTicketRef('fuel', driverId, eventId)        : null;

      console.log(`🎫 Creating pending entry with items:`);
      console.log(`   - selectedItems array:`, selectedItems);
      console.log(`   - hasEngine: ${hasEngine}, ticketEngineRef: ${ticketEngineRef}`);
      console.log(`   - hasTyres: ${hasTyres}, ticketTyresRef: ${ticketTyresRef}`);
      console.log(`   - hasTransponder: ${hasTransponder}, ticketTransponderRef: ${ticketTransponderRef}`);
      console.log(`   - hasFuel: ${hasFuel}, ticketFuelRef: ${ticketFuelRef}`);
    }

    try {
      if (!isReusedEntry) {
      await pool.query(
        `INSERT INTO race_entries (
          entry_id, event_id, driver_id, payment_reference, 
          payment_status, entry_status, amount_paid, race_class,
          entry_items,
          ticket_engine_ref, ticket_tyres_ref, ticket_transponder_ref, ticket_fuel_ref,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
        [race_entry_id, eventId, driverId, reference, 'Pending', 'pending_payment', numAmount, raceClass,
         JSON.stringify(selectedItems), ticketEngineRef, ticketTyresRef, ticketTransponderRef, ticketFuelRef]
      );
      console.log(`📝 Created pending race entry: ${race_entry_id} with reference ${reference}`);
      
      // ✅ SEND IMMEDIATE CONFIRMATION EMAIL WITH TICKETS
      try {
        // Get driver details
        const driverResult = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driverId]);
        const driver = driverResult.rows[0];
        const driverName = driver ? `${driver.first_name || ''} ${driver.last_name || ''}`.trim() : 'Driver';
        
        // Get event details
        let eventName = 'Race Event';
        let eventDateStr = 'TBA';
        let eventLocation = 'TBA';
        let eventDate = null;
        
        const eventResult = await pool.query('SELECT * FROM events WHERE event_id = $1', [eventId]);
        const eventDetails = eventResult.rows[0];
        if (eventDetails) {
          eventName = eventDetails.event_name || 'Race Event';
          eventDate = eventDetails.event_date;
          eventDateStr = eventDetails.event_date 
            ? new Date(eventDetails.event_date).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
            : 'TBA';
          eventLocation = eventDetails.location || 'TBA';
        }
        
        // Build rental tickets HTML using the beautiful ticket generators
        let rentalTicketsHtml = '';
        if (hasEngine && ticketEngineRef) {
          rentalTicketsHtml += generateEngineRentalTicketHTML({
            reference: ticketEngineRef,
            eventName,
            eventDate,
            eventLocation,
            raceClass,
            driverName,
            raceNumber: driver?.race_number
          });
        }
        if (hasTyres && ticketTyresRef) {
          rentalTicketsHtml += generateTyreRentalTicketHTML({
            reference: ticketTyresRef,
            eventName,
            eventDate,
            eventLocation,
            raceClass,
            driverName
          });
        }
        if (hasTransponder && ticketTransponderRef) {
          rentalTicketsHtml += generateTransponderRentalTicketHTML({
            reference: ticketTransponderRef,
            eventName,
            eventDate,
            eventLocation,
            raceClass,
            driverName
          });
        }
        if (hasFuel && ticketFuelRef) {
          rentalTicketsHtml += generateFuelTicketHTML({
            reference: ticketFuelRef,
            eventName,
            eventDate,
            eventLocation,
            raceClass,
            driverName
          });
        }
        
        // Email HTML template
        const emailHtml = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Race Entry Confirmation — NATS 2026 ROK Cup</title>
            <style>
              body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #333; background: #f5f5f5; margin: 0; padding: 0; }
              .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
              .header { background: white; padding: 20px; text-align: center; border-bottom: 3px solid #22c55e; }
              .header-logo { margin-bottom: 16px; }
              .header-logo img { width: 140px; height: auto; }
              .header h1 { margin: 0; font-size: 24px; font-weight: 700; color: #111827; }
              .content { padding: 30px; }
              .details { background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22c55e; }
              .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
              .detail-row:last-child { border-bottom: none; }
              .detail-label { font-weight: 600; color: #6b7280; font-size: 13px; }
              .detail-value { color: #111827; font-weight: 500; }
              .amount { font-size: 22px; font-weight: 700; color: #22c55e; }
              .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; }
            </style>
          </head>
          <body style="margin: 0; padding: 20px;">
            <div class="container">
              <div class="header">
                <div class="header-logo">
                  <img src="https://www.dropbox.com/scl/fi/ryhszrvk76kd7yy6y0rtc/ROK-CUP-LOGO-2025.png?rlkey=k9dxlzbh5e9zw58v8t34yjzea&dl=1" alt="ROK Cup South Africa" />
                </div>
                <h1>Race Entry Confirmed</h1>
              </div>
              <div class="content">
                <p style="margin: 0 0 16px 0; font-size: 15px;">Hi ${driverName},</p>
                <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151;">Your race entry has been registered! Payment processing will complete shortly. Thank you for registering with the NATS 2026 ROK Cup!</p>
                
                <div class="details">
                  <div class="detail-row">
                    <span class="detail-label">Entry Reference</span>
                    <span class="detail-value">${reference}</span>
                  </div>
                  <div class="detail-row">
                    <span class="detail-label">Event Name</span>
                    <span class="detail-value">${eventName}</span>
                  </div>
                  <div class="detail-row">
                    <span class="detail-label">Event Date</span>
                    <span class="detail-value">${eventDateStr}</span>
                  </div>
                  <div class="detail-row">
                    <span class="detail-label">Location</span>
                    <span class="detail-value">${eventLocation}</span>
                  </div>
                  <div class="detail-row">
                    <span class="detail-label">Race Class</span>
                    <span class="detail-value">${raceClass}</span>
                  </div>
                  <div class="detail-row">
                    <span class="detail-label">Amount</span>
                    <span class="detail-value amount">R${numAmount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                  <div class="detail-row">
                    <span class="detail-label">Registration Date</span>
                    <span class="detail-value">${new Date().toLocaleDateString('en-ZA')}</span>
                  </div>
                </div>
                
                ${generateRaceTicketHTML({
                  reference,
                  eventName,
                  eventDate,
                  eventLocation,
                  raceClass,
                  driverName,
                  teamCode: null
                })}
                
                ${rentalTicketsHtml}
                
                <p style="margin: 20px 0; font-size: 14px; color: #374151;">Your payment will be processed by PayFast. Once confirmed, your entry status will be updated to "Completed". If you have any questions, please contact us.</p>
                
                <p style="margin: 20px 0 0 0; font-size: 14px;">Best regards,<br><strong style="color: #22c55e;">NATS 2026 ROK Cup Team</strong></p>
              </div>
              <div class="footer">
                <p style="margin: 0; color: #6b7280;">This is an automated confirmation email. Please do not reply to this message.</p>
                <p style="margin: 8px 0 0 0;"><a href="https://rokthenats.co.za/" style="color: #2563eb; text-decoration: none; font-weight: 600;">Visit the NATS Event Hub</a></p>
              </div>
            </div>
          </body>
          </html>
        `;

        // Send to driver
        await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
          key: process.env.MAILCHIMP_API_KEY,
          message: {
            to: [{ email: driverEmail, name: driverName }],
            bcc_address: 'africankartingcup@gmail.com',
            from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
            from_name: 'The ROK Cup',
            subject: `Race Entry Confirmed - ${eventName} (${raceClass})`,
            html: emailHtml
          }
        });
        
        console.log(`📧 IMMEDIATE confirmation email sent to driver: ${driverEmail}`);

        // Send to John (CC)
        await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
          key: process.env.MAILCHIMP_API_KEY,
          message: {
            to: [{ email: 'john@rokcup.co.za', name: 'John' }],
            bcc_address: 'africankartingcup@gmail.com',
            from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
            from_name: 'The ROK Cup',
            subject: `New Entry - ${driverName} (${raceClass})`,
            html: emailHtml
          }
        });
        
        console.log(`📧 IMMEDIATE confirmation email sent to john@rokcup.co.za`);

        // ========================================
        // CREATE TRELLO CARD (Before PayFast redirect)
        // ========================================
        try {
          console.log('📋 Creating Trello card for new race entry (before PayFast redirect)...');
          
          await createTrelloCard(
            driverName,
            driverEmail,
            raceClass,
            null, // teamCode - not available at this point
            reference,
            driverId
          );
          
          console.log(`✅ Trello card created for ${driverName} before PayFast redirect`);
        } catch (trelloErr) {
          console.error('⚠️ Trello card creation failed (non-critical):', trelloErr.message);
          // Don't fail the payment initiation if Trello fails
        }

      } catch (emailErr) {
        console.error('⚠️ IMMEDIATE email sending failed (non-critical):', emailErr.message);
        // Don't fail the payment initiation if email fails
      }
      } // end if (!isReusedEntry)
      
    } catch (dbErr) {
      console.error('⚠️ Could not create pending entry (non-fatal):', dbErr.message);
      // Don't fail the payment - just log and continue
    }

    // Build PayFast parameters for the redirect URL
    // These are the parameters that will be sent to PayFast
    const pfDataForPayFast = {
      merchant_id: merchantId,
      merchant_key: merchantKey,
      return_url: returnUrl,
      cancel_url: cancelUrl,
      notify_url: notifyUrl,
      name_first: 'Race',
      name_last: 'Entry',
      email_address: driverEmail,
      amount: numAmount.toFixed(2),
      item_name: `Race Entry - ${raceClass}`,
      item_description: `Race Entry for ${raceClass} Class`,
      reference: reference
    };

    // Build PayFast parameters in EXACT DOCUMENTATION ORDER per PayFast spec
    // PayFast signature spec: ALL form fields EXCEPT 'signature' itself are included
    // merchant_key IS included in the hash (PayFast PHP SDK confirms this)
    const pfDataOrdered = [
      ['merchant_id', merchantId],
      ['merchant_key', merchantKey],
      ['return_url', returnUrl],
      ['cancel_url', cancelUrl],
      ['notify_url', notifyUrl],
      ['name_first', 'Race'],
      ['name_last', 'Entry'],
      ['email_address', driverEmail],
      ['m_payment_id', reference],   // must match the form field name exactly
      ['amount', numAmount.toFixed(2)],
      ['item_name', `Race Entry - ${raceClass}`],
      ['item_description', `Race Entry for ${raceClass} Class`]
    ];

    // Create MD5 signature in EXACT documentation order
    let pfParamString = '';
    
    console.log(`🔐 Building signature in EXACT Documentation Order:`);
    
    for (const [key, value] of pfDataOrdered) {
      if (value !== null && value !== '') {
        // URL encode: spaces become +, use UPPERCASE hex encoding
        const encoded = encodeURIComponent(value).replace(/%20/g, '+');
        pfParamString += `${key}=${encoded}&`;
        console.log(`  ${key}=${encoded}`);
      }
    }
    
    // Append passphrase at the very end (as per PayFast spec)
    const actualPassphrase = pfCfg.passphrase;
    const passphraseEncoded = encodeURIComponent(actualPassphrase).replace(/%20/g, '+');
    if (actualPassphrase) {
      pfParamString += `passphrase=${passphraseEncoded}`;
      console.log(`  passphrase=[REDACTED]`);
    } else {
      pfParamString = pfParamString.replace(/&$/, '');
    }
    console.log(`🔐 Full signature string: ${pfParamString}`);

    const signature = crypto
      .createHash('md5')
      .update(pfParamString.trim())  // ✅ TRIM to remove any trailing whitespace
      .digest('hex');

    console.log(`✅ Generated signature: ${signature}`);
    console.log(`💳 Merchant ID: ${merchantId}`);

    // Return HTML form that POSTs to PayFast
    // KEY: Form fields contain RAW (unencoded) values
    // The signature was calculated using ENCODED values, but the form sends RAW values
    const formHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Processing Payment...</title>
        <style>
          body { font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f5f5f5; }
          .container { text-align: center; }
          .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Redirecting to Payment...</h1>
          <div class="spinner"></div>
          <p>Amount: <strong>R${numAmount.toFixed(2)}</strong></p>
          <p>Class: <strong>${raceClass}</strong></p>
          <p>Reference: <strong>${reference}</strong></p>
          ${payfastSandboxMode ? '<p style="color:#f59e0b;font-weight:bold;">🧪 SANDBOX TEST MODE</p>' : ''}
        </div>
        <form id="paymentForm" method="POST" action="${pfCfg.processUrl}">
          <!-- RAW (unencoded) form values -->
          <input type="hidden" name="merchant_id" value="${merchantId}">
          <input type="hidden" name="merchant_key" value="${merchantKey}">
          <input type="hidden" name="return_url" value="${returnUrl}">
          <input type="hidden" name="cancel_url" value="${cancelUrl}">
          <input type="hidden" name="notify_url" value="${notifyUrl}">
          <input type="hidden" name="name_first" value="Race">
          <input type="hidden" name="name_last" value="Entry">
          <input type="hidden" name="email_address" value="${driverEmail}">
          <input type="hidden" name="m_payment_id" value="${reference}">
          <input type="hidden" name="amount" value="${numAmount.toFixed(2)}">
          <input type="hidden" name="item_name" value="Race Entry - ${raceClass}">
          <input type="hidden" name="item_description" value="Race Entry for ${raceClass} Class">
          <input type="hidden" name="signature" value="${signature}">
        </form>
        <script>
          // Auto-submit form after a short delay
          setTimeout(function() {
            document.getElementById('paymentForm').submit();
          }, 1000);
        </script>
      </body>
      </html>
    `;

    res.send(formHtml);
  } catch (err) {
    console.error('❌ initiateRacePayment error:', err.message);
    res.status(400).send(`<h1>Payment Error</h1><p>${err.message}</p><p><a href="/">Back to Home</a></p>`);
  }
});

// Initiate Pool Engine Rental Payment via PayFast
app.get('/api/initiatePoolEnginePayment', async (req, res) => {
  try {
    const { class: rentalClass, rentalType, amount, email, driverId } = req.query;
    
    if (!rentalClass || !rentalType || !amount) {
      throw new Error('Missing class, rental type, or amount');
    }
    
    if (!driverId) {
      throw new Error('Missing driver ID');
    }

    const driverEmail = email && email.trim() ? email.trim().toLowerCase() : 'noreply@nats.co.za';
    console.log(`💳 Pool Engine Payment email: ${driverEmail}`);

    // Clean and parse amount
    let cleanAmount = String(amount)
      .replace(/R/g, '')
      .replace(/\s/g, '')
      .replace(/,/g, '.')
      .trim();
    const numAmount = parseFloat(cleanAmount);
    
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error(`Invalid amount: ${amount}`);
    }

    console.log(`💳 Initiating PayFast payment: Pool Engine ${rentalType} for ${rentalClass} - R${numAmount.toFixed(2)}`);

    // PayFast credentials - auto-switches between LIVE and SANDBOX based on admin toggle
    const pfCfg = getPayFastConfig();
    const merchantId = pfCfg.merchantId;
    const merchantKey = pfCfg.merchantKey;
    if (!merchantId || !merchantKey) {
      throw new Error('PayFast credentials not configured on server');
    }
    console.log(`💳 PayFast mode (pool engine): ${payfastSandboxMode ? '🧪 SANDBOX' : '🔴 LIVE'}`);
    const returnUrl = process.env.PAYFAST_RETURN_URL || 'https://www.rokthenats.co.za/payment-success.html';
    const cancelUrl = process.env.PAYFAST_CANCEL_URL || 'https://www.rokthenats.co.za/payment-cancel.html';
    const notifyUrl = process.env.PAYFAST_NOTIFY_URL || 'https://www.rokthenats.co.za/api/paymentNotify';

    const reference = `POOL-${rentalClass}-${rentalType}-${driverId}-${Date.now()}`;

    // PayFast signature includes ALL fields except 'signature' itself — merchant_key IS included
    const pfDataOrdered = [
      ['merchant_id', merchantId],
      ['merchant_key', merchantKey],
      ['return_url', returnUrl],
      ['cancel_url', cancelUrl],
      ['notify_url', notifyUrl],
      ['name_first', 'Pool Engine'],
      ['name_last', 'Rental'],
      ['email_address', driverEmail],
      ['m_payment_id', reference],   // must match the form field name exactly
      ['amount', numAmount.toFixed(2)],
      ['item_name', `Pool Engine Rental - ${rentalClass}`],
      ['item_description', `${rentalType} Pool Engine Rental for ${rentalClass}`]
    ];

    let pfParamString = '';
    
    console.log(`🔐 Building signature for pool engine rental:`);
    
    for (const [key, value] of pfDataOrdered) {
      if (value !== null && value !== '') {
        const encoded = encodeURIComponent(value).replace(/%20/g, '+');
        pfParamString += `${key}=${encoded}&`;
        console.log(`  ${key}=${encoded}`);
      }
    }
    
    const actualPassphrase = pfCfg.passphrase;
    const passphraseEncoded = encodeURIComponent(actualPassphrase).replace(/%20/g, '+');
    if (actualPassphrase) {
      pfParamString += `passphrase=${passphraseEncoded}`;
      console.log(`  passphrase=[REDACTED]`);
    } else {
      pfParamString = pfParamString.replace(/&$/, '');
    }

    const signature = crypto
      .createHash('md5')
      .update(pfParamString.trim())
      .digest('hex');

    console.log(`✅ Generated signature: ${signature}`);

    const formHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Processing Payment...</title>
        <style>
          body { font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f5f5f5; }
          .container { text-align: center; }
          .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Redirecting to Payment...</h1>
          <div class="spinner"></div>
          <p>Amount: <strong>R${numAmount.toFixed(2)}</strong></p>
          <p>Rental: <strong>${rentalType}</strong></p>
          <p>Class: <strong>${rentalClass}</strong></p>
          <p>Reference: <strong>${reference}</strong></p>
          ${payfastSandboxMode ? '<p style="color:#f59e0b;font-weight:bold;">🧪 SANDBOX TEST MODE</p>' : ''}
        </div>
        <form id="paymentForm" method="POST" action="${pfCfg.processUrl}">
          <input type="hidden" name="merchant_id" value="${merchantId}">
          <input type="hidden" name="merchant_key" value="${merchantKey}">
          <input type="hidden" name="return_url" value="${returnUrl}">
          <input type="hidden" name="cancel_url" value="${cancelUrl}">
          <input type="hidden" name="notify_url" value="${notifyUrl}">
          <input type="hidden" name="name_first" value="Pool Engine">
          <input type="hidden" name="name_last" value="Rental">
          <input type="hidden" name="email_address" value="${driverEmail}">
          <input type="hidden" name="m_payment_id" value="${reference}">
          <input type="hidden" name="amount" value="${numAmount.toFixed(2)}">
          <input type="hidden" name="item_name" value="Pool Engine Rental - ${rentalClass}">
          <input type="hidden" name="item_description" value="${rentalType} Pool Engine Rental for ${rentalClass}">
          <input type="hidden" name="signature" value="${signature}">
          <input type="hidden" name="signature" value="${signature}">
        </form>
        <script>
          setTimeout(function() {
            document.getElementById('paymentForm').submit();
          }, 1000);
        </script>
      </body>
      </html>
    `;

    res.send(formHtml);
  } catch (err) {
    console.error('❌ initiatePoolEnginePayment error:', err.message);
    res.status(400).send(`<h1>Payment Error</h1><p>${err.message}</p><p><a href="/">Back to Home</a></p>`);
  }
});

// Register for free race entry (with team code k0k0r0)
// Create Trello card for new race entry
const createTrelloCard = async (driverName, email, raceClass, teamCode, entryReference, driverId) => {
  try {
    const TRELLO_API_KEY = process.env.TRELLO_API_KEY || '4ca7d039fde110d7a6733fac928a6f0f';
    const TRELLO_TOKEN = process.env.TRELLO_TOKEN || '363e5ac5fe8f9a940a7b6fe08b245afb6cf7066205396fd77145eebed1d1af9f';
    const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID || '696cc6dc4a6f89d0cf0a2b7b';
    
    // First, get the board to find the "New Entries" list
    const boardResponse = await axios.get(
      `https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/lists?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
    );
    
    const newEntriesList = boardResponse.data.find(list => list.name === 'New Entries');
    if (!newEntriesList) {
      console.warn('⚠️ Trello: "New Entries" list not found');
      return;
    }
    
    // Create card with driver details
    const cardDescription = `
**Driver Information:**
• Name: ${driverName}
• Email: ${email}
• Driver ID: ${driverId}
• Race Class: ${raceClass}
• Team Code: ${teamCode || 'N/A'}
• Entry Reference: ${entryReference}
• Registration Date: ${new Date().toLocaleDateString('en-ZA')}
• Registration Time: ${new Date().toLocaleTimeString('en-ZA')}
    `.trim();
    
    const cardResponse = await axios.post(
      `https://api.trello.com/1/cards?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
      {
        idList: newEntriesList.id,
        name: `${driverName} - ${raceClass}`,
        desc: cardDescription,
        due: null
      }
    );
    
    console.log(`✅ Trello card created: ${cardResponse.data.id} for ${driverName}`);
    return cardResponse.data;
  } catch (err) {
    console.error('⚠️ Trello card creation failed (non-critical):', err.message);
  }
};

// Manual Trello card creation for existing entries
app.post('/api/sendEntryToTrello', async (req, res) => {
  try {
    const { entry_id } = req.body;
    
    if (!entry_id) {
      return res.json({ success: false, error: 'Entry ID required' });
    }
    
    // Get entry details
    const result = await pool.query(`
      SELECT re.entry_id, re.driver_id, re.race_class, re.payment_reference, re.team_code,
             d.first_name, d.last_name, c.email,
             CONCAT(d.first_name, ' ', d.last_name) as driver_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      WHERE re.entry_id = $1
    `, [entry_id]);
    
    if (result.rows.length === 0) {
      return res.json({ success: false, error: 'Entry not found' });
    }
    
    const entry = result.rows[0];
    
    // Create Trello card
    const trelloCard = await createTrelloCard(
      entry.driver_name,
      entry.email,
      entry.race_class,
      entry.team_code,
      entry.payment_reference,
      entry.driver_id
    );
    
    if (trelloCard) {
      res.json({ success: true, message: 'Entry sent to Trello successfully', cardId: trelloCard.id });
    } else {
      res.json({ success: false, error: 'Failed to create Trello card' });
    }
  } catch (err) {
    console.error('Error sending entry to Trello:', err);
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/registerFreeRaceEntry', async (req, res) => {
  try {
    const { eventId, driverId, raceClass, selectedItems, email, firstName, lastName, teamCode, raceDays } = req.body;
    
    if (!eventId || !driverId || !email) {
      throw new Error('Missing event ID, driver ID, or email');
    }

    const entry_id = `race_entry_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    // Use TEAM in reference if team code is provided, otherwise FREE
    const referenceType = teamCode ? 'TEAM' : 'FREE';
    const reference = `RACE-${referenceType}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    // Format selected items as JSON (entry_items column expects JSON format)
    const selectedItemsJson = selectedItems ? JSON.stringify(selectedItems) : JSON.stringify([]);
    
    // Generate unique ticket references - multiple tickets for Both Days entries
    const selectedItemsArray = Array.isArray(selectedItems) ? selectedItems : [];
    const isBothDays = (raceDays === 'Both');

    // Helper: generate N refs; returns plain string for 1, JSON array string for N>1
    const genRefs = (type, n) => {
      const refs = [];
      for (let i = 0; i < n; i++) refs.push(generateUniqueTicketRef(type, driverId, eventId));
      return n === 1 ? refs[0] : JSON.stringify(refs);
    };

    const ticketEngineRef = selectedItemsArray.some(item => item && item.toLowerCase().includes('engine'))
      ? genRefs('engine', 1) : null;
    const ticketTyresRef = selectedItemsArray.some(item => item && item.toLowerCase().includes('tyre'))
      ? genRefs('tyres', 1) : null;
    const ticketTransponderRef = selectedItemsArray.some(item => item && item.toLowerCase().includes('transponder'))
      ? genRefs('transponder', 1) : null;
    const ticketFuelRef = selectedItemsArray.some(item => item && item.toLowerCase().includes('fuel'))
      ? genRefs('fuel', 1) : null;
    
    // Check if this is a regional race where season rentals don't apply
    const eventResult = await pool.query(
      `SELECT event_date FROM events WHERE event_id = $1`,
      [eventId]
    );
    const eventDate = eventResult.rows[0]?.event_date ? new Date(eventResult.rows[0].event_date) : null;
    
    // Regional race dates where everyone must rent engines individually (Feb 14, Apr 11, Sep 7)
    const regionalRaceDates = ['2026-02-14', '2026-04-11', '2026-09-07'];
    const isRegionalRace = eventDate && regionalRaceDates.some(dateStr => {
      const regionalDate = new Date(dateStr);
      return eventDate.getFullYear() === regionalDate.getFullYear() &&
             eventDate.getMonth() === regionalDate.getMonth() &&
             eventDate.getDate() === regionalDate.getDate();
    });
    
    // Check if driver has season engine rental from pool engines
    const seasonRentalResult = await pool.query(
      `SELECT COUNT(*) as count FROM pool_engine_rentals 
       WHERE driver_id = $1 AND payment_status = 'Completed' AND season_year = $2
       LIMIT 1`,
      [driverId, new Date().getFullYear()]
    );
    const hasSeasonEngineRental = seasonRentalResult.rows[0]?.count > 0;
    
    // Determine if engine rental is selected
    const engineRentalSelected = selectedItems && selectedItems.some(item => item.toLowerCase().includes('engine') || item.toLowerCase().includes('rental'));
    
    // Determine if engine needs to be charged
    let hasEngineRental = engineRentalSelected;
    
    // If driver has season engine rental AND it's NOT a regional race, they don't need to pay for individual race engine rentals
    if (hasSeasonEngineRental && engineRentalSelected && !isRegionalRace) {
      console.log(`ℹ️ Driver ${driverId} has season engine rental - skipping individual race engine charge`);
      hasEngineRental = false;
    } else if (isRegionalRace && engineRentalSelected) {
      console.log(`ℹ️ Regional race detected (${eventDate.toLocaleDateString()}) - individual engine rental required even with season pass`);
      hasEngineRental = true; // Force charging for regional races
    }
    
    const engineValue = engineRentalSelected ? 1 : 0;
    
    // Store the free entry in database with unique ticket references
    await pool.query(
      `INSERT INTO race_entries (entry_id, event_id, driver_id, payment_reference, payment_status, entry_status, amount_paid, race_class, entry_items, team_code, engine, ticket_engine_ref, ticket_tyres_ref, ticket_transponder_ref, ticket_fuel_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
      [entry_id, eventId, driverId, reference, 'Completed', 'confirmed', 0, raceClass, selectedItemsJson, teamCode || null, engineValue, ticketEngineRef, ticketTyresRef, ticketTransponderRef, ticketFuelRef]
    );

    // Update driver's next race status - use engineRentalSelected for status (whether they have an engine), not hasEngineRental (whether they're charged)
    await pool.query(
      `UPDATE drivers 
       SET next_race_entry_status = 'Registered',
           next_race_engine_rental_status = $1
       WHERE driver_id = $2`,
      [engineRentalSelected ? 'Yes' : 'No', driverId]
    );

    // Log to audit trail
    const itemsString = Array.isArray(selectedItems) ? selectedItems.join(', ') : 'None';
    await logAuditEvent(driverId, email, 'RACE_ENTRY_REGISTERED', 'entry_items', '', itemsString);

    console.log(`✅ Free race entry recorded: ${reference} - ${raceClass}`);
    console.log(`✅ Updated driver ${driverId} next_race status - Engine Rental: ${engineRentalSelected ? 'Yes' : 'No'}, Team Code: ${teamCode || 'N/A'}`);

    // Send confirmation emails
    try {
      const driverName = `${firstName || 'Driver'} ${lastName || ''}`.trim();
      // Get driver race number for ticket
      const driverRaceNumResult = await pool.query('SELECT race_number FROM drivers WHERE driver_id = $1', [driverId]);
      const driverRaceNumber = driverRaceNumResult.rows[0]?.race_number;
      
      // Fetch event details
      const eventResult = await pool.query(
        `SELECT event_id, event_name, event_date, location FROM events WHERE event_id = $1`,
        [eventId]
      );
      const eventDetails = eventResult.rows[0];
      const eventName = eventDetails?.event_name || 'Race Event';
      const eventDateStr = eventDetails?.event_date 
        ? new Date(eventDetails.event_date).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
        : 'TBA';
      const eventLocation = eventDetails?.location || 'TBA';
      
      // Parse selected items for ticket display
      const selectedItemsArray = Array.isArray(selectedItems) ? selectedItems : [];
      const hasEngineRentalItem = selectedItemsArray.some(item => item && item.toLowerCase().includes('engine'));
      const hasTyresItem = selectedItemsArray.some(item => item && item.toLowerCase().includes('tyre'));
      const hasTransponderItem = selectedItemsArray.some(item => item && item.toLowerCase().includes('transponder'));
      const hasFuelItem = selectedItemsArray.some(item => item && item.toLowerCase().includes('fuel'));

      // Helper to parse ref field — single string or JSON array
      const parseRefs = (field) => {
        if (!field) return [];
        try { const p = JSON.parse(field); return Array.isArray(p) ? p : [field]; } catch { return [field]; }
      };

      // Build rental ticket HTML — multiple tickets per item for Both Days entries
      let rentalTicketsHtml = '';
      if (hasEngineRentalItem && ticketEngineRef) {
        const engineRefs = parseRefs(ticketEngineRef);
        const engineDayLabels = isBothDays
          ? ['FRIDAY – PRACTICE DAY', 'SATURDAY', 'SUNDAY']
          : [raceDays === 'Sunday' ? 'SUNDAY' : 'SATURDAY'];
        engineRefs.forEach((ref, i) => {
          rentalTicketsHtml += generateEngineRentalTicketHTML({
            reference: ref, eventName, eventDate: eventDetails?.event_date,
            eventLocation, raceClass, driverName, raceNumber: driverRaceNumber,
            dayLabel: engineDayLabels[i] || ''
          });
        });
      }
      if (hasTyresItem && ticketTyresRef) {
        const tyreRefs = parseRefs(ticketTyresRef);
        const tyreDayLabels = isBothDays ? ['SATURDAY', 'SUNDAY'] : [raceDays === 'Sunday' ? 'SUNDAY' : 'SATURDAY'];
        tyreRefs.forEach((ref, i) => {
          rentalTicketsHtml += generateTyreRentalTicketHTML({
            reference: ref, eventName, eventDate: eventDetails?.event_date,
            eventLocation, raceClass, driverName,
            dayLabel: tyreDayLabels[i] || ''
          });
        });
      }
      if (hasTransponderItem && ticketTransponderRef) {
        const txRefs = parseRefs(ticketTransponderRef);
        const txDayLabels = isBothDays ? ['SATURDAY', 'SUNDAY'] : [raceDays === 'Sunday' ? 'SUNDAY' : 'SATURDAY'];
        txRefs.forEach((ref, i) => {
          rentalTicketsHtml += generateTransponderRentalTicketHTML({
            reference: ref, eventName, eventDate: eventDetails?.event_date,
            eventLocation, raceClass, driverName,
            dayLabel: txDayLabels[i] || ''
          });
        });
      }
      if (hasFuelItem && ticketFuelRef) {
        const fuelDayLabel = isBothDays ? 'FRIDAY · SATURDAY · SUNDAY'
          : raceDays === 'Sunday' ? 'SUNDAY' : 'SATURDAY';
        rentalTicketsHtml += generateFuelTicketHTML({
          reference: ticketFuelRef, eventName, eventDate: eventDetails?.event_date,
          eventLocation, raceClass, driverName,
          dayLabel: fuelDayLabel
        });
      }
      
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Race Entry Confirmation — NATS 2026 ROK Cup</title>
          <style>
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #333; background: #f5f5f5; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
            .header { background: white; padding: 20px; text-align: center; border-bottom: 3px solid #22c55e; }
            .header-logo { margin-bottom: 16px; }
            .header-logo img { width: 140px; height: auto; }
            .header h1 { margin: 0; font-size: 24px; font-weight: 700; color: #111827; }
            .content { padding: 30px; }
            .details { background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22c55e; }
            .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
            .detail-row:last-child { border-bottom: none; }
            .detail-label { font-weight: 600; color: #6b7280; font-size: 13px; }
            .detail-value { color: #111827; font-weight: 500; }
            .badge { background: #dcfce7; color: #166534; padding: 6px 12px; border-radius: 4px; font-weight: 700; display: inline-block; font-size: 12px; }
            .ticket { border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-start; background: white; }
            .ticket-left { flex: 1; }
            .ticket-type { font-size: 13px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
            .ticket-title { font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 12px; }
            .ticket-info { font-size: 12px; color: #374151; line-height: 1.5; }
            .ticket-code { background: #f9fafb; padding: 12px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #111827; letter-spacing: 0.05em; text-align: center; margin-top: 12px; border: 1px solid #e5e7eb; }
            .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body style="margin: 0; padding: 20px;">
          <div class="container">
            <div class="header">
              <div class="header-logo">
                <img src="https://www.dropbox.com/scl/fi/ryhszrvk76kd7yy6y0rtc/ROK-CUP-LOGO-2025.png?rlkey=k9dxlzbh5e9zw58v8t34yjzea&dl=1" alt="ROK Cup South Africa" />
              </div>
              <h1>Race Entry Confirmed</h1>
            </div>
            <div class="content">
              <p style="margin: 0 0 16px 0; font-size: 15px;">Hi ${driverName},</p>
              <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151;">Your race entry has been successfully registered. Thank you for participating in the NATS 2026 ROK Cup!</p>
              
              <div class="details">
                <div class="detail-row">
                  <span class="detail-label">Event Name</span>
                  <span class="detail-value">${eventName}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Event Date</span>
                  <span class="detail-value">${eventDateStr}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Location</span>
                  <span class="detail-value">${eventLocation}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Race Class</span>
                  <span class="detail-value">${raceClass}</span>
                </div>
                ${teamCode ? `<div class="detail-row">
                  <span class="detail-label">Team Code</span>
                  <span class="detail-value">${teamCode}</span>
                </div>` : ''}
                <div class="detail-row">
                  <span class="detail-label">Entry Reference</span>
                  <span class="detail-value">${reference}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Status</span>
                  <span class="badge">Confirmed</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Confirmation Date</span>
                  <span class="detail-value">${new Date().toLocaleDateString('en-ZA')}</span>
                </div>
              </div>
              
              ${generateRaceTicketHTML({
                reference,
                eventName,
                eventDate: eventDetails?.event_date,
                eventLocation,
                raceClass,
                driverName,
                teamCode
              })}
              
              ${rentalTicketsHtml}
              
              <p style="margin: 20px 0; font-size: 14px; color: #374151;">You will receive further instructions about your race entry shortly. Please make sure to check your driver portal regularly for updates and important announcements.</p>
              
              <p style="margin: 20px 0 0 0; font-size: 14px;">Best regards,<br><strong style="color: #22c55e;">NATS 2026 ROK Cup Team</strong></p>
            </div>
            <div class="footer">
              <p style="margin: 0; color: #6b7280;">This is an automated confirmation email. Please do not reply to this message.</p>
              <p style="margin: 8px 0 0 0;"><a href="https://rokthenats.co.za/" style="color: #2563eb; text-decoration: none; font-weight: 600;">Visit the NATS Event Hub</a></p>
            </div>
          </div>
        </body>
        </html>
      `;

      // Send to driver
      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: email, name: driverName }],
          from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
          from_name: 'The ROK Cup',
          subject: `Race Entry Confirmed - ${eventName} (${raceClass})`,
          html: emailHtml
        }
      });
      
      console.log(`📧 Free entry confirmation email sent to driver: ${email}`);

      // Send detailed admin notification to John
      const adminEmailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>New Race Registration — NATS 2026 ROK Cup</title>
          <style>
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #333; background: #f5f5f5; margin: 0; padding: 0; }
            .container { max-width: 700px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
            .header { background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); padding: 25px; text-align: center; color: white; }
            .header h1 { margin: 0; font-size: 24px; font-weight: 700; }
            .content { padding: 30px; }
            .alert { background: #dcfce7; border-left: 4px solid #22c55e; padding: 16px; border-radius: 4px; margin-bottom: 24px; }
            .alert-text { color: #166534; font-weight: 600; font-size: 14px; }
            .section { margin-bottom: 24px; }
            .section-title { font-size: 14px; font-weight: 700; color: #111827; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
            .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
            .detail-item { background: #f9fafb; padding: 12px; border-radius: 6px; }
            .detail-label { font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 4px; }
            .detail-value { font-size: 14px; font-weight: 500; color: #111827; }
            .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; }
            .badge { display: inline-block; padding: 6px 12px; border-radius: 4px; font-weight: 700; font-size: 12px; }
            .badge-success { background: #dcfce7; color: #166534; }
          </style>
        </head>
        <body style="margin: 0; padding: 20px;">
          <div class="container">
            <div class="header">
              <h1>📋 New Race Registration</h1>
            </div>
            <div class="content">
              <div class="alert">
                <div class="alert-text">✓ Race entry successfully registered in the system</div>
              </div>
              
              <div class="section">
                <div class="section-title">Registration Details</div>
                <div class="detail-grid">
                  <div class="detail-item">
                    <div class="detail-label">Entry Reference</div>
                    <div class="detail-value"><strong>${reference}</strong></div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Status</div>
                    <div class="detail-value"><span class="badge badge-success">Confirmed</span></div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Registration Date</div>
                    <div class="detail-value">${new Date().toLocaleDateString('en-ZA')}</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Registration Time</div>
                    <div class="detail-value">${new Date().toLocaleTimeString('en-ZA')}</div>
                  </div>
                </div>
              </div>
              
              <div class="section">
                <div class="section-title">Driver Information</div>
                <div class="detail-grid">
                  <div class="detail-item">
                    <div class="detail-label">Driver Name</div>
                    <div class="detail-value">${driverName}</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Driver Email</div>
                    <div class="detail-value"><a href="mailto:${email}" style="color: #2563eb; text-decoration: none;">${email}</a></div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Driver ID</div>
                    <div class="detail-value">${driverId}</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Race Class</div>
                    <div class="detail-value">${raceClass}</div>
                  </div>
                  ${teamCode ? `<div class="detail-item">
                    <div class="detail-label">Team Code</div>
                    <div class="detail-value">${teamCode}</div>
                  </div>` : ''}
                </div>
              </div>
              
              <div class="section">
                <div class="section-title">Entry Details</div>
                <div style="background: #f9fafb; padding: 16px; border-radius: 6px;">
                  <div style="margin-bottom: 12px;">
                    <span style="font-weight: 600; color: #111827;">Selected Items:</span>
                    <div style="margin-top: 8px; color: #374151;">
                      ${selectedItems && selectedItems.length > 0 ? selectedItems.map(item => `<div>• ${item}</div>`).join('') : '<div style="color: #9ca3af; font-style: italic;">No additional items selected</div>'}
                    </div>
                  </div>
                  <div style="border-top: 1px solid #e5e7eb; padding-top: 12px; margin-top: 12px;">
                    <span style="font-weight: 600; color: #111827;">Engine Rental:</span>
                    <div style="color: #374151; margin-top: 4px;">${hasEngineRental ? '✓ Yes' : '✗ No'}</div>
                  </div>
                </div>
              </div>
              
              <div class="section">
                <div class="section-title">Payment Information</div>
                <div class="detail-grid">
                  <div class="detail-item">
                    <div class="detail-label">Amount Paid</div>
                    <div class="detail-value">R0.00</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Payment Status</div>
                    <div class="detail-value">Completed (Free Entry)</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Payment Reference</div>
                    <div class="detail-value">${reference}</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="footer">
              <p style="margin: 0;">This is an automated notification from the NATS Race Management System</p>
            </div>
          </div>
        </body>
        </html>
      `;

      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: 'john@rokcup.co.za', name: 'John' }],
          from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
          subject: `[NEW ENTRY] ${driverName} - ${raceClass}`,
          html: adminEmailHtml
        }
      });
      
      console.log(`📧 Admin notification email sent to john@rokcup.co.za`);

      // Create Trello card for the new entry
      await createTrelloCard(driverName, email, raceClass, teamCode, reference, driverId);

    } catch (emailErr) {
      console.error('⚠️ Email sending failed (non-critical):', emailErr.message);
    }

    res.json({ success: true, message: 'Race entry registered successfully', reference });
  } catch (err) {
    console.error('❌ registerFreeRaceEntry error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Handle PayFast Payment Notification (IPN)
app.post('/api/paymentNotify', async (req, res) => {
  try {
    console.log('� ========================================');
    console.log('🔔 PAYFAST WEBHOOK RECEIVED');
    console.log('🔔 ========================================');
    console.log('📨 Full PayFast IPN Body:', JSON.stringify(req.body, null, 2));
    console.log('🕐 Timestamp:', new Date().toISOString());

    const { 
      m_payment_id, 
      pf_payment_id,
      payment_status, 
      item_description, 
      item_name,
      amount_gross,
      email_address,
      signature,
      name_first,
      name_last
    } = req.body;

    // PayFast sends the payment reference back as m_payment_id (not 'reference')
    const reference = m_payment_id;

    console.log('🔍 Key Fields:');
    console.log(`   - Payment Reference: ${reference}`);
    console.log(`   - Payment Status: ${payment_status}`);
    console.log(`   - Amount: R${amount_gross}`);
    console.log(`   - Driver: ${name_first} ${name_last}`);
    console.log(`   - Email: ${email_address}`);

    // ========================================
    // STEP 1: STORE WEBHOOK IMMEDIATELY (CRITICAL - Never lose a webhook!)
    // ========================================
    let webhookId = null;
    try {
      const webhookResult = await pool.query(
        `INSERT INTO payfast_webhooks (
          m_payment_id, pf_payment_id, payment_status, item_name, item_description,
          amount_gross, amount_fee, amount_net, reference, email_address,
          name_first, name_last, cell_number, signature, raw_data,
          processing_status, received_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
        RETURNING webhook_id`,
        [
          m_payment_id, pf_payment_id, payment_status, item_name, item_description,
          req.body.amount_gross || null, req.body.amount_fee || null, req.body.amount_net || null,
          reference, email_address, name_first, name_last, req.body.cell_number || null,
          signature, JSON.stringify(req.body), 'received'
        ]
      );
      
      webhookId = webhookResult.rows[0].webhook_id;
      console.log(`✅ Webhook stored with ID: ${webhookId}`);
    } catch (storeErr) {
      console.error('❌ CRITICAL: Failed to store webhook!', storeErr.message);
      // Even if storage fails, continue processing to not lose the payment
      // But log it to a file as backup
      const failedWebhookLog = {
        timestamp: new Date().toISOString(),
        error: 'Failed to store in database',
        stack: storeErr.stack,
        webhook: req.body
      };
      fs.appendFileSync(
        path.join(__dirname, 'logs', 'failed_webhook_storage.json'),
        JSON.stringify(failedWebhookLog) + '\n'
      );
    }

    if (!m_payment_id || !payment_status) {
      const errorMsg = 'Missing payment ID or status';
      console.error('❌', errorMsg);
      if (webhookId) {
        await pool.query(
          `UPDATE payfast_webhooks SET processing_status = 'error', processing_error = $1, processed_at = NOW() WHERE webhook_id = $2`,
          [errorMsg, webhookId]
        );
      }
      throw new Error(errorMsg);
    }

    // Verify PayFast signature - uses whichever mode (live or sandbox) is currently active
    const pfCfg = getPayFastConfig();
    const merchantId = pfCfg.merchantId;
    const merchantKey = pfCfg.merchantKey;
    const passphrase = pfCfg.passphrase;

    // Build signature string in PayFast order (excluding signature field itself)
    let pfParamString = '';
    const signatureData = { ...req.body };
    delete signatureData.signature;
    
    // ✅ CORRECT APPROACH: iterate over ALL fields in the ORDER PayFast sent them
    // (mirrors the PayFast PHP SDK which uses foreach($_POST) not a fixed field list)
    // IMPORTANT: include empty-string fields too — PayFast PHP SDK does urlencode($val)
    // for ALL fields with no empty-string exclusion, so custom_int1=&custom_str1=& etc must be included
    for (const [field, value] of Object.entries(signatureData)) {
      if (value !== null && value !== undefined) {
        const encoded = encodeURIComponent(String(value)).replace(/%20/g, '+');
        pfParamString += `${field}=${encoded}&`;
      }
    }
    
    // Append passphrase if set
    if (passphrase) {
      pfParamString += `passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`;
    } else {
      pfParamString = pfParamString.replace(/&$/, '');
    }
    
    console.log(`🔐 ITN param string (first 200 chars): ${pfParamString.substring(0, 200)}`);
    
    const calculatedSignature = crypto.createHash('md5').update(pfParamString.trim()).digest('hex');
    console.log(`🔐 Expected sig: ${signature} | Calculated: ${calculatedSignature}`);
    const signatureValid = calculatedSignature === signature;
    
    console.log(`✅ IPN Signature verification: ${signatureValid ? 'PASSED' : 'FAILED'}`);
    
    // Update webhook with signature validation result
    if (webhookId) {
      await pool.query(
        `UPDATE payfast_webhooks SET signature_valid = $1 WHERE webhook_id = $2`,
        [signatureValid, webhookId]
      );
    }
    
    if (!signatureValid) {
      console.warn('⚠️ Signature mismatch - possible tampering. Aborting payment processing.');
      if (webhookId) {
        await pool.query(
          `UPDATE payfast_webhooks SET processing_status = 'signature_invalid', processing_error = $1, processed_at = NOW() WHERE webhook_id = $2`,
          ['Signature verification failed', webhookId]
        );
      }
      // Return 200 to stop PayFast retrying, but do NOT process the payment
      return res.json({ success: true });
    }

    // Only process COMPLETE payments
    if (payment_status !== 'COMPLETE') {
      console.log(`⏭️ Payment not complete (status: ${payment_status}), not recording`);
      if (webhookId) {
        await pool.query(
          `UPDATE payfast_webhooks SET processing_status = 'skipped', processing_error = $1, processed_at = NOW() WHERE webhook_id = $2`,
          [`Payment status is ${payment_status}, not COMPLETE`, webhookId]
        );
      }
      res.json({ success: true });
      return;
    }

    // Parse reference to extract event_id and driver_id
    // Reference format: RACE-{eventId}-{driverId}-{timestamp}
    // OR: POOL-{rentalClass}-{rentalType}-{driverId}-{timestamp}
    const referenceParts = reference.split('-');
    
    const isPoolEngineRental = reference.startsWith('POOL-');
    let eventId, driverId, rentalClass, rentalType;
    
    if (isPoolEngineRental) {
      // POOL-{rentalClass}-{rentalType}-{driverId}-{timestamp}
      rentalClass = referenceParts[1] || 'UNKNOWN';
      rentalType = referenceParts[2] || 'UNKNOWN';
      driverId = referenceParts[3] || 'unknown';
      
      console.log(`💳 Pool Engine Payment Completed: ${rentalClass} - ${rentalType} for driver ${driverId}`);
      
      // Save pool engine rental
      try {
        const rentalId = `pool_rental_${pf_payment_id}`;
        await pool.query(
          `INSERT INTO pool_engine_rentals (rental_id, driver_id, championship_class, rental_type, amount_paid, payment_status, payment_reference, season_year, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
          [rentalId, driverId, rentalClass, rentalType, amount_gross, 'Completed', m_payment_id, new Date().getFullYear()]
        );
        
        // Update driver's season_engine_rental flag
        await pool.query(
          `UPDATE drivers SET season_engine_rental = 'Y' WHERE driver_id = $1`,
          [driverId]
        );
        
        console.log(`✅ Pool engine rental saved and driver flag updated: ${rentalId}`);
        
        // *** SEND ADMIN NOTIFICATION EMAIL FOR POOL ENGINE PURCHASE ***
        try {
          const driverName = `${name_first || 'Unknown'} ${name_last || 'Driver'}`.trim();
          const adminNotificationHtml = `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"></head>
            <body style="margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6;">
              <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
                <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 24px; text-align: center;">
                  <h1 style="color: white; margin: 0; font-size: 20px;">🏎️ POOL ENGINE PURCHASE RECEIVED!</h1>
                </div>
                <div style="padding: 24px;">
                  <p style="margin: 0 0 16px 0; font-size: 16px; color: #111827;"><strong>A driver has purchased a seasonal pool engine rental!</strong></p>
                  
                  <div style="background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 16px; margin: 16px 0;">
                    <table style="width: 100%; border-collapse: collapse;">
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Driver Name:</td><td style="padding: 8px 0; color: #111827;">${driverName}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Email:</td><td style="padding: 8px 0; color: #111827;">${email_address}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Championship Class:</td><td style="padding: 8px 0; color: #111827; font-weight: 700;">${rentalClass}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Rental Type:</td><td style="padding: 8px 0; color: #111827; font-weight: 700;">${rentalType}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Amount Paid:</td><td style="padding: 8px 0; color: #16a34a; font-weight: 700; font-size: 18px;">R${parseFloat(amount_gross).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Payment Reference:</td><td style="padding: 8px 0; color: #111827; font-family: monospace;">${reference}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">PayFast Transaction:</td><td style="padding: 8px 0; color: #111827; font-family: monospace;">${pf_payment_id}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Season Year:</td><td style="padding: 8px 0; color: #111827;">${new Date().getFullYear()}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Date/Time:</td><td style="padding: 8px 0; color: #111827;">${new Date().toLocaleString('en-ZA')}</td></tr>
                    </table>
                  </div>
                  
                  <p style="margin: 16px 0 0 0; font-size: 14px; color: #6b7280;">This driver now has seasonal engine access and can enter races without additional engine charges.</p>
                </div>
                <div style="background: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #e5e7eb;">
                  <p style="margin: 0; font-size: 12px; color: #6b7280;">NATS 2026 ROK Cup - Automated Payment Notification</p>
                </div>
              </div>
            </body>
            </html>
          `;
          
          await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
            key: process.env.MAILCHIMP_API_KEY,
            message: {
              to: [{ email: 'john@rokcup.co.za', name: 'John' }],
              from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
              subject: `🏎️ POOL ENGINE PURCHASE: ${driverName} - ${rentalClass} ${rentalType} - R${amount_gross}`,
              html: adminNotificationHtml
            }
          });
          
          console.log(`📧 Admin notification email sent for pool engine purchase: ${driverName}`);
        } catch (adminEmailErr) {
          console.error('⚠️ Admin notification email failed:', adminEmailErr.message);
        }
        
      } catch (poolErr) {
        console.error('❌ Error saving pool engine rental:', poolErr.message);
      }
    } else {
      // RACE-{eventId}-{driverId}-{timestamp}
      eventId = referenceParts[1] || 'unknown';
      driverId = referenceParts[2] || 'unknown';
    }

    // Extract rental items from item_description to determine what was purchased
    const itemDesc = item_description ? item_description.toLowerCase() : '';
    const hasEngine = itemDesc.includes('engine');
    const hasTyres = itemDesc.includes('tyre');
    const hasTransponder = itemDesc.includes('transponder');
    const hasFuel = itemDesc.includes('fuel');
    
    // Generate ticket references ONLY for items that don't already have them
    // This preserves the original ticket refs from the initial email
    let ticketEngineRef = null;
    let ticketTyresRef = null;
    let ticketTransponderRef = null;
    let ticketFuelRef = null;
    
    // Store payment record using new schema
    const race_entry_id = `race_entry_${pf_payment_id}`;
    if (!isPoolEngineRental) {
      console.log('🔍 Looking for existing pending entry with reference:', reference);
      
      // ✅ FIX #1b: Update pending entry to completed (or insert if webhook came first)
      // First, try to get existing pending entry to preserve race_class and other data
      const existingEntry = await pool.query(
        'SELECT * FROM race_entries WHERE payment_reference = $1',
        [reference]
      );
      
      console.log(`📋 Existing entries found: ${existingEntry.rows.length}`);
      if (existingEntry.rows.length > 0) {
        console.log('   Entry ID:', existingEntry.rows[0].entry_id);
        console.log('   Current Status:', existingEntry.rows[0].payment_status);
        console.log('   Race Class:', existingEntry.rows[0].race_class);
      }
      
      let raceClass = null;
      let entryItems = null;
      
      if (existingEntry.rows.length > 0) {
        raceClass = existingEntry.rows[0].race_class;
        entryItems = existingEntry.rows[0].entry_items;
        // PRESERVE existing ticket references - don't regenerate them!
        ticketEngineRef = existingEntry.rows[0].ticket_engine_ref;
        ticketTyresRef = existingEntry.rows[0].ticket_tyres_ref;
        ticketTransponderRef = existingEntry.rows[0].ticket_transponder_ref;
        ticketFuelRef = existingEntry.rows[0].ticket_fuel_ref;
        console.log(`📝 Found existing pending entry with class: ${raceClass}, items: ${JSON.stringify(entryItems)}, preserving all data`);
      } else {
        // ⚠️ CRITICAL: No pending entry found - this should NOT happen in normal flow
        // This means webhook arrived before pending entry was created, or there was an error
        // Try to infer items from item_description as fallback (unreliable)
        console.warn(`⚠️ WARNING: No pending entry found for reference: ${reference}`);
        console.warn(`⚠️ This indicates the pending entry was not created during payment initiation`);
        
        entryItems = [];
        if (hasEngine) entryItems.push('Engine Rental');
        if (hasTyres) entryItems.push('Tyres (Optional)');
        if (hasTransponder) entryItems.push('Rent Transponder');
        if (hasFuel) entryItems.push('Controlled Fuel');
        
        // Generate new tickets only if no existing entry
        ticketEngineRef = hasEngine ? generateUniqueTicketRef('engine', driverId, eventId) : null;
        ticketTyresRef = hasTyres ? generateUniqueTicketRef('tyres', driverId, eventId) : null;
        ticketTransponderRef = hasTransponder ? generateUniqueTicketRef('transponder', driverId, eventId) : null;
        ticketFuelRef = hasFuel ? generateUniqueTicketRef('fuel', driverId, eventId) : null;
        
        console.warn(`⚠️ Built fallback entry_items from description: ${JSON.stringify(entryItems)}`);
      }
      
      // ON CONFLICT now updates the pending entry we created during initiation
      // First try to update existing pending entry, if not found, insert new
      // Ensure entry_items is properly stringified for JSON column
      const entryItemsJson = typeof entryItems === 'string' ? entryItems : JSON.stringify(entryItems);
      
      const updateResult = await pool.query(
        `UPDATE race_entries 
         SET entry_id = $1,
             payment_status = $2, 
             entry_status = $3, 
             amount_paid = $4,
             race_class = $5,
             entry_items = $6,
             ticket_engine_ref = $7, 
             ticket_tyres_ref = $8, 
             ticket_transponder_ref = $9, 
             ticket_fuel_ref = $10,
             updated_at = NOW()
         WHERE payment_reference = $11
         RETURNING *`,
        [race_entry_id, 'Completed', 'confirmed', amount_gross, raceClass, entryItemsJson, 
         ticketEngineRef, ticketTyresRef, ticketTransponderRef, ticketFuelRef, reference]
      );
      
      // If no existing entry found, insert new one
      if (updateResult.rows.length === 0) {
        console.log('⚠️ WARNING: No pending entry found, creating new entry');
        console.log(`   EventId: ${eventId}, DriverId: ${driverId}`);
        
        await pool.query(
          `INSERT INTO race_entries (
            entry_id, event_id, driver_id, payment_reference, payment_status, entry_status, 
            amount_paid, race_class, entry_items, ticket_engine_ref, ticket_tyres_ref, 
            ticket_transponder_ref, ticket_fuel_ref, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
          [race_entry_id, eventId, driverId, reference, 'Completed', 'confirmed', amount_gross, 
           raceClass, entryItemsJson, ticketEngineRef, ticketTyresRef, ticketTransponderRef, ticketFuelRef]
        );
        console.log(`✅ Race entry created (no pending entry found): ${race_entry_id} (Class: ${raceClass})`);
      } else {
        console.log(`✅ Race entry updated from pending to completed: ${race_entry_id} (Class: ${raceClass})`);
        console.log(`   Updated ${updateResult.rows.length} row(s)`);
      }
    }

    console.log('🎉 ========================================');
    console.log(`✅ PAYMENT PROCESSED SUCCESSFULLY`);
    console.log(`   Reference: ${reference}`);
    console.log(`   Status: COMPLETE`);
    console.log(`   Amount: R${amount_gross}`);
    console.log(`   Driver ID: ${driverId}`);
    if (ticketEngineRef) console.log(`   Engine ticket: ${ticketEngineRef}`);
    if (ticketTyresRef) console.log(`   Tyres ticket: ${ticketTyresRef}`);
    if (ticketTransponderRef) console.log(`   Transponder ticket: ${ticketTransponderRef}`);
    if (ticketFuelRef) console.log(`   Fuel ticket: ${ticketFuelRef}`);
    console.log('🎉 ========================================');

    // ℹ️ TRELLO CARD: Already created during payment initiation (before PayFast redirect)
    // No need to create it again here - would be a duplicate

    // ⚠️ EMAIL DISABLED FOR RACE ENTRIES - Now sent immediately when payment is initiated
    // This prevents duplicate emails. Pool engine rentals still get emails here.
    // Send confirmation emails (ONLY for pool engine rentals)
    try {
      if (isPoolEngineRental) {
        // Pool engine rental email sending (keep this)
        const driverName = `${name_first || 'Driver'} ${name_last || ''}`.trim();
        
        const emailHtml = `
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"></head>
          <body style="margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6;">
            <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
              <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 24px; text-align: center;">
                <h1 style="color: white; margin: 0; font-size: 20px;">🏎️ POOL ENGINE PURCHASE CONFIRMED!</h1>
              </div>
              <div style="padding: 24px;">
                <p style="margin: 0 0 16px 0; font-size: 16px; color: #111827;"><strong>Your seasonal pool engine rental is confirmed!</strong></p>
                
                <div style="background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 16px; margin: 16px 0;">
                  <table style="width: 100%; border-collapse: collapse;">
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Driver Name:</td><td style="padding: 8px 0; color: #111827;">${driverName}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Email:</td><td style="padding: 8px 0; color: #111827;">${email_address}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Championship Class:</td><td style="padding: 8px 0; color: #111827; font-weight: 700;">${rentalClass}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Rental Type:</td><td style="padding: 8px 0; color: #111827; font-weight: 700;">${rentalType}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Amount Paid:</td><td style="padding: 8px 0; color: #16a34a; font-weight: 700; font-size: 18px;">R${parseFloat(amount_gross).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Payment Reference:</td><td style="padding: 8px 0; color: #111827; font-family: monospace;">${reference}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">PayFast Transaction:</td><td style="padding: 8px 0; color: #111827; font-family: monospace;">${pf_payment_id}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Season Year:</td><td style="padding: 8px 0; color: #111827;">${new Date().getFullYear()}</td></tr>
                  </table>
                </div>
                
                <p style="margin: 16px 0 0 0; font-size: 14px; color: #6b7280;">You can now enter races without additional engine charges for the remainder of the season.</p>
              </div>
            </div>
          </body>
          </html>
        `;
        
        // Send to driver
        await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
          key: process.env.MAILCHIMP_API_KEY,
          message: {
            to: [{ email: email_address, name: driverName }],
            bcc_address: 'africankartingcup@gmail.com',
            from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
            subject: `Pool Engine Rental Confirmed - ${rentalClass}`,
            html: emailHtml
          }
        });
        
        console.log(`📧 Pool engine confirmation email sent to driver: ${email_address}`);

        // Send to John (CC)
        await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
          key: process.env.MAILCHIMP_API_KEY,
          message: {
            to: [{ email: 'john@rokcup.co.za', name: 'John' }],
            bcc_address: 'africankartingcup@gmail.com',
            from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
            subject: `Pool Engine Purchase - ${driverName} (${rentalClass})`,
            html: emailHtml
          }
        });
        
        console.log(`📧 Pool engine confirmation email sent to john@rokcup.co.za`);
      } else {
        console.log(`ℹ️ Race entry email SKIPPED - already sent during payment initiation`);
      }
      
    } catch (emailErr) {
      console.error('⚠️ Email sending failed (non-critical):', emailErr.message);
      // Don't fail the IPN response if email fails
    }
    
    // Delete old unused email code below
    /*
      const driverName = `${name_first || 'Driver'} ${name_last || ''}`.trim();
      
      // Fetch event details if not pool engine rental
      let eventName = 'Race Event';
      let eventDateStr = 'TBA';
      let eventLocation = 'TBA';
      let eventDate = null;
      
      if (!isPoolEngineRental && eventId && eventId !== 'unknown') {
        try {
          const eventResult = await pool.query(
            `SELECT event_id, event_name, event_date, location FROM events WHERE event_id = $1`,
            [eventId]
          );
          const eventDetails = eventResult.rows[0];
          if (eventDetails) {
            eventName = eventDetails.event_name || 'Race Event';
            eventDate = eventDetails.event_date;
            eventDateStr = eventDetails.event_date 
              ? new Date(eventDetails.event_date).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
              : 'TBA';
            eventLocation = eventDetails.location || 'TBA';
          }
        } catch (eventErr) {
          console.warn('⚠️ Could not fetch event details:', eventErr.message);
        }
      }
      
      // Build ticket HTML using unique references
      const hasFuel = itemDesc.includes('fuel');
      
      // Initialize rental tickets HTML (empty if no rentals)
      let ticketsHtml = '';
      
      if (hasEngine || hasTyres || hasTransponder || hasFuel) {
        ticketsHtml = '<div style="margin: 30px 0; border-top: 1px solid #e5e7eb; padding-top: 20px;"><div style="font-weight: 700; color: #111827; margin-bottom: 16px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em;">Rental Items</div>';
        
        if (hasEngine && ticketEngineRef) {
          ticketsHtml += `<div style="border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 16px; border-left: 6px solid #f97316;">
            <div style="font-size: 13px; color: #f97316; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">Engine Rental</div>
            <div style="font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 12px;">Pool Engine Reserved</div>
            <div style="font-size: 12px; color: #374151; line-height: 1.5;">Your competition engine is assigned for this event. Technical inspection required before practice.</div>
            <div style="background: #f9fafb; padding: 12px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #111827; letter-spacing: 0.05em; text-align: center; margin-top: 12px; border: 1px solid #e5e7eb;">${ticketEngineRef}</div>
          </div>`;
        }
        
        if (hasTyres && ticketTyresRef) {
          ticketsHtml += `<div style="border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 16px; border-left: 6px solid #8b5cf6;">
            <div style="font-size: 13px; color: #8b5cf6; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">Tyre Rental</div>
            <div style="font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 12px;">Complete Tyre Set</div>
            <div style="font-size: 12px; color: #374151; line-height: 1.5;">Tyres included with your entry. Available for collection at race practice day.</div>
            <div style="background: #f9fafb; padding: 12px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #111827; letter-spacing: 0.05em; text-align: center; margin-top: 12px; border: 1px solid #e5e7eb;">${ticketTyresRef}</div>
          </div>`;
        }
        
        if (hasTransponder && ticketTransponderRef) {
          ticketsHtml += `<div style="border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 16px; border-left: 6px solid #0ea5e9;">
            <div style="font-size: 13px; color: #0ea5e9; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">Transponder Rental</div>
            <div style="font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 12px;">Timing Transponder</div>
            <div style="font-size: 12px; color: #374151; line-height: 1.5;">Transponder issued at race control. Must be installed before technical inspection.</div>
            <div style="background: #f9fafb; padding: 12px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #111827; letter-spacing: 0.05em; text-align: center; margin-top: 12px; border: 1px solid #e5e7eb;">${ticketTransponderRef}</div>
          </div>`;
        }
        
        if (hasFuel && ticketFuelRef) {
          ticketsHtml += `<div style="border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 16px; border-left: 6px solid #10b981;">
            <div style="font-size: 13px; color: #10b981; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">Fuel Package</div>
            <div style="font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 12px;">Race Fuel Included</div>
            <div style="font-size: 12px; color: #374151; line-height: 1.5;">Pre-measured fuel allocation available at pit area.</div>
            <div style="background: #f9fafb; padding: 12px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #111827; letter-spacing: 0.05em; text-align: center; margin-top: 12px; border: 1px solid #e5e7eb;">${ticketFuelRef}</div>
          </div>`;
        }
        
        ticketsHtml += '</div>';
      }
      
      // Email HTML template
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Payment Confirmation — NATS 2026 ROK Cup</title>
          <style>
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #333; background: #f5f5f5; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
            .header { background: white; padding: 20px; text-align: center; border-bottom: 3px solid #22c55e; }
            .header-logo { margin-bottom: 16px; }
            .header-logo img { width: 140px; height: auto; }
            .header h1 { margin: 0; font-size: 24px; font-weight: 700; color: #111827; }
            .content { padding: 30px; }
            .details { background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22c55e; }
            .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
            .detail-row:last-child { border-bottom: none; }
            .detail-label { font-weight: 600; color: #6b7280; font-size: 13px; }
            .detail-value { color: #111827; font-weight: 500; }
            .amount { font-size: 22px; font-weight: 700; color: #22c55e; }
            .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body style="margin: 0; padding: 20px;">
          <div class="container">
            <div class="header">
              <div class="header-logo">
                <img src="https://www.dropbox.com/scl/fi/ryhszrvk76kd7yy6y0rtc/ROK-CUP-LOGO-2025.png?rlkey=k9dxlzbh5e9zw58v8t34yjzea&dl=1" alt="ROK Cup South Africa" />
              </div>
              <h1>Payment Confirmed</h1>
            </div>
            <div class="content">
              <p style="margin: 0 0 16px 0; font-size: 15px;">Hi ${driverName},</p>
              <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151;">Your race entry payment has been successfully processed. Thank you for registering with the NATS 2026 ROK Cup!</p>
              
              <div class="details">
                <div class="detail-row">
                  <span class="detail-label">Payment Reference</span>
                  <span class="detail-value">${reference}</span>
                </div>
                ${isPoolEngineRental ? `
                <div class="detail-row">
                  <span class="detail-label">Championship Class</span>
                  <span class="detail-value">${rentalClass}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Rental Type</span>
                  <span class="detail-value">${rentalType}</span>
                </div>
                ` : `
                <div class="detail-row">
                  <span class="detail-label">Event Name</span>
                  <span class="detail-value">${eventName}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Event Date</span>
                  <span class="detail-value">${eventDateStr}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Location</span>
                  <span class="detail-value">${eventLocation}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Race Class</span>
                  <span class="detail-value">${raceClass}</span>
                </div>
                `}
                <div class="detail-row">
                  <span class="detail-label">Amount Paid</span>
                  <span class="detail-value amount">R${parseFloat(amount_gross).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Transaction ID</span>
                  <span class="detail-value">${pf_payment_id}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Confirmation Date</span>
                  <span class="detail-value">${new Date().toLocaleDateString('en-ZA')}</span>
                </div>
              </div>
              
              ${isPoolEngineRental ? `
              <div style="margin: 30px 0; border-top: 1px solid #e5e7eb; padding-top: 20px;">
                <div style="font-weight: 700; color: #111827; margin-bottom: 16px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em;">Seasonal Engine Rental</div>
                <div style="border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; border-left: 6px solid #f97316;">
                  <div style="font-size: 13px; color: #f97316; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">🏎️ Engine Rental Confirmed</div>
                  <div style="font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 12px;">${rentalType} - ${rentalClass} Class</div>
                  <div style="font-size: 12px; color: #374151; line-height: 1.6; margin-bottom: 12px;">Your seasonal engine rental is now active. You can register for races without additional engine rental charges during the ${new Date().getFullYear()} season.</div>
                  <div style="background: #f9fafb; padding: 12px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #111827; letter-spacing: 0.05em; text-align: center; border: 1px solid #e5e7eb;">Season ${new Date().getFullYear()}</div>
                </div>
              </div>
              ` : ticketsHtml}
              
              ${!isPoolEngineRental ? generateRaceTicketHTML({
                reference,
                eventName,
                eventDate,
                eventLocation,
                raceClass,
                driverName,
                teamCode: null
              }) : ''}
              
              <p style="margin: 20px 0; font-size: 14px; color: #374151;">${isPoolEngineRental ? 'You can now enter races without additional engine charges for the remainder of the season. Thank you for your commitment to NATS!' : 'You will receive further instructions about your race entry shortly. If you have any questions, please contact us.'}</p>
              
              <p style="margin: 20px 0 0 0; font-size: 14px;">Best regards,<br><strong style="color: #22c55e;">NATS 2026 ROK Cup Team</strong></p>
            </div>
            <div class="footer">
              <p style="margin: 0; color: #6b7280;">This is an automated confirmation email. Please do not reply to this message.</p>
              <p style="margin: 8px 0 0 0;"><a href="https://rokthenats.co.za/" style="color: #2563eb; text-decoration: none; font-weight: 600;">Visit the NATS Event Hub</a></p>
            </div>
          </div>
        </body>
        </html>
      `;

      // Send to driver
      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: email_address, name: driverName }],
          bcc_address: 'africankartingcup@gmail.com',
          from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
          subject: `Payment Confirmation - ${eventName} (${raceClass})`,
          html: emailHtml
        }
      });
      
      console.log(`📧 Confirmation email sent to driver: ${email_address}`);

      // Send to John (CC)
      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: 'john@rokcup.co.za', name: 'John' }],
          bcc_address: 'africankartingcup@gmail.com',
          from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
          subject: `Payment Received - ${driverName} (${raceClass})`,
          html: emailHtml
        }
      });
      
      console.log(`📧 Confirmation email sent to john@rokcup.co.za`);
    */
    // END OLD UNUSED EMAIL CODE - COMMENTED OUT

    // Mark webhook as successfully processed
    if (webhookId) {
      await pool.query(
        `UPDATE payfast_webhooks 
         SET processing_status = 'processed', 
             matched_entry_id = $1,
             matched_driver_id = $2, 
             matched_event_id = $3,
             processed_at = NOW() 
         WHERE webhook_id = $4`,
        [race_entry_id, driverId, isPoolEngineRental ? 'POOL' : eventId, webhookId]
      );
      console.log(`✅ Webhook ${webhookId} marked as processed`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('❌ paymentNotify error:', err.message);
    
    // Mark webhook as errored
    if (webhookId) {
      try {
        await pool.query(
          `UPDATE payfast_webhooks SET processing_status = 'error', processing_error = $1, processed_at = NOW() WHERE webhook_id = $2`,
          [err.message, webhookId]
        );
      } catch (updateErr) {
        console.error('Failed to update webhook error status:', updateErr.message);
      }
    }
    
    // ✅ FIX #3: Log failed notifications to file for manual recovery
    const fs = require('fs');
    const path = require('path');
    const logsDir = path.join(__dirname, 'logs');
    const failedNotificationsFile = path.join(logsDir, 'failed_notifications.json');
    
    try {
      // Ensure logs directory exists
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      
      const logEntry = {
        timestamp: new Date().toISOString(),
        error: err.message,
        stack: err.stack,
        payload: req.body,
        headers: req.headers
      };
      
      // Append to file (one JSON object per line for easy parsing)
      fs.appendFileSync(failedNotificationsFile, JSON.stringify(logEntry) + '\n');
      console.log(`📝 Failed notification logged to ${failedNotificationsFile}`);
    } catch (logErr) {
      console.error('⚠️ Could not log failed notification:', logErr.message);
    }
    
    // Still respond 200 to PayFast so they don't keep retrying (they won't anyway)
    res.status(200).json({ success: false, error: err.message });
  }
});

// ========================================
// PAYFAST WEBHOOKS MANAGEMENT ENDPOINTS
// ========================================

// Get all PayFast webhooks with filtering
app.post('/api/payfast/webhooks', async (req, res) => {
  try {
    const { status, startDate, endDate, limit = 100 } = req.body;
    
    let query = `
      SELECT 
        webhook_id, m_payment_id, pf_payment_id, payment_status,
        item_name, item_description, amount_gross, reference, 
        email_address, name_first, name_last, signature_valid,
        processing_status, processing_error, 
        matched_entry_id, matched_driver_id, matched_event_id,
        reconciled_by, reconciled_at,
        received_at, processed_at
      FROM payfast_webhooks
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (status) {
      query += ` AND processing_status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    if (startDate) {
      query += ` AND received_at >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }
    
    if (endDate) {
      query += ` AND received_at <= $${paramIndex}`;
      params.push(endDate);
      paramIndex++;
    }
    
    query += ` ORDER BY received_at DESC LIMIT $${paramIndex}`;
    params.push(limit);
    
    const result = await pool.query(query, params);
    
    // Get summary stats
    const statsResult = await pool.query(`
      SELECT 
        processing_status,
        COUNT(*) as count,
        SUM(amount_gross::numeric) as total_amount
      FROM payfast_webhooks
      GROUP BY processing_status
    `);
    
    res.json({
      success: true,
      webhooks: result.rows,
      stats: statsResult.rows
    });
  } catch (err) {
    console.error('Error fetching webhooks:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single webhook details including raw data
app.get('/api/payfast/webhook/:webhookId', async (req, res) => {
  try {
    const { webhookId } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM payfast_webhooks WHERE webhook_id = $1',
      [webhookId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Webhook not found' });
    }
    
    res.json({
      success: true,
      webhook: result.rows[0]
    });
  } catch (err) {
    console.error('Error fetching webhook:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manual reconciliation - match webhook to driver/event
app.post('/api/payfast/reconcile', async (req, res) => {
  try {
    const { webhookId, driverId, eventId, adminEmail } = req.body;
    
    if (!webhookId || !driverId || !eventId) {
      return res.status(400).json({ 
        success: false, 
        error: 'webhookId, driverId, and eventId are required' 
      });
    }
    
    // Get webhook details
    const webhookResult = await pool.query(
      'SELECT * FROM payfast_webhooks WHERE webhook_id = $1',
      [webhookId]
    );
    
    if (webhookResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Webhook not found' });
    }
    
    const webhook = webhookResult.rows[0];
    
    // Create race entry from webhook data
    const entryId = `manual_${webhook.pf_payment_id || webhook.m_payment_id}`;
    const reference = webhook. reference || `MANUAL-${eventId}-${driverId}-${Date.now()}`;
    
    // Get event and driver details
    const eventInfo = await pool.query('SELECT * FROM events WHERE event_id = $1', [eventId]);
    const driverInfo = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driverId]);
    
    if (eventInfo.rows.length === 0 || driverInfo.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Event or driver not found' });
    }
    
    const event = eventInfo.rows[0];
    const driver = driverInfo.rows[0];
    const raceClass = driver.class || 'Unknown';
    
    // Insert or update race entry
    await pool.query(
      `INSERT INTO race_entries (
        entry_id, event_id, driver_id, payment_reference, 
        payment_status, entry_status, amount_paid, race_class,
        entry_items, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (payment_reference) 
      DO UPDATE SET 
        payment_status = 'Completed',
        entry_status = 'confirmed',
        amount_paid = $7
      RETURNING *`,
      [
        entryId, eventId, driverId, reference,
        'Completed', 'confirmed', webhook.amount_gross, raceClass,
        JSON.stringify({ manually_reconciled: true })
      ]
    );
    
    // Update webhook as reconciled
    await pool.query(
      `UPDATE payfast_webhooks 
       SET processing_status = 'reconciled',
           matched_entry_id = $1,
           matched_driver_id = $2,
           matched_event_id = $3,
           reconciled_by = $4,
           reconciled_at = NOW(),
           processed_at = NOW()
       WHERE webhook_id = $5`,
      [entryId, driverId, eventId, adminEmail || 'admin', webhookId]
    );
    
    // Log audit event
    await logAuditEvent(
      driverId,
      driver.email || driver.driver_email,
      'Manual Payment Reconciliation',
      'race_entry',
      null,
      `Manually reconciled PayFast webhook ${webhookId} to ${event.event_name}`,
      'admin'
    );
    
    // Create Trello card for manually reconciled entry
    try {
      console.log('📋 Creating Trello card for manually reconciled entry...');
      const driverName = `${driver.first_name} ${driver.last_name}`.trim();
      const driverEmail = driver.email || driver.driver_email || 'unknown@email.com';
      
      await createTrelloCard(
        driverName,
        driverEmail,
        raceClass,
        null, // teamCode
        reference,
        driverId
      );
      
      console.log(`✅ Trello card created for manually reconciled entry: ${driverName}`);
    } catch (trelloErr) {
      console.error('⚠️ Trello card creation failed (non-critical):', trelloErr.message);
    }
    
    res.json({
      success: true,
      message: 'Webhook reconciled successfully',
      entryId: entryId,
      driver: `${driver.first_name} ${driver.last_name}`,
      event: event.event_name,
      amount: webhook.amount_gross
    });
  } catch (err) {
    console.error('Error reconciling webhook:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reprocess a failed webhook
app.post('/api/payfast/reprocess', async (req, res) => {
  try {
    const { webhookId } = req.body;
    
    if (!webhookId) {
      return res.status(400).json({ success: false, error: 'webhookId is required' });
    }
    
    // Get webhook
    const result = await pool.query(
      'SELECT * FROM payfast_webhooks WHERE webhook_id = $1',
      [webhookId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Webhook not found' });
    }
    
    const webhook = result.rows[0];
    
    // Reset processing status
    await pool.query(
      `UPDATE payfast_webhooks 
       SET processing_status = 'reprocessing', 
           processing_error = NULL, 
           processed_at = NULL 
       WHERE webhook_id = $1`,
      [webhookId]
    );
    
    // TODO: Trigger actual reprocessing logic here
    // For now, just mark it for manual review
    
    res.json({
      success: true,
      message: 'Webhook marked for reprocessing',
      webhook: webhook
    });
  } catch (err) {
    console.error('Error reprocessing webhook:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Reprocess webhooks that previously failed signature verification
// Uses the corrected signature algorithm against stored raw_data
app.post('/api/admin/reprocessFailedWebhooks', async (req, res) => {
  try {
    const pfCfg = getPayFastConfig();
    const passphrase = pfCfg.passphrase;

    // Find all COMPLETE webhooks that failed signature verification
    const failed = await pool.query(
      `SELECT webhook_id, m_payment_id, pf_payment_id, payment_status, amount_gross, raw_data, signature
       FROM payfast_webhooks 
       WHERE processing_status IN ('signature_invalid', 'still_invalid') AND payment_status = 'COMPLETE'
       ORDER BY received_at DESC`
    );

    console.log(`🔄 Found ${failed.rows.length} failed webhooks to reprocess`);
    const results = [];

    for (const wh of failed.rows) {
      const reference = wh.m_payment_id;
      if (!reference) {
        results.push({ webhook_id: wh.webhook_id, status: 'error', error: 'No m_payment_id' });
        continue;
      }

      // Find the pending entry
      const existing = await pool.query(
        'SELECT * FROM race_entries WHERE payment_reference = $1',
        [reference]
      );

      if (existing.rows.length === 0) {
        results.push({ webhook_id: wh.webhook_id, m_payment_id: reference, status: 'no_entry_found' });
        continue;
      }

      // Admin reprocess: trust COMPLETE status, skip signature re-verification
      // (JSONB storage destroys original field order making signature impossible to recompute)
      await pool.query(
        `UPDATE race_entries SET payment_status = 'Completed', entry_status = 'confirmed', updated_at = NOW()
         WHERE payment_reference = $1`,
        [reference]
      );

      await pool.query(
        `UPDATE payfast_webhooks SET processing_status = 'reprocessed', processed_at = NOW(),
         processing_error = 'Admin reprocess: COMPLETE status trusted, sig not re-verifiable from JSONB'
         WHERE webhook_id = $1`,
        [wh.webhook_id]
      );

      results.push({ webhook_id: wh.webhook_id, m_payment_id: reference, status: 'fixed', entry_id: existing.rows[0].entry_id });
      console.log(`✅ Reprocessed webhook ${wh.webhook_id} → entry ${existing.rows[0].entry_id} confirmed`);
    }

    res.json({ success: true, processed: results.length, results });
  } catch (err) {
    console.error('❌ reprocessFailedWebhooks error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ FIX #4: Manual Payment Reconciliation Endpoint
// Allows admins to manually process a PayFast payment if notification was missed
app.post('/api/admin/reconcilePayment', async (req, res) => {
  try {
    const { 
      entry_id,
      race_entry_id,
      payment_reference, 
      amount_paid,
      pf_payment_id,
      amount_gross,
      payment_status,
      email_address,
      name_first,
      name_last
    } = req.body;

    // Accept both entry_id and race_entry_id for backwards compatibility
    const entryId = entry_id || race_entry_id;

    // If entry_id is provided, update existing entry
    if (entryId) {
      console.log(`🔄 Reconciling payment for existing entry: ${entryId}`);
      
      if (!payment_reference) {
        throw new Error('Payment reference is required');
      }
      
      // Update the existing entry with payment info - use entry_id (production column name)
      const result = await pool.query(
        `UPDATE race_entries 
         SET payment_reference = $1, 
             payment_status = $2, 
             amount_paid = $3,
             entry_status = COALESCE(entry_status, 'confirmed'),
             updated_at = NOW()
         WHERE entry_id = $4
         RETURNING *`,
        [payment_reference, payment_status || 'Completed', amount_paid || 0, entryId]
      );
      
      if (result.rows.length === 0) {
        throw new Error('Race entry not found');
      }
      
      console.log(`✅ Entry reconciled: ${entryId}`);
      return res.json({ 
        success: true, 
        message: 'Payment reconciled successfully',
        data: result.rows[0]
      });
    }

    // Original logic for creating new entries from payment references
    if (!payment_reference) {
      throw new Error('Payment reference is required');
    }

    console.log(`🔄 Manual reconciliation requested for: ${payment_reference}`);

    // Parse reference to extract info
    const referenceParts = payment_reference.split('-');
    const isPoolEngineRental = payment_reference.startsWith('POOL-');
    
    let eventId, driverId, rentalClass, rentalType;
    
    if (isPoolEngineRental) {
      rentalClass = referenceParts[1] || 'UNKNOWN';
      rentalType = referenceParts[2] || 'UNKNOWN';
      driverId = referenceParts[3] || 'unknown';
      
      // Check if already exists
      const existing = await pool.query(
        'SELECT * FROM pool_engine_rentals WHERE payment_reference = $1',
        [payment_reference]
      );
      
      if (existing.rows.length > 0) {
        return res.json({ 
          success: true, 
          message: 'Payment already reconciled',
          data: existing.rows[0]
        });
      }
      
      // Create pool engine rental
      const rentalId = `pool_rental_${pf_payment_id || Date.now()}`;
      await pool.query(
        `INSERT INTO pool_engine_rentals (
          rental_id, driver_id, championship_class, rental_type, 
          amount_paid, payment_status, payment_reference, season_year, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
        [rentalId, driverId, rentalClass, rentalType, amount_gross, payment_status || 'Completed', payment_reference, new Date().getFullYear()]
      );
      
      await pool.query(
        'UPDATE drivers SET season_engine_rental = $1 WHERE driver_id = $2',
        ['Y', driverId]
      );
      
      console.log(`✅ Pool engine rental reconciled: ${rentalId}`);
      res.json({ success: true, message: 'Pool engine rental reconciled successfully', rental_id: rentalId });
      
    } else {
      // Race entry
      eventId = referenceParts[1] || 'unknown';
      driverId = referenceParts[2] || 'unknown';
      
      // Check if already exists
      const existing = await pool.query(
        'SELECT * FROM race_entries WHERE payment_reference = $1',
        [payment_reference]
      );
      
      if (existing.rows.length > 0) {
        return res.json({ 
          success: true, 
          message: 'Payment already reconciled',
          data: existing.rows[0]
        });
      }
      
      // Create race entry using entry_id as primary key (production column name)
      const entry_id = `race_entry_${pf_payment_id || Date.now()}_manual`;
      await pool.query(
        `INSERT INTO race_entries (
          entry_id, event_id, driver_id, payment_reference, payment_status, 
          entry_status, amount_paid, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
        [entry_id, eventId, driverId, payment_reference, payment_status || 'Completed', 'confirmed', amount_gross]
      );
      
      console.log(`✅ Race entry reconciled: ${entry_id}`);
      res.json({ success: true, message: 'Race entry reconciled successfully', entry_id: entry_id });
    }
  } catch (err) {
    console.error('❌ Error reconciling payment:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Manually add race entry (no payment reference)
app.post('/api/adminAddRaceEntry', async (req, res) => {
  try {
    const {
      event_id,
      driver_id,
      race_class,
      entry_items,
      race_days,
      payment_status,
      entry_status,
      amount_paid,
      send_emails,
      create_trello_card,
      update_engine_status
    } = req.body;

    if (!event_id || !driver_id || !race_class) {
      throw new Error('Missing required fields: event_id, driver_id, race_class');
    }

    // Get driver details
    const driverResult = await pool.query(
      'SELECT d.first_name, d.last_name, c.email, d.transponder_number FROM drivers d LEFT JOIN contacts c ON d.driver_id = c.driver_id WHERE d.driver_id = $1',
      [driver_id]
    );
    
    if (driverResult.rows.length === 0) {
      throw new Error('Driver not found');
    }
    
    const driver = driverResult.rows[0];
    
    // Check for existing entry
    const existingEntry = await pool.query(
      'SELECT * FROM race_entries WHERE driver_id = $1 AND event_id = $2 AND (payment_reference IS NULL OR payment_reference = \'\')',
      [driver_id, event_id]
    );
    
    if (existingEntry.rows.length > 0) {
      return res.json({ success: false, error: 'Driver already has a manual entry for this event' });
    }
    
    // Generate race_entry_id and ticket references (using same format as payment entries)
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const race_entry_id = `race_entry_${timestamp}_${randomSuffix}`;
    
    const hasEngine = entry_items?.some(item => item.toLowerCase().includes('engine'));
    const hasTyres = entry_items?.some(item => item.toLowerCase().includes('tyre'));
    const hasTransponder = entry_items?.some(item => item.toLowerCase().includes('transponder'));
    const hasFuel = entry_items?.some(item => item.toLowerCase().includes('fuel'));

    // Generate multiple ticket refs for Both Days entries (same logic as registerFreeRaceEntry)
    const isBothDays = (race_days === 'Both');
    const genRefs = (type, n) => {
      const refs = [];
      for (let i = 0; i < n; i++) refs.push(generateUniqueTicketRef(type, driver_id, event_id));
      return n === 1 ? refs[0] : JSON.stringify(refs);
    };

    const ticketEngineRef      = hasEngine      ? genRefs('engine',      1) : null;
    const ticketTyresRef       = hasTyres       ? genRefs('tyres',       1) : null;
    const ticketTransponderRef = hasTransponder ? genRefs('transponder', 1) : null;
    const ticketFuelRef        = hasFuel        ? genRefs('fuel', 1) : null;

    console.log(`📅 Race days: ${race_days || 'Saturday'} | isBothDays: ${isBothDays}`);
    if (hasEngine)      console.log(`  Engine refs: ${ticketEngineRef}`);
    if (hasTyres)       console.log(`  Tyres refs:  ${ticketTyresRef}`);
    if (hasTransponder) console.log(`  TX refs:     ${ticketTransponderRef}`);

    // Insert entry
    await pool.query(
      `INSERT INTO race_entries (
        entry_id, event_id, driver_id, 
        race_class, entry_items,
        payment_status, entry_status, amount_paid,
        ticket_engine_ref, ticket_tyres_ref, ticket_transponder_ref, ticket_fuel_ref,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
      [
        race_entry_id,
        event_id,
        driver_id,
        race_class,
        JSON.stringify(entry_items || []),
        payment_status || 'Completed',
        entry_status || 'confirmed',
        amount_paid || 0,
        ticketEngineRef,
        ticketTyresRef,
        ticketTransponderRef,
        ticketFuelRef
      ]
    );
    
    console.log(`✅ Manual entry added: ${race_entry_id} for ${driver.first_name} ${driver.last_name} - ${race_class}`);
    
    // Update engine status if needed
    if (update_engine_status && hasEngine) {
      try {
        await pool.query(
          'UPDATE drivers SET season_engine_rental = $1 WHERE driver_id = $2',
          ['Y', driver_id]
        );
        console.log(`✅ Updated engine status for driver ${driver_id}`);
      } catch (engineErr) {
        console.error('⚠️ Failed to update engine status:', engineErr.message);
      }
    }
    
    // Send emails if requested
    if (send_emails) {
      try {
        const eventResult = await pool.query(
          'SELECT event_name, event_date, location FROM events WHERE event_id = $1',
          [event_id]
        );
        
        const event = eventResult.rows[0] || {};
        const driverName = `${driver.first_name} ${driver.last_name}`.trim();
        
        // Build email with tickets
        const emailResponse = await axios.post(`http://localhost:${process.env.PORT || 3000}/api/sendRaceTicketsEmail`, {
          race_entry_id: race_entry_id
        });
        
        console.log(`✅ Confirmation emails sent for ${driverName}`);
      } catch (emailErr) {
        console.error('⚠️ Failed to send emails (non-critical):', emailErr.message);
      }
    }
    
    // Create Trello card if requested
    if (create_trello_card) {
      try {
        console.log('📋 Creating Trello card for admin-added entry...');
        const driverName = `${driver.first_name} ${driver.last_name}`.trim();
        const driverEmail = driver.email || 'unknown@email.com';
        
        await createTrelloCard(
          driverName,
          driverEmail,
          race_class,
          null, // teamCode
          race_entry_id, // Use entry ID as reference
          driver_id
        );
        
        console.log(`✅ Trello card created for admin-added entry: ${driverName}`);
      } catch (trelloErr) {
        console.error('⚠️ Failed to create Trello card (non-critical):', trelloErr.message);
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Entry added successfully',
      entry_id: race_entry_id
    });
    
  } catch (err) {
    console.error('Error adding manual entry:', err);
    res.json({ success: false, error: err.message });
  }
});

// Admin: Send/Resend race entry confirmation email with tickets
app.post('/api/sendRaceTicketsEmail', async (req, res) => {
  try {
    const { race_entry_id } = req.body;

    if (!race_entry_id) {
      throw new Error('Missing race_entry_id');
    }

    // Get entry details with driver and event info
    const entryResult = await pool.query(
      `SELECT 
        re.*,
        d.first_name, d.last_name, d.race_number as driver_race_number, c.email as driver_email,
        e.event_name, e.event_date, e.location
       FROM race_entries re
       LEFT JOIN drivers d ON re.driver_id = d.driver_id
       LEFT JOIN contacts c ON re.driver_id = c.driver_id
       LEFT JOIN events e ON re.event_id = e.event_id
       WHERE re.entry_id = $1`,
      [race_entry_id]
    );
    
    if (entryResult.rows.length === 0) {
      throw new Error('Race entry not found');
    }
    
    const entry = entryResult.rows[0];
    const driverName = `${entry.first_name} ${entry.last_name}`.trim();
    const driverEmail = entry.driver_email || entry.email || 'noreply@nats.co.za';
    
    // Parse entry items
    let entryItems = [];
    try {
      entryItems = typeof entry.entry_items === 'string' 
        ? JSON.parse(entry.entry_items) 
        : (Array.isArray(entry.entry_items) ? entry.entry_items : []);
    } catch (e) {
      console.warn('Could not parse entry_items:', e);
    }
    
    // Check both entry_items AND the engine column (for older entries)
    const hasEngineFromItems = entryItems.some(item => item.toLowerCase().includes('engine'));
    const hasEngineFromColumn = entry.engine === 1 || entry.engine === '1' || entry.engine === true;
    const hasEngine = hasEngineFromItems || hasEngineFromColumn;
    
    const hasTyres = entryItems.some(item => item.toLowerCase().includes('tyre'));
    const hasTransponder = entryItems.some(item => item.toLowerCase().includes('transponder'));
    const hasFuel = entryItems.some(item => item.toLowerCase().includes('fuel'));
    
    // Generate ticket references if not present
    if (hasEngine && !entry.ticket_engine_ref) {
      entry.ticket_engine_ref = generateUniqueTicketRef('engine', entry.driver_id, entry.event_id);
      await pool.query('UPDATE race_entries SET ticket_engine_ref = $1 WHERE entry_id = $2', 
        [entry.ticket_engine_ref, race_entry_id]);
    }
    if (hasTyres && !entry.ticket_tyres_ref) {
      entry.ticket_tyres_ref = generateUniqueTicketRef('tyres', entry.driver_id, entry.event_id);
      await pool.query('UPDATE race_entries SET ticket_tyres_ref = $1 WHERE entry_id = $2', 
        [entry.ticket_tyres_ref, race_entry_id]);
    }
    if (hasTransponder && !entry.ticket_transponder_ref) {
      entry.ticket_transponder_ref = generateUniqueTicketRef('transponder', entry.driver_id, entry.event_id);
      await pool.query('UPDATE race_entries SET ticket_transponder_ref = $1 WHERE entry_id = $2', 
        [entry.ticket_transponder_ref, race_entry_id]);
    }
    if (hasFuel && !entry.ticket_fuel_ref) {
      entry.ticket_fuel_ref = generateUniqueTicketRef('fuel', entry.driver_id, entry.event_id);
      await pool.query('UPDATE race_entries SET ticket_fuel_ref = $1 WHERE entry_id = $2', 
        [entry.ticket_fuel_ref, race_entry_id]);
    }
    
    // Helper to parse ref field — single string or JSON array
    const parseTicketRefs = (field) => {
      if (!field) return [];
      try { const p = JSON.parse(field); return Array.isArray(p) ? p : [field]; } catch { return [field]; }
    };

    // Build rental tickets HTML — multiple tickets per item for Both Days entries
    let rentalTicketsHtml = '';
    if (hasEngine && entry.ticket_engine_ref) {
      const engineRefs = parseTicketRefs(entry.ticket_engine_ref);
      const engineDayLabels = engineRefs.length >= 3
        ? ['FRIDAY – PRACTICE DAY', 'SATURDAY', 'SUNDAY']
        : engineRefs.length === 2 ? ['SATURDAY', 'SUNDAY'] : [''];
      engineRefs.forEach((ref, i) => {
        rentalTicketsHtml += generateEngineRentalTicketHTML({
          reference: ref, eventName: entry.event_name, eventDate: entry.event_date,
          eventLocation: entry.location, raceClass: entry.race_class, driverName,
          raceNumber: entry.driver_race_number, dayLabel: engineDayLabels[i] || ''
        });
      });
    }
    if (hasTyres && entry.ticket_tyres_ref) {
      const tyreRefs = parseTicketRefs(entry.ticket_tyres_ref);
      const tyreDayLabels = tyreRefs.length >= 2 ? ['SATURDAY', 'SUNDAY'] : [''];
      tyreRefs.forEach((ref, i) => {
        rentalTicketsHtml += generateTyreRentalTicketHTML({
          reference: ref, eventName: entry.event_name, eventDate: entry.event_date,
          eventLocation: entry.location, raceClass: entry.race_class, driverName,
          dayLabel: tyreDayLabels[i] || ''
        });
      });
    }
    if (hasTransponder && entry.ticket_transponder_ref) {
      const txRefs = parseTicketRefs(entry.ticket_transponder_ref);
      const txDayLabels = txRefs.length >= 2 ? ['SATURDAY', 'SUNDAY'] : [''];
      txRefs.forEach((ref, i) => {
        rentalTicketsHtml += generateTransponderRentalTicketHTML({
          reference: ref, eventName: entry.event_name, eventDate: entry.event_date,
          eventLocation: entry.location, raceClass: entry.race_class, driverName,
          dayLabel: txDayLabels[i] || ''
        });
      });
    }
    if (hasFuel && entry.ticket_fuel_ref) {
      const fuelRefs = parseTicketRefs(entry.ticket_fuel_ref);
      const fuelDayLabel = fuelRefs.length >= 3 ? 'FRIDAY · SATURDAY · SUNDAY' : '';
      rentalTicketsHtml += generateFuelTicketHTML({
        reference: fuelRefs[0] || entry.ticket_fuel_ref, eventName: entry.event_name,
        eventDate: entry.event_date, eventLocation: entry.location,
        raceClass: entry.race_class, driverName, dayLabel: fuelDayLabel
      });
    }
    
    // Format event details
    const eventName = entry.event_name || 'Race Event';
    const eventDateStr = entry.event_date 
      ? new Date(entry.event_date).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      : 'TBA';
    const eventLocation = entry.location || 'TBA';
    
    // Email HTML
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Race Entry Confirmation — NATS 2026 ROK Cup</title>
        <style>
          body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #333; background: #f5f5f5; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
          .header { background: white; padding: 20px; text-align: center; border-bottom: 3px solid #22c55e; }
          .header-logo { margin-bottom: 16px; }
          .header-logo img { width: 140px; height: auto; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 700; color: #111827; }
          .content { padding: 30px; }
          .details { background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22c55e; }
          .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
          .detail-row:last-child { border-bottom: none; }
          .detail-label { font-weight: 600; color: #6b7280; font-size: 13px; }
          .detail-value { color: #111827; font-weight: 500; }
          .amount { font-size: 22px; font-weight: 700; color: #22c55e; }
          .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; }
        </style>
      </head>
      <body style="margin: 0; padding: 20px;">
        <div class="container">
          <div class="header">
            <div class="header-logo">
              <img src="https://www.dropbox.com/scl/fi/ryhszrvk76kd7yy6y0rtc/ROK-CUP-LOGO-2025.png?rlkey=k9dxlzbh5e9zw58v8t34yjzea&dl=1" alt="ROK Cup South Africa" />
            </div>
            <h1>Race Entry Confirmed</h1>
          </div>
          <div class="content">
            <p style="margin: 0 0 16px 0; font-size: 15px;">Hi ${driverName},</p>
            <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151;">Your race entry has been confirmed. Below are your event details and rental item tickets.</p>
            
            <div class="details">
              <div class="detail-row">
                <span class="detail-label">Entry ID</span>
                <span class="detail-value">${race_entry_id}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Event Name</span>
                <span class="detail-value">${eventName}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Event Date</span>
                <span class="detail-value">${eventDateStr}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Location</span>
                <span class="detail-value">${eventLocation}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Race Class</span>
                <span class="detail-value">${entry.race_class}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Payment Status</span>
                <span class="detail-value">${entry.payment_status}</span>
              </div>
            </div>
            
            ${generateRaceTicketHTML({
              reference: entry.payment_reference || race_entry_id,
              eventName,
              eventDate: entry.event_date,
              eventLocation,
              raceClass: entry.race_class,
              driverName,
              teamCode: null
            })}
            
            ${rentalTicketsHtml}
            
            <p style="margin: 20px 0; font-size: 14px; color: #374151;">See you at the track! If you have any questions, please contact us.</p>
            
            <p style="margin: 20px 0 0 0; font-size: 14px;">Best regards,<br><strong style="color: #22c55e;">NATS 2026 ROK Cup Team</strong></p>
          </div>
          <div class="footer">
            <p style="margin: 0; color: #6b7280;">This is an automated confirmation email. Please do not reply to this message.</p>
            <p style="margin: 8px 0 0 0;"><a href="https://rokthenats.co.za/" style="color: #2563eb; text-decoration: none; font-weight: 600;">Visit the NATS Event Hub</a></p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Send email
    await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
      key: process.env.MAILCHIMP_API_KEY,
      message: {
        to: [{ email: driverEmail, name: driverName }],
        bcc_address: 'africankartingcup@gmail.com',
        from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
        from_name: 'The ROK Cup',
        subject: `Race Entry Confirmation - ${eventName} (${entry.race_class})`,
        html: emailHtml
      }
    });
    
    console.log(`📧 Race tickets email sent to: ${driverEmail} for entry ${race_entry_id}`);
    
    res.json({ 
      success: true, 
      message: `Tickets email sent to ${driverEmail}`
    });
    
  } catch (err) {
    console.error('Error sending tickets email:', err);
    res.json({ success: false, error: err.message });
  }
});

// Admin: Update entry items and resend tickets (for fixing old entries)
app.post('/api/updateAndResendTickets', async (req, res) => {
  try {
    const { race_entry_id, entry_items, amount_paid, race_days } = req.body;

    if (!race_entry_id || !entry_items) {
      throw new Error('Missing race_entry_id or entry_items');
    }

    // Get entry details
    const entryResult = await pool.query(
      `SELECT 
        re.*,
        d.first_name, d.last_name, d.race_number as driver_race_number, c.email as driver_email,
        e.event_name, e.event_date, e.location
       FROM race_entries re
       LEFT JOIN drivers d ON re.driver_id = d.driver_id
       LEFT JOIN contacts c ON re.driver_id = c.driver_id
       LEFT JOIN events e ON re.event_id = e.event_id
       WHERE re.entry_id = $1`,
      [race_entry_id]
    );
    
    if (entryResult.rows.length === 0) {
      throw new Error('Race entry not found');
    }
    
    const entry = entryResult.rows[0];
    const driverName = `${entry.first_name} ${entry.last_name}`.trim();
    const driverEmail = entry.driver_email || entry.email || 'noreply@nats.co.za';
    
    // Determine what items are selected
    const hasEngine = entry_items.some(item => item.toLowerCase().includes('engine'));
    const hasTyres = entry_items.some(item => item.toLowerCase().includes('tyre'));
    const hasTransponder = entry_items.some(item => item.toLowerCase().includes('transponder'));
    const hasFuel = entry_items.some(item => item.toLowerCase().includes('fuel'));
    
    // Generate ticket references for missing items (respects race_days for multi-ref generation)
    const isBothDays = (race_days === 'Both');
    const genRefs = (type, n) => {
      const refs = [];
      for (let i = 0; i < n; i++) refs.push(generateUniqueTicketRef(type, entry.driver_id, entry.event_id));
      return n === 1 ? refs[0] : JSON.stringify(refs);
    };

    let ticketEngineRef = entry.ticket_engine_ref;
    let ticketTyresRef = entry.ticket_tyres_ref;
    let ticketTransponderRef = entry.ticket_transponder_ref;
    let ticketFuelRef = entry.ticket_fuel_ref;
    
    if (hasEngine && !ticketEngineRef) {
      ticketEngineRef = genRefs('engine', 1);
    }
    if (hasTyres && !ticketTyresRef) {
      ticketTyresRef = genRefs('tyres', 1);
    }
    if (hasTransponder && !ticketTransponderRef) {
      ticketTransponderRef = genRefs('transponder', 1);
    }
    if (hasFuel && !ticketFuelRef) {
      ticketFuelRef = genRefs('fuel', 1);
    }
    
    console.log(`📅 Race days: ${race_days || 'single'} | isBothDays: ${isBothDays}`);
    
    // Update database with new entry_items, amount, and ticket refs
    await pool.query(
      `UPDATE race_entries 
       SET entry_items = $1,
           amount_paid = $2,
           ticket_engine_ref = $3,
           ticket_tyres_ref = $4,
           ticket_transponder_ref = $5,
           ticket_fuel_ref = $6,
           updated_at = NOW()
       WHERE entry_id = $7`,
      [JSON.stringify(entry_items), amount_paid || entry.amount_paid, 
       ticketEngineRef, ticketTyresRef, ticketTransponderRef, ticketFuelRef, race_entry_id]
    );
    
    console.log(`✅ Updated entry ${race_entry_id} with items:`, entry_items);
    console.log(`   Ticket refs - Engine: ${ticketEngineRef}, Tyres: ${ticketTyresRef}, Transponder: ${ticketTransponderRef}, Fuel: ${ticketFuelRef}`);
    
    // Helper to parse ref field — single string or JSON array
    const parseTicketRefsAdmin = (field) => {
      if (!field) return [];
      try { const p = JSON.parse(field); return Array.isArray(p) ? p : [field]; } catch { return [field]; }
    };

    // Build rental tickets HTML
    let rentalTicketsHtml = '';
    if (hasEngine && ticketEngineRef) {
      const engineRefs = parseTicketRefsAdmin(ticketEngineRef);
      const engineDayLabels = engineRefs.length >= 3
        ? ['FRIDAY – PRACTICE DAY', 'SATURDAY', 'SUNDAY']
        : engineRefs.length === 2 ? ['SATURDAY', 'SUNDAY'] : [''];
      engineRefs.forEach((ref, i) => {
        rentalTicketsHtml += generateEngineRentalTicketHTML({
          reference: ref, eventName: entry.event_name, eventDate: entry.event_date,
          eventLocation: entry.location, raceClass: entry.race_class, driverName,
          raceNumber: entry.driver_race_number, dayLabel: engineDayLabels[i] || ''
        });
      });
    }
    if (hasTyres && ticketTyresRef) {
      const tyreRefs = parseTicketRefsAdmin(ticketTyresRef);
      const tyreDayLabels = tyreRefs.length >= 2 ? ['SATURDAY', 'SUNDAY'] : [''];
      tyreRefs.forEach((ref, i) => {
        rentalTicketsHtml += generateTyreRentalTicketHTML({
          reference: ref, eventName: entry.event_name, eventDate: entry.event_date,
          eventLocation: entry.location, raceClass: entry.race_class, driverName,
          dayLabel: tyreDayLabels[i] || ''
        });
      });
    }
    if (hasTransponder && ticketTransponderRef) {
      const txRefs = parseTicketRefsAdmin(ticketTransponderRef);
      const txDayLabels = txRefs.length >= 2 ? ['SATURDAY', 'SUNDAY'] : [''];
      txRefs.forEach((ref, i) => {
        rentalTicketsHtml += generateTransponderRentalTicketHTML({
          reference: ref, eventName: entry.event_name, eventDate: entry.event_date,
          eventLocation: entry.location, raceClass: entry.race_class, driverName,
          dayLabel: txDayLabels[i] || ''
        });
      });
    }
    if (hasFuel && ticketFuelRef) {
      const fuelRefs = parseTicketRefsAdmin(ticketFuelRef);
      const fuelDayLabel = fuelRefs.length >= 3 ? 'FRIDAY · SATURDAY · SUNDAY' : '';
      rentalTicketsHtml += generateFuelTicketHTML({
        reference: fuelRefs[0] || ticketFuelRef, eventName: entry.event_name,
        eventDate: entry.event_date, eventLocation: entry.location,
        raceClass: entry.race_class, driverName, dayLabel: fuelDayLabel
      });
    }
    
    // Format event details
    const eventName = entry.event_name || 'Race Event';
    const eventDateStr = entry.event_date 
      ? new Date(entry.event_date).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      : 'TBA';
    const eventLocation = entry.location || 'TBA';

    // Send updated email with all tickets
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Updated Race Entry - NATS 2026 ROK Cup</title>
        <style>
          body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #333; background: #f5f5f5; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
          .header { background: white; padding: 20px; text-align: center; border-bottom: 3px solid #22c55e; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 700; color: #111827; }
          .content { padding: 30px; }
          .details { background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22c55e; }
          .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
          .detail-row:last-child { border-bottom: none; }
          .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; }
        </style>
      </head>
      <body style="margin: 0; padding: 20px;">
        <div class="container">
          <div class="header">
            <h1>✅ Updated Race Entry</h1>
          </div>
          <div class="content">
            <p>Hi ${driverName},</p>
            <p>Your race entry has been updated with the following details and tickets:</p>
            
            <div class="details">
              <div class="detail-row">
                <span>Entry ID</span>
                <span>${race_entry_id}</span>
              </div>
              <div class="detail-row">
                <span>Event</span>
                <span>${eventName}</span>
              </div>
              <div class="detail-row">
                <span>Date</span>
                <span>${eventDateStr}</span>
              </div>
              <div class="detail-row">
                <span>Location</span>
                <span>${eventLocation}</span>
              </div>
              <div class="detail-row">
                <span>Class</span>
                <span>${entry.race_class}</span>
              </div>
            </div>
            
            ${rentalTicketsHtml}
            
            <p style="margin-top: 20px; color: #6b7280; font-size: 14px;">See you at the track!</p>
          </div>
          <div class="footer">
            <p style="margin: 0;">NATS 2026 ROK Cup - www.rokthenats.co.za</p>
          </div>
        </div>
      </body>
      </html>
    `;
    
    await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
      key: process.env.MAILCHIMP_API_KEY,
      message: {
        to: [{ email: driverEmail, name: driverName }],
        bcc_address: 'africankartingcup@gmail.com',
        from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
        from_name: 'The ROK Cup',
        subject: `Updated Race Entry - ${eventName} (${entry.race_class})`,
        html: emailHtml
      }
    });
    
    console.log(`📧 Updated entry email sent to: ${driverEmail}`);
    
    res.json({ 
      success: true, 
      message: `Entry updated and tickets sent to ${driverEmail}`
    });
    
  } catch (err) {
    console.error('Error updating and resending tickets:', err);
    res.json({ success: false, error: err.message });
  }
});

// Save pool engine rental after payment
app.post('/api/savePoolEngineRental', async (req, res) => {
  try {
    const { driverId, rentalClass, rentalType, amountPaid, paymentReference } = req.body;

    if (!driverId || !rentalClass || !rentalType || !amountPaid) {
      throw new Error('Missing required fields');
    }

    const rentalId = `pool_rental_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const currentYear = new Date().getFullYear();

    await pool.query(
      `INSERT INTO pool_engine_rentals (rental_id, driver_id, championship_class, rental_type, amount_paid, payment_status, payment_reference, season_year, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [rentalId, driverId, rentalClass, rentalType, amountPaid, 'Completed', paymentReference || '', currentYear]
    );

    // Update driver's season_engine_rental flag
    await pool.query(
      `UPDATE drivers SET season_engine_rental = 'Y' WHERE driver_id = $1`,
      [driverId]
    );

    console.log(`✅ Pool engine rental saved: ${rentalId} - ${rentalType} for ${rentalClass}`);
    
    // Send admin notification for engine rental payment
    try {
      const driverInfo = await pool.query('SELECT first_name, last_name FROM drivers WHERE driver_id = $1', [driverId]);
      const driver = driverInfo.rows[0] || {};
      adminNotificationQueue.addNotification({
        action: 'Pool Engine Rental',
        subject: `[Rental] ${driver.first_name} ${driver.last_name} - ${rentalType} (R${parseFloat(amountPaid).toFixed(2)})`,
        details: {
          driverId: driverId,
          driverName: `${driver.first_name} ${driver.last_name}`,
          rentalType: rentalType,
          amount: `R${parseFloat(amountPaid).toFixed(2)}`,
          class: rentalClass,
          season: currentYear,
          paymentReference: paymentReference || 'N/A',
          timestamp: new Date().toLocaleString()
        }
      });
    } catch (e) { /* Silent fail */ }

    res.json({ success: true, data: { rentalId } });
  } catch (err) {
    console.error('❌ savePoolEngineRental error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get driver's pool engine rentals
app.get('/api/getPoolEngineRentals/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;

    if (!driverId) {
      throw new Error('Driver ID required');
    }

    const result = await pool.query(
      `SELECT * FROM pool_engine_rentals WHERE driver_id = $1 ORDER BY created_at DESC`,
      [driverId]
    );

    console.log(`✅ Retrieved ${result.rows.length} pool engine rentals for driver ${driverId}`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('❌ getPoolEngineRentals error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// =========================================================
// ADMIN: Get ALL pool engine rentals (for admin dashboard)
// =========================================================
app.get('/api/admin/getAllPoolEngineRentals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        per.*,
        d.first_name,
        d.last_name,
        c.email,
        c.phone
      FROM pool_engine_rentals per
      LEFT JOIN drivers d ON per.driver_id = d.driver_id
      LEFT JOIN contacts c ON per.driver_id = c.driver_id
      ORDER BY per.created_at DESC
    `);

    console.log(`✅ Admin: Retrieved ${result.rows.length} total pool engine rentals`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('❌ getAllPoolEngineRentals error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get driver's race entries
// Get available events for race entry selection
app.get('/api/getAvailableEvents', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT event_id, event_name, event_date, location, registration_deadline, entry_fee, registration_open, national_only
       FROM events
       WHERE registration_deadline >= CURRENT_DATE
         AND LOWER(event_name) NOT LIKE 'test%'
       ORDER BY event_date ASC`
    );

    console.log(`✅ Retrieved ${result.rows.length} available events`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('❌ getAvailableEvents error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get next upcoming events (by event_date >= today) — used by driver portal next-race box
app.get('/api/getUpcomingEvents', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT event_id, event_name, event_date, start_date, end_date, location, registration_deadline, entry_fee, registration_open
       FROM events
       ORDER BY COALESCE(start_date, event_date) DESC
       LIMIT 30`
    );
    res.json({ success: true, events: result.rows });
  } catch (err) {
    console.error('❌ getUpcomingEvents error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save MSA license number for a driver
app.post('/api/saveMSALicenseNumber', async (req, res) => {
  try {
    const { driver_id, license_number, msa_license_number } = req.body;
    if (!driver_id) return res.status(400).json({ success: false, error: 'driver_id required' });
    const val = (license_number ?? msa_license_number ?? '').toString().trim() || null;
    await pool.query(
      'UPDATE drivers SET license_number = $1, msa_license_number = $1 WHERE driver_id = $2',
      [val, driver_id]
    );
    console.log(`✅ License number updated for driver ${driver_id}: ${val}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ saveMSALicenseNumber error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get driver's race entries with event details
app.get('/api/getDriverEntries/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }

    const result = await pool.query(
      `SELECT r.entry_id, r.event_id, e.event_name, e.event_date, e.location,
              r.payment_status, r.entry_status, r.amount_paid, r.payment_reference,
              r.race_class, r.race_number, r.notes, r.created_at
       FROM race_entries r
       JOIN events e ON r.event_id = e.event_id
       WHERE r.driver_id = $1
       ORDER BY e.event_date DESC`,
      [driverId]
    );

    console.log(`✅ Retrieved ${result.rows.length} race entries for driver ${driverId}`);
    res.json({ success: true, entries: result.rows });
  } catch (err) {
    console.error('❌ getDriverEntries error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Alias for driver events (same as getDriverEntries)
app.get('/api/driver-events/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }

    const result = await pool.query(
      `SELECT r.entry_id, r.event_id, e.event_name, e.event_date, e.location,
              r.payment_status, r.entry_status, r.amount_paid, r.payment_reference,
              r.race_class, r.race_number, r.notes, r.created_at
       FROM race_entries r
       JOIN events e ON r.event_id = e.event_id
       WHERE r.driver_id = $1
       ORDER BY e.event_date DESC`,
      [driverId]
    );

    console.log(`✅ Retrieved ${result.rows.length} race entries for driver ${driverId}`);
    res.json({ success: true, events: result.rows });
  } catch (err) {
    console.error('❌ driver-events error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============= DRIVER POINTS & RESULTS ENDPOINTS =============

// Get driver's points history and standings
app.get('/api/driver-points/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }

    // Get driver's points records grouped by championship_type
    const pointsResult = await pool.query(
      `SELECT points_id, season, event, round, class,
              qualifying_points, heat1_points, heat2_points, final_points,
              penalties_points, total_points, position, notes, created_at,
              COALESCE(championship_type, 'Northern Regions') AS championship_type
       FROM points
       WHERE driver_id = $1
       ORDER BY championship_type, season DESC, round ASC`,
      [driverId]
    );

    // Calculate season totals by class + championship_type
    const seasonTotals = await pool.query(
      `SELECT season, class,
              COALESCE(championship_type, 'Northern Regions') AS championship_type,
              SUM(total_points) as total_points,
              COUNT(*) as races_completed
       FROM points
       WHERE driver_id = $1
       GROUP BY season, class, championship_type
       ORDER BY championship_type, season DESC, class`,
      [driverId]
    );

    // Get driver info for display
    const driverInfo = await pool.query(
      `SELECT first_name, last_name, race_number, class, championship
       FROM drivers
       WHERE driver_id = $1`,
      [driverId]
    );

    console.log(`✅ Retrieved ${pointsResult.rows.length} points records for driver ${driverId}`);
    
    res.json({ 
      success: true, 
      points: pointsResult.rows,
      seasonTotals: seasonTotals.rows,
      driver: driverInfo.rows[0] || {}
    });
  } catch (err) {
    console.error('❌ driver-points error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get championship standings for a specific class/season/championship_type
app.get('/api/championship-standings/:season/:class', async (req, res) => {
  try {
    const { season, class: raceClass } = req.params;
    const champType = req.query.championship_type || 'Northern Regions';

    if (!season || !raceClass) {
      throw new Error('Season and class required');
    }

    // Get standings with driver info (exclude test/admin entries)
    const result = await pool.query(
      `SELECT d.driver_id, d.first_name, d.last_name, d.race_number, d.team_name,
              SUM(p.total_points) as total_points,
              COUNT(p.points_id) as races_completed,
              MIN(p.position::text) as best_position
       FROM points p
       JOIN drivers d ON p.driver_id = d.driver_id
       WHERE p.season = $1 AND p.class = $2
         AND COALESCE(p.championship_type, 'Northern Regions') = $3
         AND (p.notes IS NULL OR p.notes NOT LIKE '%TEST ENTRY%')
       GROUP BY d.driver_id, d.first_name, d.last_name, d.race_number, d.team_name
       ORDER BY total_points DESC, races_completed DESC`,
      [season, raceClass, champType]
    );

    console.log(`✅ Retrieved championship standings: ${season} ${raceClass} - ${result.rows.length} drivers`);
    
    res.json({ 
      success: true, 
      standings: result.rows,
      season,
      class: raceClass
    });
  } catch (err) {
    console.error('❌ championship-standings error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Per-round heat detail for drop-heat scoring on the standings page
app.get('/api/championship-heats/:season/:class', async (req, res) => {
  try {
    const { season, class: raceClass } = req.params;
    const champType = req.query.championship_type || 'Northern Regions';

    if (!season || !raceClass) throw new Error('Season and class required');

    const result = await pool.query(
      `SELECT d.driver_id, d.first_name, d.last_name, d.race_number, d.team_name,
              p.round, p.heat1_points, p.heat2_points, p.final_points, p.total_points, p.position
       FROM points p
       JOIN drivers d ON p.driver_id = d.driver_id
       WHERE p.season = $1 AND p.class = $2
         AND COALESCE(p.championship_type, 'Northern Regions') = $3
         AND (p.notes IS NULL OR p.notes NOT LIKE '%TEST ENTRY%')
       ORDER BY d.last_name, d.first_name, p.round`,
      [season, raceClass, champType]
    );

    console.log(`✅ Retrieved championship heats: ${season} ${raceClass} - ${result.rows.length} rows`);
    res.json({ success: true, rows: result.rows, season, class: raceClass });
  } catch (err) {
    console.error('❌ championship-heats error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get driver's race results with lap times
app.get('/api/driver-results/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }

    // Get race results with event info
    const results = await pool.query(
      `SELECT rr.result_id, rr.event_id, e.event_name, e.event_date,
              rr.session_type, rr.position, rr.best_lap_time, rr.average_lap_time,
              rr.total_laps, rr.gap_to_leader, rr.gap_to_ahead, rr.fastest_lap,
              rr.dnf, rr.dns, rr.dsq, rr.notes
       FROM race_results rr
       JOIN events e ON rr.event_id = e.event_id
       WHERE rr.driver_id = $1
       ORDER BY e.event_date DESC, 
                CASE rr.session_type 
                  WHEN 'qualifying' THEN 1
                  WHEN 'heat1' THEN 2
                  WHEN 'heat2' THEN 3
                  WHEN 'final' THEN 4
                  ELSE 5
                END`,
      [driverId]
    );

    // Get statistics
    const stats = await pool.query(
      `SELECT 
        COUNT(DISTINCT event_id) as events_participated,
        COUNT(CASE WHEN position = 1 THEN 1 END) as wins,
        COUNT(CASE WHEN position <= 3 THEN 1 END) as podiums,
        COUNT(CASE WHEN fastest_lap = true THEN 1 END) as fastest_laps,
        MIN(best_lap_time) as personal_best_lap
       FROM race_results
       WHERE driver_id = $1`,
      [driverId]
    );

    console.log(`✅ Retrieved ${results.rows.length} race results for driver ${driverId}`);
    
    res.json({ 
      success: true, 
      results: results.rows,
      stats: stats.rows[0] || {}
    });
  } catch (err) {
    console.error('❌ driver-results error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============= DRIVER NOTIFICATIONS ENDPOINTS =============

// Get driver's notifications
app.get('/api/notifications/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    const { limit = 50 } = req.query;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }

    const result = await pool.query(
      `SELECT id, driver_id, event_id, event_name, title, body, url, notification_type, sent_at, created_at
       FROM notification_history
       WHERE driver_id = $1 OR driver_id IS NULL
       ORDER BY sent_at DESC
       LIMIT $2`,
      [driverId, parseInt(limit)]
    );

    console.log(`✅ Retrieved ${result.rows.length} notifications for driver ${driverId}`);
    
    res.json({ 
      success: true, 
      notifications: result.rows
    });
  } catch (err) {
    console.error('❌ notifications error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Mark notification as read (future feature - needs read_status column)
app.post('/api/notifications/:notificationId/read', async (req, res) => {
  try {
    const { notificationId } = req.params;
    
    // For now, just return success - will need to add read_status column later
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    console.error('❌ mark-notification-read error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Send notification (admin use)
app.post('/api/notifications/send', async (req, res) => {
  try {
    const { driverId, eventId, eventName, title, body, url, notificationType } = req.body;
    
    if (!title) {
      throw new Error('Title required');
    }

    const result = await pool.query(
      `INSERT INTO notification_history (driver_id, event_id, event_name, title, body, url, notification_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [driverId || null, eventId || null, eventName || null, title, body || null, url || null, notificationType || 'general']
    );

    console.log(`✅ Notification sent: ${title} to ${driverId || 'all drivers'}`);
    
    res.json({ 
      success: true, 
      notification: result.rows[0]
    });
  } catch (err) {
    console.error('❌ send-notification error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============= DRIVER PROFILE MANAGEMENT ENDPOINTS =============

// Upload driver profile photo
app.post('/api/driver-photo-upload', upload.single('photo'), async (req, res) => {
  try {
    const { driverId } = req.body;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }
    
    if (!req.file) {
      throw new Error('No photo uploaded');
    }
    
    // Update driver profile with photo path
    const photoPath = `/uploads/${req.file.filename}`;
    
    await pool.query(
      `UPDATE drivers SET profile_photo = $1, updated_at = CURRENT_TIMESTAMP WHERE driver_id = $2`,
      [photoPath, driverId]
    );
    
    console.log(`✅ Profile photo uploaded for driver ${driverId}: ${photoPath}`);
    
    res.json({ 
      success: true, 
      photoPath: photoPath,
      message: 'Photo uploaded successfully'
    });
  } catch (err) {
    console.error('❌ driver-photo-upload error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Medical consent - Update
app.put('/api/medical-consent', async (req, res) => {
  try {
    const {
      driver_id,
      allergies,
      medical_conditions,
      medication,
      consent_signed,
      consent_date
    } = req.body;

    if (!driver_id) {
      return res.status(400).json({ success: false, error: { message: 'Driver ID is required' } });
    }

    // Check if medical record exists
    const checkResult = await pool.query(
      'SELECT driver_id FROM medical_consent WHERE driver_id = $1',
      [driver_id]
    );

    let result;
    if (checkResult.rows.length > 0) {
      // Update existing record (only editable fields)
      result = await pool.query(
        `UPDATE medical_consent 
         SET allergies = $1, 
             medical_conditions = $2, 
             medication = $3, 
             consent_signed = $4, 
             consent_date = $5
         WHERE driver_id = $6
         RETURNING *`,
        [
          allergies || null,
          medical_conditions || null,
          medication || null,
          consent_signed || null,
          consent_date || null,
          driver_id
        ]
      );
    } else {
      // Insert new record (only editable fields - indemnity and media release stay as NULL)
      result = await pool.query(
        `INSERT INTO medical_consent 
         (driver_id, allergies, medical_conditions, medication, consent_signed, consent_date)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          driver_id,
          allergies || null,
          medical_conditions || null,
          medication || null,
          consent_signed || null,
          consent_date || null
        ]
      );
    }

    console.log(`✅ Medical consent updated for driver ${driver_id}`);
    
    // Send admin notification for medical updates
    try {
      const driverInfo = await pool.query('SELECT first_name, last_name, email FROM drivers d LEFT JOIN contacts c ON d.driver_id = c.driver_id WHERE d.driver_id = $1 LIMIT 1', [driver_id]);
      const driver = driverInfo.rows[0] || {};
      adminNotificationQueue.addNotification({
        action: 'Medical & Consent Update',
        subject: `[Medical] ${driver.first_name} ${driver.last_name} updated medical information`,
        details: {
          driverId: driver_id,
          driverName: `${driver.first_name} ${driver.last_name}`,
          email: driver.email,
          allergies: allergies ? 'Updated' : 'Not provided',
          medicalConditions: medical_conditions ? 'Updated' : 'Not provided',
          medication: medication ? 'Updated' : 'Not provided',
          consentSigned: consent_signed,
          timestamp: new Date().toLocaleString()
        }
      });
    } catch (e) { /* Silent fail on notification */ }
    
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Error updating medical consent:', error);
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// Get driver's emergency contacts
app.get('/api/emergency-contacts/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }

    const result = await pool.query(
      `SELECT contact_id, full_name, email, phone_mobile, phone_work, relationship
       FROM contacts
       WHERE driver_id = $1 AND emergency_contact = 'Y'
       ORDER BY relationship`,
      [driverId]
    );

    console.log(`✅ Retrieved ${result.rows.length} emergency contacts for driver ${driverId}`);
    
    res.json({ 
      success: true, 
      contacts: result.rows
    });
  } catch (err) {
    console.error('❌ emergency-contacts error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Update emergency contact
app.put('/api/emergency-contacts/:contactId', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { fullName, email, phoneMobile, phoneWork } = req.body;
    
    if (!contactId) {
      throw new Error('Contact ID required');
    }

    const result = await pool.query(
      `UPDATE contacts 
       SET full_name = $1, email = $2, phone_mobile = $3, phone_work = $4, updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = $5
       RETURNING *`,
      [fullName, email, phoneMobile, phoneWork, contactId]
    );

    if (result.rows.length === 0) {
      throw new Error('Contact not found');
    }

    console.log(`✅ Updated emergency contact ${contactId}`);
    
    res.json({ 
      success: true, 
      contact: result.rows[0]
    });
  } catch (err) {
    console.error('❌ update-emergency-contact error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============= ADMIN EVENT MANAGEMENT ENDPOINTS =============

// Get all events with registration counts
// Lightweight public endpoint — id/name/date only, no auth required
// Used by operational pages (engine management, clerk, etc.)
app.get('/api/publicEvents', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT event_id, event_name, event_date, location
         FROM events
        ORDER BY event_date DESC`
    );
    res.json({ success: true, events: result.rows });
  } catch (err) {
    console.error('❌ publicEvents error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/getAllEvents', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.event_id, e.event_name, e.event_date, e.start_date, e.end_date, e.location, e.entry_fee, 
              e.registration_deadline, e.registration_open, e.created_at,
              COUNT(*) FILTER (
                WHERE r.entry_status != 'cancelled'
                  AND r.payment_status IN ('Completed','completed','Confirmed','confirmed','paid')
              ) AS registration_count
       FROM events e
       LEFT JOIN race_entries r ON e.event_id = r.event_id
       GROUP BY e.event_id
       ORDER BY e.event_date DESC`
    );

    console.log(`✅ Retrieved ${result.rows.length} events with registration counts`);
    res.json({ success: true, events: result.rows });
  } catch (err) {
    console.error('❌ getAllEvents error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get single event details
app.get('/api/getEvent/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;

    const result = await pool.query(
      `SELECT * FROM events WHERE event_id = $1`,
      [eventId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    console.error('❌ getEvent error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Create new event
app.post('/api/createEvent', async (req, res) => {
  try {
    const { event_name, event_date, start_date, end_date, location, entry_fee, registration_deadline, registration_open, national_only } = req.body;

    if (!event_name || !location || !entry_fee || !registration_deadline) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    // Use start_date as event_date if provided, otherwise use event_date for backwards compatibility
    const mainEventDate = start_date || event_date;
    
    if (!mainEventDate) {
      return res.status(400).json({ success: false, message: 'Event start date is required' });
    }

    const event_id = `event_${Date.now()}`;
    
    // Default registration_open to false if not provided
    const regOpen = registration_open === true || registration_open === 'true' ? true : false;
    const natOnly = national_only === true || national_only === 'true' ? true : false;

    const result = await pool.query(
      `INSERT INTO events (event_id, event_name, event_date, start_date, end_date, location, entry_fee, registration_deadline, registration_open, national_only)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [event_id, event_name, mainEventDate, start_date, end_date, location, entry_fee, registration_deadline, regOpen, natOnly]
    );

    console.log(`✅ Event created: ${event_name} (${start_date && end_date ? `${start_date} to ${end_date}` : mainEventDate})`);
    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    console.error('❌ createEvent error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Update event
app.put('/api/updateEvent/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { event_name, event_date, start_date, end_date, location, entry_fee, registration_deadline, registration_open, national_only } = req.body;
    
    // Use start_date as event_date if provided, otherwise use event_date for backwards compatibility
    const mainEventDate = start_date || event_date;
    
    // Convert registration_open/national_only to booleans
    const regOpen = registration_open === true || registration_open === 'true' ? true : false;
    const natOnly = national_only === true || national_only === 'true' ? true : false;

    const result = await pool.query(
      `UPDATE events 
       SET event_name = $1, event_date = $2, start_date = $3, end_date = $4, location = $5, entry_fee = $6, registration_deadline = $7, registration_open = $8, national_only = $9, updated_at = NOW()
       WHERE event_id = $10
       RETURNING *`,
      [event_name, mainEventDate, start_date, end_date, location, entry_fee, registration_deadline, regOpen, natOnly, eventId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    console.log(`✅ Event updated: ${event_name}`);
    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    console.error('❌ updateEvent error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete event
app.delete('/api/deleteEvent/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;

    // Check if event has registrations
    const checkResult = await pool.query(
      `SELECT COUNT(*) as count FROM race_entries WHERE event_id = $1`,
      [eventId]
    );

    if (checkResult.rows[0].count > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete event with ${checkResult.rows[0].count} registrations` 
      });
    }

    const result = await pool.query(
      `DELETE FROM events WHERE event_id = $1 RETURNING *`,
      [eventId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    console.log(`✅ Event deleted: ${eventId}`);
    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (err) {
    console.error('❌ deleteEvent error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get event class pricing config (public — used by driver portal)
app.get('/api/getEventPricing/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const result = await pool.query(
      `SELECT class_name, config_json FROM event_class_pricing WHERE event_id = $1`,
      [eventId]
    );
    const pricing = {};
    result.rows.forEach(r => { pricing[r.class_name] = r.config_json; });
    res.json({ success: true, pricing });
  } catch (err) {
    console.error('❌ getEventPricing error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Save event class pricing config (admin only — protected via ADMIN_ONLY_PATHS)
app.post('/api/saveEventPricing', async (req, res) => {
  try {
    const { eventId, className, config } = req.body;
    if (!eventId || !className || !config) {
      return res.status(400).json({ success: false, error: 'Missing eventId, className or config' });
    }
    await pool.query(
      `INSERT INTO event_class_pricing (event_id, class_name, config_json, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (event_id, class_name)
       DO UPDATE SET config_json = $3, updated_at = NOW()`,
      [eventId, className, JSON.stringify(config)]
    );
    console.log(`✅ Event pricing saved: event=${eventId} class=${className}`);
    res.json({ success: true, message: 'Pricing saved' });
  } catch (err) {
    console.error('❌ saveEventPricing error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get event registrations with driver details
app.get('/api/getEventRegistrations/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;

    const eventResult = await pool.query(
      `SELECT * FROM events WHERE event_id = $1`,
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    const registrationsResult = await pool.query(
      `SELECT r.entry_id, r.event_id, r.driver_id, r.payment_status, r.entry_status, 
              r.amount_paid, r.created_at,
              d.first_name AS driver_first_name, d.last_name AS driver_last_name, 
              c.email AS driver_email, d.class AS driver_class
       FROM race_entries r
       JOIN drivers d ON r.driver_id = d.driver_id
       LEFT JOIN contacts c ON d.driver_id = c.driver_id AND c.email IS NOT NULL
       WHERE r.event_id = $1
       ORDER BY r.created_at DESC`,
      [eventId]
    );

    console.log(`✅ Retrieved ${registrationsResult.rows.length} registrations for event ${eventId}`);
    res.json({ 
      success: true, 
      event: eventResult.rows[0],
      registrations: registrationsResult.rows 
    });
  } catch (err) {
    console.error('❌ getEventRegistrations error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============= END ADMIN EVENT ENDPOINTS =============


app.post('/api/getDriverRaceEntries', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      throw new Error('Email required');
    }

    const result = await pool.query(
      `SELECT race_id, race_class, payment_status, total_amount, entry_items, entry_date
       FROM race_entries 
       WHERE driver_email = $1
       ORDER BY entry_date DESC`,
      [email.toLowerCase()]
    );

    console.log(`✅ Retrieved ${result.rows.length} race entries for ${email}`);
    res.json({ success: true, entries: result.rows });
  } catch (err) {
    console.error('❌ getDriverRaceEntries error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET alias for race-entries (used by push-notification class loader)
app.get('/api/race-entries', async (req, res) => {
  try {
    const eventId = req.query.event_id;
    if (!eventId) return res.json({ entries: [] });
    const result = await pool.query(
      `SELECT r.entry_id, r.race_class AS class, r.entry_status,
              d.first_name, d.last_name, d.race_number
         FROM race_entries r
         LEFT JOIN drivers d ON r.driver_id = d.driver_id
         WHERE r.event_id = $1
         ORDER BY r.race_class, d.race_number`,
      [eventId]
    );
    res.json({ success: true, entries: result.rows });
  } catch (err) {
    console.error('GET /api/race-entries error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Race Entries
app.post('/api/getRaceEntries', async (req, res) => {
  try {
    const { eventId } = req.body;

    // If no eventId provided, return ALL entries (for payment status dashboard)
    let result;
    if (!eventId) {
      result = await pool.query(
        `SELECT 
          r.*,
          r.ticket_engine_ref,
          r.ticket_tyres_ref,
          r.ticket_transponder_ref,
          r.ticket_fuel_ref,
          d.first_name AS driver_first_name,
          d.last_name AS driver_last_name,
          COALESCE(NULLIF(r.race_number, ''), d.race_number) AS race_number,
          d.transponder_number,
          c.email AS driver_email,
          c.phone_mobile AS entrant_phone,
          c.phone_alt AS entrant_cell,
          c.full_name AS entrant_name,
          c.relationship AS entrant_relationship,
          e.event_name
         FROM race_entries r
         LEFT JOIN drivers d ON r.driver_id = d.driver_id
         LEFT JOIN contacts c ON r.driver_id = c.driver_id
         LEFT JOIN events e ON r.event_id = e.event_id
         ORDER BY r.created_at DESC`
      );
    } else {
      result = await pool.query(
        `SELECT 
          r.*,
          r.ticket_engine_ref,
          r.ticket_tyres_ref,
          r.ticket_transponder_ref,
          r.ticket_fuel_ref,
          d.first_name AS driver_first_name,
          d.last_name AS driver_last_name,
          COALESCE(NULLIF(r.race_number, ''), d.race_number) AS race_number,
          d.transponder_number,
          c.email AS driver_email,
          c.phone_mobile AS entrant_phone,
          c.phone_alt AS entrant_cell,
          c.full_name AS entrant_name,
          c.relationship AS entrant_relationship
         FROM race_entries r
         LEFT JOIN drivers d ON r.driver_id = d.driver_id
         LEFT JOIN contacts c ON r.driver_id = c.driver_id
         WHERE r.event_id = $1
         ORDER BY r.created_at DESC`,
        [eventId]
      );
    }

    console.log(`📊 getRaceEntries query result - Found ${result.rows.length} entries`);
    if (result.rows.length > 0) {
      console.log('🔍 First entry columns:', Object.keys(result.rows[0]));
      console.log('🔍 First entry data:', JSON.stringify(result.rows[0], null, 2));
    }

    res.json({
      success: true,
      data: { entries: result.rows }
    });
  } catch (err) {
    console.error('❌ getRaceEntries error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get all race entries (without event filter)
app.get('/api/allRaceEntries', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        r.*,
        r.ticket_engine_ref,
        r.ticket_tyres_ref,
        r.ticket_transponder_ref,
        r.ticket_fuel_ref,
        d.first_name AS driver_first_name,
        d.last_name AS driver_last_name,
        d.race_number,
        d.transponder_number,
        c.email AS driver_email,
        c.phone_mobile AS entrant_phone,
        c.phone_alt AS entrant_cell,
        c.full_name AS entrant_name,
        c.relationship AS entrant_relationship,
        e.event_name,
        e.event_date,
        e.national_only AS event_national_only
       FROM race_entries r
       LEFT JOIN drivers d ON r.driver_id = d.driver_id
       LEFT JOIN contacts c ON r.driver_id = c.driver_id
       LEFT JOIN events e ON r.event_id = e.event_id
       ORDER BY r.created_at DESC`
    );

    console.log(`📊 allRaceEntries query result - Found ${result.rows.length} entries`);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ allRaceEntries error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Confirm Race Entry (Admin)
// Update Race Entry (Admin - Inline Editing)
app.post('/api/updateRaceEntry', async (req, res) => {
  try {
    const { race_entry_id, entry_id, field, value, race_class, race_number, team_code, entry_status, payment_status, amount_paid, performed_by } = req.body;

    // Accept either entry_id or race_entry_id
    const entryId = entry_id || race_entry_id;
    
    if (!entryId) {
      throw new Error('Entry ID is required');
    }

    // Check if this is a multi-field update (from Titan Command) or single field update
    const isMultiFieldUpdate = race_class !== undefined || race_number !== undefined || 
                                team_code !== undefined ||
                                entry_status !== undefined || payment_status !== undefined || 
                                amount_paid !== undefined;

    if (isMultiFieldUpdate) {
      // Multi-field update from Titan Command
      const updates = [];
      const values = [];
      let paramCount = 1;

      if (race_class !== undefined) {
        updates.push(`race_class = $${paramCount++}`);
        values.push(race_class);
      }
      if (race_number !== undefined) {
        updates.push(`race_number = $${paramCount++}`);
        values.push(race_number);
      }
      if (team_code !== undefined) {
        updates.push(`team_code = $${paramCount++}`);
        values.push(team_code);
      }
      if (entry_status !== undefined) {
        updates.push(`entry_status = $${paramCount++}`);
        values.push(entry_status);
      }
      if (payment_status !== undefined) {
        updates.push(`payment_status = $${paramCount++}`);
        values.push(payment_status);
      }
      if (amount_paid !== undefined) {
        updates.push(`amount_paid = $${paramCount++}`);
        values.push(parseFloat(amount_paid));
      }

      if (updates.length === 0) {
        throw new Error('No fields to update');
      }

      updates.push(`updated_at = NOW()`);
      values.push(entryId);

      // Get old values for audit
      const oldResult = await pool.query(
        `SELECT * FROM race_entries WHERE entry_id = $1`,
        [entryId]
      );

      if (oldResult.rows.length === 0) {
        throw new Error('Race entry not found');
      }

      const oldEntry = oldResult.rows[0];

      // Update the entry
      const updateQuery = `UPDATE race_entries SET ${updates.join(', ')} WHERE entry_id = $${paramCount} RETURNING *`;
      const result = await pool.query(updateQuery, values);

      // Log changes to audit
      const loggedBy = performed_by || 'TITAN';
      const action = loggedBy === 'TITAN' ? 'TITAN_EDIT' : 'RACE_ENTRY_UPDATED';
      
      if (race_class !== undefined && oldEntry.race_class !== race_class) {
        await pool.query(
          `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [oldEntry.driver_id, oldEntry.driver_email || loggedBy, action, 'race_class', String(oldEntry.race_class || ''), String(race_class)]
        );
      }
      if (race_number !== undefined && oldEntry.race_number !== race_number) {
        await pool.query(
          `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [oldEntry.driver_id, oldEntry.driver_email || loggedBy, action, 'race_number', String(oldEntry.race_number || ''), String(race_number)]
        );
      }
      if (entry_status !== undefined && oldEntry.entry_status !== entry_status) {
        await pool.query(
          `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [oldEntry.driver_id, oldEntry.driver_email || loggedBy, action, 'entry_status', String(oldEntry.entry_status || ''), String(entry_status)]
        );
      }
      if (payment_status !== undefined && oldEntry.payment_status !== payment_status) {
        await pool.query(
          `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [oldEntry.driver_id, oldEntry.driver_email || loggedBy, action, 'payment_status', String(oldEntry.payment_status || ''), String(payment_status)]
        );
      }
      if (amount_paid !== undefined && parseFloat(oldEntry.amount_paid || 0) !== parseFloat(amount_paid)) {
        await pool.query(
          `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [oldEntry.driver_id, oldEntry.driver_email || loggedBy, action, 'amount_paid', String(oldEntry.amount_paid || 0), String(amount_paid)]
        );
      }

      console.log(`✅ Race entry updated by ${loggedBy}: ${entryId}`);

      return res.json({
        success: true,
        data: { entry: result.rows[0] }
      });
    }

    // Single field update (original behavior)
    if (!field) {
      throw new Error('Field name is required for single field updates');
    }

    // Whitelist allowed fields to update
    const allowedFields = ['amount_paid', 'payment_status', 'entry_status', 'team_code', 'transponder_number', 'engine'];
    if (!allowedFields.includes(field)) {
      throw new Error(`Field '${field}' cannot be updated`);
    }

    // Type coercion for specific fields
    let updateValue = value;
    if (field === 'engine') {
      updateValue = value === true || value === '1' || value === 1 ? 1 : 0;
    } else if (field === 'amount_paid') {
      updateValue = parseFloat(value);
    }

    // Get the old value for audit
    const oldResult = await pool.query(
      `SELECT ${field}, driver_email, driver_id FROM race_entries WHERE entry_id = $1`,
      [entryId]
    );

    if (oldResult.rows.length === 0) {
      throw new Error('Race entry not found');
    }

    const oldValue = oldResult.rows[0][field];
    const driverEmail = oldResult.rows[0].driver_email;
    const driverId = oldResult.rows[0].driver_id;

    // Update the field
    const updateQuery = `UPDATE race_entries SET ${field} = $1, updated_at = NOW() WHERE entry_id = $2 RETURNING *`;
    const result = await pool.query(updateQuery, [updateValue, entryId]);

    if (result.rows.length === 0) {
      throw new Error('Failed to update race entry');
    }

    // Log to audit table
    await pool.query(
      `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [driverId, driverEmail, 'RACE_ENTRY_UPDATED', field, String(oldValue), String(updateValue)]
    );

    console.log(`✅ Race entry updated: ${entryId} - ${field} = ${updateValue}`);

    res.json({
      success: true,
      data: { entry: result.rows[0] }
    });
  } catch (err) {
    console.error('❌ updateRaceEntry error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Unregister Race Entry (Admin - Soft Cancel)
app.post('/api/deleteRaceEntry', async (req, res) => {
  try {
    const { entry_id } = req.body;

    if (!entry_id) {
      throw new Error('Entry ID is required');
    }

    // Get entry details
    const entryResult = await pool.query(
      `SELECT r.driver_id, r.event_id, c.email
       FROM race_entries r
       LEFT JOIN contacts c ON r.driver_id = c.driver_id
       WHERE r.entry_id = $1`,
      [entry_id]
    );

    if (entryResult.rows.length === 0) {
      throw new Error('Entry not found');
    }

    const entry = entryResult.rows[0];

    // Cancel the entry instead of deleting (soft cancel)
    await pool.query(
      `UPDATE race_entries SET entry_status = 'cancelled' WHERE entry_id = $1`,
      [entry_id]
    );

    // Check if driver has any OTHER active entries for this event
    const activeEntriesResult = await pool.query(
      `SELECT COUNT(*) as count FROM race_entries 
       WHERE driver_id = $1 AND event_id = $2 AND entry_status IN ('confirmed', 'pending')`,
      [entry.driver_id, entry.event_id]
    );

    const hasActiveEntries = activeEntriesResult.rows[0]?.count > 0;

    // If no more active entries for this event, update driver status
    if (!hasActiveEntries) {
      await pool.query(
        `UPDATE drivers 
         SET next_race_entry_status = 'Not Registered',
             next_race_engine_rental_status = 'No'
         WHERE driver_id = $1`,
        [entry.driver_id]
      );
      console.log(`✅ Updated driver ${entry.driver_id} - no active race entries remaining`);
    }

    // Log the cancellation
    await logAuditEvent(
      entry.driver_id,
      entry.email || 'unknown',
      'RACE_ENTRY_CANCELLED',
      'entry_id',
      entry_id,
      'cancelled',
      'admin-portal'
    );

    console.log(`✅ Race entry cancelled: ${entry_id} for ${entry.email || entry.driver_id}`);

    res.json({ success: true, message: 'Race entry cancelled successfully' });
  } catch (err) {
    console.error('❌ deleteRaceEntry error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Save up to 3 custom driver barcodes for a race entry
app.patch('/api/admin/entries/:entryId/barcodes', requireAdmin, async (req, res) => {
  try {
    const { entryId } = req.params;
    const { barcode_1, barcode_2, barcode_3 } = req.body;
    const b1 = barcode_1 ? barcode_1.trim().toUpperCase() : null;
    const b2 = barcode_2 ? barcode_2.trim().toUpperCase() : null;
    const b3 = barcode_3 ? barcode_3.trim().toUpperCase() : null;

    // Check for duplicates across other entries
    if (b1 || b2 || b3) {
      const vals = [b1, b2, b3].filter(Boolean);
      const dupeCheck = await pool.query(`
        SELECT entry_id, driver_barcode_1, driver_barcode_2, driver_barcode_3
        FROM race_entries
        WHERE entry_id != $1
          AND (UPPER(driver_barcode_1) = ANY($2) OR UPPER(driver_barcode_2) = ANY($2) OR UPPER(driver_barcode_3) = ANY($2))
      `, [entryId, vals]);
      if (dupeCheck.rows.length > 0) {
        return res.json({ success: false, error: 'One or more barcodes are already assigned to another entry' });
      }
    }

    await pool.query(`
      UPDATE race_entries
      SET driver_barcode_1 = $1, driver_barcode_2 = $2, driver_barcode_3 = $3, updated_at = NOW()
      WHERE entry_id = $4
    `, [b1, b2, b3, entryId]);

    res.json({ success: true });
  } catch (err) {
    console.error('❌ save barcodes error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// Validate discount code
app.post('/api/validateDiscountCode', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.json({ success: false, valid: false, message: 'Code is required' });
    }

    const result = await pool.query(
      `SELECT * FROM discount_codes 
       WHERE code = $1 AND is_active = true
       AND (valid_from IS NULL OR valid_from <= NOW())
       AND (valid_until IS NULL OR valid_until >= NOW())
       AND (usage_limit IS NULL OR usage_count < usage_limit)`,
      [code.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.json({ success: false, valid: false, message: 'Invalid or expired code' });
    }

    const discountCode = result.rows[0];
    res.json({ 
      success: true, 
      valid: true,
      code: discountCode
    });
  } catch (err) {
    console.error('❌ validateDiscountCode error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Get all discount codes (admin only)
app.get('/api/getDiscountCodes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM discount_codes ORDER BY created_at DESC'
    );
    res.json({ success: true, codes: result.rows });
  } catch (err) {
    console.error('❌ getDiscountCodes error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Create discount code (admin only)
app.post('/api/createDiscountCode', async (req, res) => {
  try {
    const { code, description, discount_type, discount_value, usage_limit, valid_from, valid_until, created_by } = req.body;

    if (!code || !discount_type || discount_value === undefined) {
      return res.status(400).json({ success: false, error: { message: 'Missing required fields' } });
    }

    const code_id = `discount_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    await pool.query(
      `INSERT INTO discount_codes (code_id, code, description, discount_type, discount_value, usage_limit, valid_from, valid_until, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
      [code_id, code.toUpperCase(), description, discount_type, discount_value, usage_limit || null, valid_from || null, valid_until || null, created_by || 'admin']
    );

    console.log(`✅ Discount code created: ${code.toUpperCase()} (${discount_type}: ${discount_value})`);
    res.json({ success: true, message: 'Discount code created successfully' });
  } catch (err) {
    console.error('❌ createDiscountCode error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Update discount code (admin only)
app.post('/api/updateDiscountCode', async (req, res) => {
  try {
    const { code_id, code, description, discount_type, discount_value, usage_limit, valid_from, valid_until, is_active } = req.body;

    if (!code_id) {
      return res.status(400).json({ success: false, error: { message: 'Code ID is required' } });
    }

    await pool.query(
      `UPDATE discount_codes 
       SET code = $2, description = $3, discount_type = $4, discount_value = $5, 
           usage_limit = $6, valid_from = $7, valid_until = $8, is_active = $9, updated_at = NOW()
       WHERE code_id = $1`,
      [code_id, code.toUpperCase(), description, discount_type, discount_value, usage_limit || null, valid_from || null, valid_until || null, is_active]
    );

    console.log(`✅ Discount code updated: ${code.toUpperCase()}`);
    res.json({ success: true, message: 'Discount code updated successfully' });
  } catch (err) {
    console.error('❌ updateDiscountCode error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Delete discount code (admin only)
app.post('/api/deleteDiscountCode', async (req, res) => {
  try {
    const { code_id } = req.body;

    if (!code_id) {
      return res.status(400).json({ success: false, error: { message: 'Code ID is required' } });
    }

    await pool.query('DELETE FROM discount_codes WHERE code_id = $1', [code_id]);

    console.log(`✅ Discount code deleted: ${code_id}`);
    res.json({ success: true, message: 'Discount code deleted successfully' });
  } catch (err) {
    console.error('❌ deleteDiscountCode error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Increment usage count when code is used
app.post('/api/useDiscountCode', async (req, res) => {
  try {
    const { code } = req.body;

    await pool.query(
      'UPDATE discount_codes SET usage_count = usage_count + 1 WHERE code = $1',
      [code.toUpperCase()]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('❌ useDiscountCode error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

app.post('/api/confirmRaceEntry', async (req, res) => {
  try {
    const { race_entry_id, entry_id } = req.body;
    const entryId = race_entry_id || entry_id;

    if (!entryId) {
      throw new Error('Race entry ID is required');
    }

    // Get entry details for audit log
    const entryCheckResult = await pool.query(
      `SELECT driver_id, payment_status FROM race_entries WHERE entry_id = $1`,
      [entryId]
    );

    if (entryCheckResult.rows.length === 0) {
      throw new Error('Race entry not found');
    }

    const entryData = entryCheckResult.rows[0];
    const oldStatus = entryData.payment_status;

    const result = await pool.query(
      `UPDATE race_entries SET payment_status = 'Confirmed', entry_status = 'confirmed', updated_at = NOW() WHERE entry_id = $1 RETURNING *`,
      [entryId]
    );

    // Update driver's next_race_entry_status so the portal shows them as registered
    await pool.query(
      `UPDATE drivers SET next_race_entry_status = 'Registered',
        next_race_engine_rental_status = CASE
          WHEN (SELECT engine FROM race_entries WHERE entry_id = $1) = 1 THEN 'Yes'
          ELSE next_race_engine_rental_status
        END
       WHERE driver_id = $2`,
      [entryId, entryData.driver_id]
    );

    // Get driver email for audit log
    const contactResult = await pool.query(
      'SELECT email FROM contacts WHERE driver_id = $1 LIMIT 1',
      [entryData.driver_id]
    );
    const driverEmail = contactResult.rows[0]?.email || 'unknown';

    // Log to audit trail
    await logAuditEvent(entryData.driver_id, driverEmail, 'RACE_ENTRY_CONFIRMED', 'payment_status', oldStatus || 'Pending', 'Confirmed');

    console.log(`✅ Race entry confirmed: ${entryId}`);

    // Create Trello card for confirmed entry
    try {
      console.log('📋 Creating Trello card for confirmed race entry...');
      
      // Get driver and entry details for Trello
      const driverResult = await pool.query(
        `SELECT d.first_name, d.last_name, re.race_class, re.payment_reference, re.team_code
         FROM drivers d
         JOIN race_entries re ON d.driver_id = re.driver_id
         WHERE re.entry_id = $1`,
        [entryId]
      );
      
      if (driverResult.rows.length > 0) {
        const driverData = driverResult.rows[0];
        const driverName = `${driverData.first_name} ${driverData.last_name}`.trim();
        
        await createTrelloCard(
          driverName,
          driverEmail,
          driverData.race_class || 'Unknown',
          driverData.team_code,
          driverData.payment_reference,
          entryData.driver_id
        );
        
        console.log(`✅ Trello card created for confirmed entry: ${driverName}`);
      }
    } catch (trelloErr) {
      console.error('⚠️ Trello card creation failed (non-critical):', trelloErr.message);
    }

    res.json({
      success: true,
      data: { entry: result.rows[0] }
    });
  } catch (err) {
    console.error('❌ confirmRaceEntry error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Mark payment as received (updates payment_status and entry_status)
app.post('/api/markPaymentReceived', async (req, res) => {
  try {
    const { entry_id } = req.body;

    if (!entry_id) {
      throw new Error('Entry ID is required');
    }

    // Get entry details for audit log
    const entryCheckResult = await pool.query(
      `SELECT driver_id, payment_status, entry_status FROM race_entries WHERE entry_id = $1`,
      [entry_id]
    );

    if (entryCheckResult.rows.length === 0) {
      throw new Error('Race entry not found');
    }

    const entryData = entryCheckResult.rows[0];
    const oldPaymentStatus = entryData.payment_status;
    const oldEntryStatus = entryData.entry_status;

    // Update both payment_status and entry_status
    const result = await pool.query(
      `UPDATE race_entries 
       SET payment_status = 'Completed',
           entry_status = 'confirmed',
           updated_at = NOW() 
       WHERE entry_id = $1 
       RETURNING *`,
      [entry_id]
    );

    // Get driver email for audit log
    const contactResult = await pool.query(
      'SELECT email FROM contacts WHERE driver_id = $1 LIMIT 1',
      [entryData.driver_id]
    );
    const driverEmail = contactResult.rows[0]?.email || 'unknown';

    // Log to audit trail
    await logAuditEvent(
      entryData.driver_id, 
      driverEmail, 
      'PAYMENT_MARKED_RECEIVED', 
      'payment_status', 
      `${oldPaymentStatus}/${oldEntryStatus}`, 
      'Completed/confirmed'
    );

    console.log(`✅ Payment marked as received for entry: ${entry_id}`);

    // Create Trello card for manually marked payment
    try {
      console.log('📋 Creating Trello card for manually marked payment...');
      
      // Get driver and entry details for Trello
      const driverResult = await pool.query(
        `SELECT d.first_name, d.last_name, re.race_class, re.payment_reference, re.team_code
         FROM drivers d
         JOIN race_entries re ON d.driver_id = re.driver_id
         WHERE re.entry_id = $1`,
        [entry_id]
      );
      
      if (driverResult.rows.length > 0) {
        const driverData = driverResult.rows[0];
        const driverName = `${driverData.first_name} ${driverData.last_name}`.trim();
        
        await createTrelloCard(
          driverName,
          driverEmail,
          driverData.race_class || 'Unknown',
          driverData.team_code,
          driverData.payment_reference,
          entryData.driver_id
        );
        
        console.log(`✅ Trello card created for manually marked payment: ${driverName}`);
      }
    } catch (trelloErr) {
      console.error('⚠️ Trello card creation failed (non-critical):', trelloErr.message);
    }

    res.json({
      success: true,
      message: 'Payment marked as received and entry confirmed',
      data: { entry: result.rows[0] }
    });
  } catch (err) {
    console.error('❌ markPaymentReceived error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Export Race Entries as CSV (Admin)
app.post('/api/exportRaceEntriesCSV', async (req, res) => {
  try {
    const { race_event } = req.body;

    console.log('📥 Timing sheet export request for event:', race_event);

    if (!race_event) {
      throw new Error('Race event is required');
    }

    // Helper function to escape CSV values
    const escapeCSV = (value) => {
      if (value === null || value === undefined) return '';
      const stringValue = String(value);
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    };

    // Query with JOIN to get driver details
    const result = await pool.query(
      `SELECT 
        r.*,
        d.first_name,
        d.last_name,
        c.email,
        d.transponder_number,
        d.license_number,
        d.kart_brand,
        d.team_name,
        d.nationality,
        d.championship,
        d.race_number as driver_race_number
       FROM race_entries r
       LEFT JOIN drivers d ON r.driver_id = d.driver_id
       LEFT JOIN contacts c ON d.driver_id = c.driver_id
       WHERE r.event_id = $1 AND r.entry_status != 'cancelled'
       ORDER BY r.race_class, r.race_number`,
      [race_event]
    );

    console.log(`📋 Found ${result.rows.length} entries for timing sheet export`);

    const entries = result.rows;

    if (entries.length === 0) {
      res.json({ success: false, error: { message: 'No entries found' } });
      return;
    }

    // Country code mapping (ISO 3166-1 alpha-3)
    const countryCodeMap = {
      'South Africa': 'RSA',
      'Zimbabwe': 'ZWE',
      'Mozambique': 'MOZ',
      'Namibia': 'NAM',
      'Botswana': 'BWA',
      'Zambia': 'ZMB',
      'United Kingdom': 'GBR',
      'USA': 'USA',
      'United States': 'USA',
      'Australia': 'AUS',
      'New Zealand': 'NZL'
    };

    // Build timing sheet CSV with exact format required
    const headers = ['txp short', 'txpLong', 'Class', 'Race#', 'First Name', 'Last Name', 'License#', 'Chassis', 'Engine', 'Tyres', 'Image', 'Team', 'Country', 'Scoring'];
    
    const rows = entries.map(entry => {
      // Determine engine type based on class
      const raceClass = (entry.race_class || '').toUpperCase();
      const isCadet = raceClass.includes('CADET');
      const engine = isCadet ? 'Tillotson' : 'Vortex';
      
      // Determine tyre brand based on class
      const tyres = isCadet ? 'XXXX' : 'Levanto';
      
      // Create image name (firstname + lastname, no spaces)
      const firstName = entry.first_name || '';
      const lastName = entry.last_name || '';
      const imageName = (firstName + lastName).replace(/\s+/g, '');
      
      // Get country code (default to RSA if not found)
      const countryCode = countryCodeMap[entry.nationality] || 'RSA';
      
      // Determine scoring category based on championship field
      let scoring = '';
      if (entry.championship) {
        const champ = entry.championship.toUpperCase();
        if (champ.includes('NATIONAL') && champ.includes('REGIONAL')) {
          scoring = 'Nat + Reg';
        } else if (champ.includes('NATIONAL')) {
          scoring = 'Nat only';
        } else if (champ.includes('REGIONAL')) {
          scoring = 'Reg only';
        } else {
          scoring = 'Nat only'; // Default
        }
      } else {
        scoring = 'Nat only'; // Default if no championship specified
      }
      
      return [
        '', // txp short - leave blank as requested
        escapeCSV(entry.transponder_number || ''),
        escapeCSV(entry.race_class || ''),
        escapeCSV(entry.race_number || entry.driver_race_number || ''),
        escapeCSV(firstName),
        escapeCSV(lastName),
        escapeCSV(entry.email || ''),
        escapeCSV(entry.license_number || ''),
        escapeCSV(entry.kart_brand || ''),
        escapeCSV(engine),
        escapeCSV(tyres),
        escapeCSV(imageName),
        escapeCSV(entry.team_name || ''),
        countryCode,
        escapeCSV(scoring)
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="timing-sheet-${race_event.replace(/[\/\s]/g, '-')}-${new Date().toISOString().split('T')[0]}.csv"`);

    console.log(`✅ Timing sheet CSV export ready: ${entries.length} entries`);

    res.send(csv);
  } catch (err) {
    console.error('❌ exportRaceEntriesCSV error:', err.message);
    console.error('❌ Stack trace:', err.stack);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// =============================================
// Financial Report CSV — admin race takings summary
// =============================================
app.post('/api/exportFinancialReportCSV', async (req, res) => {
  try {
    const { race_event } = req.body;
    if (!race_event) return res.status(400).json({ success: false, error: { message: 'race_event is required' } });

    // Get all active entries with driver info
    const entriesResult = await pool.query(
      `SELECT
         r.entry_id,
         r.race_class,
         r.entry_items,
         r.amount_paid,
         r.payment_status,
         r.entry_status,
         r.engine,
         r.race_days,
         e.start_date,
         e.end_date,
         e.event_date,
         r.ticket_engine_ref,
         r.ticket_tyres_ref,
         r.ticket_transponder_ref,
         r.ticket_fuel_ref,
         d.first_name,
         d.last_name,
         d.race_number,
         d.championship,
         c.email AS driver_email
       FROM race_entries r
       LEFT JOIN drivers d ON r.driver_id = d.driver_id
       LEFT JOIN contacts c ON r.driver_id = c.driver_id
       LEFT JOIN events e ON e.event_id = r.event_id
       WHERE r.event_id = $1
         AND (r.entry_status IS NULL OR r.entry_status != 'cancelled')
         AND r.race_class IS NOT NULL
       ORDER BY r.race_class, d.last_name`,
      [race_event]
    );

    // Get event name
    const eventResult = await pool.query(`SELECT event_name FROM events WHERE event_id = $1`, [race_event]);
    const eventName = eventResult.rows[0]?.event_name || race_event;

    // Get class pricing configs for this event
    const pricingResult = await pool.query(
      `SELECT class_name, config_json FROM event_class_pricing WHERE event_id = $1`,
      [race_event]
    );
    const normalizeClassKey = value => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
    const pricingMap = {};
    pricingResult.rows.forEach(row => {
      if (!row.class_name) return;
      pricingMap[normalizeClassKey(row.class_name)] = row.config_json;
    });
    const isBothDaysValue = value => {
      const s = String(value || '').trim().toLowerCase();
      return !s ? false : /(both|two day|2 day|weekend|sat.*sun|saturday.*sunday)/.test(s);
    };

    const escCSV = v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const fmt = n => parseFloat(n || 0).toFixed(2);

    const headers = [
      'Name', 'Race #', 'Class', 'Payment Status',
      'Entry Fee (R)', 'Engine Rental (R)', 'Tyre Set (R)', 'Wet Tyres (R)',
      'Practice Tyres (R)', 'Transponder (R)', 'Fuel (R)', 'Calculated Total (R)',
      'Amount Paid (R)', 'Difference (R)', 'Notes'
    ];

    // Running totals
    let grandCalc = 0, grandPaid = 0;
    const colTotals = { entry: 0, engine: 0, tyres: 0, wet: 0, trans: 0, fuel: 0 };

    const rows = entriesResult.rows.map(entry => {
      const items = (() => {
        try {
          const raw = entry.entry_items;
          if (!raw) return [];
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          return Array.isArray(parsed) ? parsed.map(i => (typeof i === 'string' ? i : (i.name || '')).toLowerCase()) : [];
        } catch { return []; }
      })();

      const qtyFromItem = (itemText) => {
        const str = String(itemText || '');
        const match = str.match(/(?:x|×)\s*(\d+)/i) || str.match(/(\d+)\s*set/i);
        return match ? parseInt(match[1], 10) || 1 : 1;
      };

      const cfg = pricingMap[normalizeClassKey(entry.race_class)] || pricingMap[normalizeClassKey(entry.race_class || '')] || null;
      const hasDateRangeBothDays = !!(entry.start_date && entry.end_date && new Date(entry.end_date) > new Date(entry.start_date));
      const hasBothDays = isBothDaysValue(entry.race_days) || hasDateRangeBothDays;
      const practiceQty = items.reduce((sum, item) => item.includes('practice') ? sum + qtyFromItem(item) : sum, 0);
      const tyreQty = items.reduce((sum, item) => (item.includes('tyre') && !item.includes('wet') && !item.includes('practice')) ? sum + qtyFromItem(item) : sum, 0);

      // Determine if items were selected
      const hasEngine = (entry.engine === 1 || entry.engine === '1') || items.some(i => i.includes('engine'));
      const hasTyres  = tyreQty > 0 || items.some(i => i.includes('tyre') && !i.includes('wet'));
      const hasWet    = items.some(i => i.includes('wet'));
      const hasTrans  = items.some(i => i.includes('transponder'));
      const hasFuel   = items.some(i => i.includes('fuel'));

      // Prices from config, with both-day discounted package applied where applicable
      const pEntry  = cfg ? parseFloat(hasBothDays ? (cfg.natPB || cfg.regPB || cfg.natP1 || cfg.regP1 || 0) : (cfg.natP1 || cfg.regP1 || 0)) : 0;
      const pEngine = cfg && hasEngine  ? parseFloat(hasBothDays ? (cfg.engPB || cfg.engP1 || 0) : (cfg.engP1 || 0)) : 0;
      const pTyres  = cfg && hasTyres   ? parseFloat(hasBothDays ? (cfg.tyrPB || cfg.tyrP1 || 0) : (cfg.tyrP1 || 0)) * (Math.max(1, tyreQty || 1)) : 0;
      const pWet    = cfg && hasWet     ? parseFloat(cfg.wetPrice || 0) : 0;
      const pTrans  = cfg && hasTrans   ? parseFloat(cfg.transP1 || 0) : 0;
      const pFuel   = cfg && hasFuel    ? parseFloat(hasBothDays ? (cfg.fuelPB || cfg.fuelP1 || 0) : (cfg.fuelP1 || 0)) : 0;
      const pPractice = cfg && practiceQty > 0 ? parseFloat(cfg.pracUnit || 0) * practiceQty : 0;

      const calcTotal = pEntry + pEngine + pTyres + pWet + pTrans + pFuel + pPractice;
      const amtPaid   = parseFloat(entry.amount_paid || 0);
      const diff      = amtPaid - calcTotal;

      colTotals.entry  += pEntry;
      colTotals.engine += pEngine;
      colTotals.tyres  += pTyres;
      colTotals.wet    += pWet;
      colTotals.trans  += pTrans;
      colTotals.fuel   += pFuel;
      grandCalc += calcTotal;
      grandPaid += amtPaid;

      const notes = [];
      if (!cfg) notes.push('No pricing config for this class');
      if (amtPaid === 0 && entry.payment_status === 'Completed') notes.push('FREE ENTRY');
      if (diff < -0.5) notes.push(`SHORT R${Math.abs(diff).toFixed(2)}`);
      if (diff > 0.5)  notes.push(`OVER R${diff.toFixed(2)}`);

      const name = `${entry.first_name || ''} ${entry.last_name || ''}`.trim() || entry.driver_email || 'Unknown';

      return [
        escCSV(name),
        escCSV(entry.race_number || '?'),
        escCSV(entry.race_class),
        escCSV(entry.payment_status || 'Unknown'),
        fmt(pEntry),
        fmt(hasEngine ? pEngine : 0),
        fmt(hasTyres  ? pTyres  : 0),
        fmt(hasWet    ? pWet    : 0),
        fmt(pPractice),
        fmt(hasTrans  ? pTrans  : 0),
        fmt(hasFuel   ? pFuel   : 0),
        fmt(calcTotal),
        fmt(amtPaid),
        fmt(diff),
        escCSV(notes.join('; '))
      ].join(',');
    });

    // Totals row
    const totalsRow = [
      'TOTALS', '', '', '',
      fmt(colTotals.entry),
      fmt(colTotals.engine),
      fmt(colTotals.tyres),
      fmt(colTotals.wet),
      fmt(0),
      fmt(colTotals.trans),
      fmt(colTotals.fuel),
      fmt(grandCalc),
      fmt(grandPaid),
      fmt(grandPaid - grandCalc),
      ''
    ].join(',');

    const eventHeaderRow = `# Financial Report: ${eventName},Generated: ${new Date().toLocaleString('en-ZA')},Entries: ${rows.length}`;
    const csv = [eventHeaderRow, headers.join(','), ...rows, '', totalsRow].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="financial-report-${race_event}-${new Date().toISOString().slice(0,10)}.csv"`);
    console.log(`✅ Financial report exported: ${rows.length} entries, event=${race_event}`);
    res.send(csv);
  } catch (err) {
    console.error('❌ exportFinancialReportCSV error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Export Drivers as CSV (Admin)
app.post('/api/admin/exportDriversCSV', async (req, res) => {
  try {
    const { includeDeleted = false } = req.body;

    console.log('📊 Exporting drivers to CSV...');

    // Get all drivers (excluding soft-deleted unless requested)
    let driversQuery = 'SELECT * FROM drivers';
    if (!includeDeleted) {
      driversQuery += ' WHERE is_deleted = FALSE OR is_deleted IS NULL';
    }
    driversQuery += ' ORDER BY created_at DESC';

    const driversResult = await pool.query(driversQuery);
    const drivers = driversResult.rows;

    if (drivers.length === 0) {
      throw new Error('No drivers to export');
    }

    console.log(`📋 Found ${drivers.length} drivers to export`);

    // Get driver IDs for contact and medical queries
    const driverIds = drivers.map(d => d.driver_id);

    // Get all contacts
    let contactMap = {};
    try {
      const contactResult = await pool.query(
        'SELECT * FROM contacts WHERE driver_id = ANY($1)',
        [driverIds]
      );
      contactResult.rows.forEach(c => {
        if (!contactMap[c.driver_id]) {
          contactMap[c.driver_id] = c;
        }
      });
    } catch (e) {
      console.log('⚠️ Could not fetch contacts:', e.message);
    }

    // Get all medical info
    let medicalMap = {};
    try {
      const medicalResult = await pool.query(
        'SELECT * FROM medical_consent WHERE driver_id = ANY($1)',
        [driverIds]
      );
      medicalResult.rows.forEach(m => {
        medicalMap[m.driver_id] = m;
      });
    } catch (e) {
      console.log('⚠️ Could not fetch medical info:', e.message);
    }

    // Build CSV content
    const headers = [
      'Driver ID',
      'First Name',
      'Last Name',
      'Email',
      'Phone',
      'Contact Name',
      'Contact Phone',
      'Contact Relationship',
      'Championship',
      'Class',
      'Race Number',
      'Team Name',
      'Coach Name',
      'Kart Brand',
      'Engine Type',
      'Transponder Number',
      'License Number',
      'Status',
      'Medical Allergies',
      'Medical Conditions',
      'Medical Medication',
      'Doctor Phone',
      'Consent Signed',
      'Media Release Signed',
      'Date of Birth',
      'Gender',
      'Nationality',
      'Registration Date',
      'Is Deleted',
      'Deleted Date'
    ];

    // Helper function to escape CSV values
    const escapeCSV = (value) => {
      if (value === null || value === undefined) return '';
      const stringValue = String(value);
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    };

    // Build CSV rows
    const rows = drivers.map(driver => {
      const contact = contactMap[driver.driver_id] || {};
      const medical = medicalMap[driver.driver_id] || {};

      return [
        escapeCSV(driver.driver_id),
        escapeCSV(driver.first_name),
        escapeCSV(driver.last_name),
        escapeCSV(contact.email),
        escapeCSV(contact.phone_mobile),
        escapeCSV(contact.full_name),
        escapeCSV(contact.phone_mobile),
        escapeCSV(contact.relationship),
        escapeCSV(driver.championship),
        escapeCSV(driver.class),
        escapeCSV(driver.race_number),
        escapeCSV(driver.team_name),
        escapeCSV(driver.coach_name),
        escapeCSV(driver.kart_brand),
        escapeCSV(driver.engine_type),
        escapeCSV(driver.transponder_number),
        escapeCSV(driver.license_number),
        escapeCSV(driver.status),
        escapeCSV(medical.allergies),
        escapeCSV(medical.medical_conditions),
        escapeCSV(medical.medication),
        escapeCSV(medical.doctor_phone),
        escapeCSV(medical.consent_signed ? 'Yes' : 'No'),
        escapeCSV(medical.media_release_signed ? 'Yes' : 'No'),
        escapeCSV(driver.date_of_birth),
        escapeCSV(driver.gender),
        escapeCSV(driver.nationality),
        escapeCSV(driver.created_at),
        escapeCSV(driver.is_deleted ? 'Yes' : 'No'),
        escapeCSV(driver.deleted_at)
      ].join(',');
    });

    // Combine headers and rows
    const csv = [headers.join(','), ...rows].join('\n');

    // Set response headers for file download
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="drivers-export-${new Date().toISOString().split('T')[0]}.csv"`);

    console.log(`✅ CSV export ready: ${drivers.length} drivers`);

    res.send(csv);
  } catch (err) {
    console.error('❌ exportDriversCSV error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// ============================================
// ROKControl Scanner CSV Export
// GET /api/admin/exportROKControlCSV?eventId=X
// Returns: race_number,FullName,race_class  (one driver per line)
// ============================================
app.get('/api/admin/exportROKControlCSV', requireAdmin, async (req, res) => {
  try {
    const { eventId } = req.query;
    let rows;
    if (eventId) {
      const result = await pool.query(
        `SELECT d.race_number, d.first_name, d.last_name, re.race_class
           FROM race_entries re
           JOIN drivers d ON re.driver_id = d.driver_id
          WHERE re.event_id = $1
            AND re.status NOT IN ('cancelled','incomplete')
          ORDER BY re.race_class, d.race_number`,
        [eventId]
      );
      rows = result.rows;
    } else {
      const result = await pool.query(
        `SELECT d.race_number, d.first_name, d.last_name, re.race_class
           FROM race_entries re
           JOIN drivers d ON re.driver_id = d.driver_id
          WHERE re.status NOT IN ('cancelled','incomplete')
          ORDER BY re.race_class, d.race_number`
      );
      rows = result.rows;
    }

    const lines = rows.map(r => {
      const num   = (r.race_number  || '').toString().replace(/,/g, '');
      const name  = `${r.first_name || ''} ${r.last_name || ''}`.trim().replace(/,/g, ' ');
      const cls   = (r.race_class   || '').replace(/,/g, ' ');
      return `${num},${name},${cls}`;
    });

    const csv = lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="drivers.csv"');
    res.send(csv);
  } catch (err) {
    console.error('exportROKControlCSV error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ROKControl Scanner - Sync endpoint
// POST /api/rokcontrol/sync
// Body: {
//   records: [{ts, vehicle, driver, class, control, heat,
//              items:[...11 strings...],
//              tyreFL, tyreFR, tyreRL, tyreRR}],
//   controlPoint: N,
//   controlPointName: "...",
//   eventName: "..."
// }
// ============================================
app.post('/api/rokcontrol/sync', requireAdmin, async (req, res) => {
  try {
    const { records, controlPoint, controlPointName, eventName } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
      return res.json({ inserted: 0 });
    }

    let inserted = 0;
    const errors = [];

    for (const rec of records) {
      const vehicle = (rec.vehicle || '').trim();
      const driver  = (rec.driver  || '').trim();
      const cls     = (rec.class   || '').trim();
      const heat    = (rec.heat    || '').trim();
      const control = (rec.control || '').trim();
      const items   = Array.isArray(rec.items) ? rec.items : [];
      const tyreFL  = (rec.tyreFL  || '').trim();
      const tyreFR  = (rec.tyreFR  || '').trim();
      const tyreRL  = (rec.tyreRL  || '').trim();
      const tyreRR  = (rec.tyreRR  || '').trim();

      const scannedBy = `ROKControl CP${controlPoint || 0} ${controlPointName || ''}`.trim();
      const baseNotes = `Vehicle:${vehicle} Heat:${heat} Event:${eventName || ''}`.trim();

      // Try to find the entry by race_number so we can set entry_id
      let entryId = null;
      if (vehicle) {
        try {
          const entryRes = await pool.query(
            `SELECT re.entry_id FROM race_entries re
               JOIN drivers d ON re.driver_id = d.driver_id
              WHERE d.race_number = $1
                AND re.status NOT IN ('cancelled', 'incomplete')
              ORDER BY re.entry_id DESC LIMIT 1`,
            [vehicle]
          );
          if (entryRes.rows.length) entryId = entryRes.rows[0].entry_id;
        } catch (_) {}
      }

      // Log each non-empty scanned item (slots 1-11)
      for (let i = 0; i < items.length; i++) {
        const code = (items[i] || '').trim();
        if (!code) continue;
        try {
          await logEquipmentScan({
            scan_type:        'CONTROL_SCAN',
            barcode_scanned:  code,
            entry_id:         entryId,
            driver_name:      driver,
            equipment_serial: code,
            scanned_by:       scannedBy,
            action_result:    'success',
            notes:            `${baseNotes} Slot:${i + 1}`,
            race_class:       cls
          });
          inserted++;
        } catch (e) { errors.push(e.message); }
      }

      // Log tyre RFID scans by position
      const tyrePositions = [
        { type: 'TYRE_FL', code: tyreFL },
        { type: 'TYRE_FR', code: tyreFR },
        { type: 'TYRE_RL', code: tyreRL },
        { type: 'TYRE_RR', code: tyreRR }
      ];
      for (const tyre of tyrePositions) {
        if (!tyre.code) continue;
        try {
          await logEquipmentScan({
            scan_type:        tyre.type,
            barcode_scanned:  tyre.code,
            entry_id:         entryId,
            driver_name:      driver,
            equipment_serial: tyre.code,
            scanned_by:       scannedBy,
            action_result:    'success',
            notes:            baseNotes,
            race_class:       cls
          });
          inserted++;
        } catch (e) { errors.push(e.message); }
      }

      // Update race_entries tyre columns if we matched an entry
      if (entryId) {
        const updates = [];
        const vals    = [];
        let   p       = 1;
        if (tyreFL) { updates.push(`tyre_front_left  = $${p++}`); vals.push(tyreFL); }
        if (tyreFR) { updates.push(`tyre_front_right = $${p++}`); vals.push(tyreFR); }
        if (tyreRL) { updates.push(`tyre_rear_left   = $${p++}`); vals.push(tyreRL); }
        if (tyreRR) { updates.push(`tyre_rear_right  = $${p++}`); vals.push(tyreRR); }
        if (updates.length) {
          vals.push(entryId);
          try {
            await pool.query(
              `UPDATE race_entries SET ${updates.join(', ')} WHERE entry_id = $${p}`,
              vals
            );
          } catch (_) {}
        }
      }
    }

    res.json({ inserted, errors: errors.length ? errors : undefined });
  } catch (err) {
    console.error('rokcontrol sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ROKControl Scanner - Registration endpoint
// POST /api/rokcontrol/register
// Body: { race_number, engine_serial, scanned_by }
// Assigns engine serial to driver and fires engine_assign to monitor SSE
// ============================================
app.post('/api/rokcontrol/register', requireAdmin, async (req, res) => {
  try {
    const { race_number, engine_serial, scanned_by } = req.body;
    if (!race_number || !engine_serial) {
      return res.status(400).json({ success: false, error: 'race_number and engine_serial required' });
    }

    // Look up driver + most recent confirmed entry by race number
    const entryRes = await pool.query(
      `SELECT re.entry_id, re.driver_id, re.race_class, re.event_id,
              d.first_name, d.last_name, d.race_number
         FROM race_entries re
         JOIN drivers d ON re.driver_id = d.driver_id
        WHERE d.race_number = $1
          AND re.entry_status IN ('confirmed', 'paid')
          AND re.payment_status = 'Completed'
        ORDER BY re.entry_id DESC
        LIMIT 1`,
      [race_number]
    );

    const engineUpper = engine_serial.toUpperCase();

    if (!entryRes.rows.length) {
      await logEquipmentScan({
        scan_type:        'engine_assign',
        barcode_scanned:  race_number,
        equipment_serial: engineUpper,
        driver_name:      'UNKNOWN #' + race_number,
        scanned_by:       scanned_by || 'ROKControl',
        action_result:    'error',
        notes:            'Race number not found: ' + race_number
      });
      return res.json({ success: false, error: 'Driver not found for race number: ' + race_number });
    }

    const entry = entryRes.rows[0];
    const driverName = `${entry.first_name} ${entry.last_name}`;

    // Assign engine serial to entry
    await pool.query(
      `UPDATE race_entries
          SET engine_serial = $1, engine_assigned_at = NOW(),
              engine_returned = false, updated_at = NOW()
        WHERE entry_id = $2`,
      [engineUpper, entry.entry_id]
    );

    // Log as engine_assign → SSE broadcasts to monitor
    await logEquipmentScan({
      scan_type:        'engine_assign',
      barcode_scanned:  engineUpper,
      entry_id:         entry.entry_id,
      driver_id:        entry.driver_id,
      driver_name:      driverName,
      equipment_serial: engineUpper,
      scanned_by:       scanned_by || 'ROKControl',
      action_result:    'success',
      notes:            `Registration: Engine ${engineUpper} → ${driverName} (#${race_number})`,
      event_id:         entry.event_id,
      race_class:       entry.race_class
    });

    res.json({
      success:      true,
      driver_name:  driverName,
      race_class:   entry.race_class,
      engine_serial: engineUpper,
      entry_id:     entry.entry_id
    });
  } catch (err) {
    console.error('rokcontrol register error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// ROKControl Scanner - Drivers list endpoint
// GET /api/rokcontrol/drivers?event_id=X
// Returns JSON list of drivers for an event (used by WM scanner to build live list)
// Authenticated with the ROKControl device token (x-admin-token header)
// ============================================
app.get('/api/rokcontrol/drivers', requireAdmin, async (req, res) => {
  try {
    const { event_id } = req.query;
    if (!event_id) return res.status(400).json({ success: false, error: 'event_id required' });

    const result = await pool.query(
      `SELECT d.race_number, d.first_name, d.last_name, re.race_class
         FROM race_entries re
         JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.event_id = $1
          AND re.entry_status NOT IN ('cancelled','canceled','incomplete')
        ORDER BY re.race_class, CAST(d.race_number AS TEXT)`,
      [event_id]
    );

    const drivers = result.rows.map(r => ({
      race_number: r.race_number || '',
      driver_name: ((r.first_name || '') + ' ' + (r.last_name || '')).trim(),
      race_class:  r.race_class || ''
    }));

    res.json({ success: true, count: drivers.length, drivers });
  } catch (err) {
    console.error('rokcontrol drivers error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// OFFICIALS PORTAL ENDPOINTS
// ============================================

// Officials Login
app.post('/api/officialLogin', async (req, res) => {
  try {
    const { official_code, password } = req.body;

    if (!official_code || !password) {
      throw new Error('Official code and password are required');
    }

    // For now, accept any credentials (you can add a real officials table later)
    // In production, you'd check against an officials table in the database
    const isValid = official_code && password && password.length > 0;
    
    if (!isValid) {
      throw new Error('Invalid credentials');
    }

    // Generate a simple token (in production, use JWT)
    const token = Buffer.from(`${official_code}:${Date.now()}`).toString('base64');

    res.json({
      success: true,
      data: {
        token,
        name: official_code
      }
    });
  } catch (err) {
    console.error('❌ officialLogin error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Duplicate removed — see /api/getUpcomingEvents registered earlier (no auth required)

// Get next race drivers for officials (or specific event if event_id provided)
app.get('/api/getNextRaceDrivers', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { event_id } = req.query;
    let eventResult;

    // If event_id is provided, get that specific event; otherwise get next race
    if (event_id) {
      eventResult = await pool.query(
        `SELECT event_id, event_name, event_date, location 
         FROM events 
         WHERE event_id = $1`,
        [event_id]
      );
    } else {
      eventResult = await pool.query(
        `SELECT event_id, event_name, event_date, location 
         FROM events 
         WHERE event_date >= CURRENT_DATE
         ORDER BY event_date ASC
         LIMIT 1`
      );
    }

    if (eventResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          event_name: 'No races found',
          event_date: null,
          drivers: []
        }
      });
    }

    const event = eventResult.rows[0];

    // Get all drivers registered for this race - use same query as admin getRaceEntries
    const driversResult = await pool.query(`
      SELECT 
        re.*,
        d.first_name,
        d.last_name,
        d.class AS driver_class,
        d.race_number,
        d.license_number,
        d.team_name,
        d.kart_brand,
        d.date_of_birth,
        d.season_engine_rental,
        d.transponder_number,
        c.email,
        mc.medical_conditions
      FROM race_entries re
      LEFT JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN contacts c ON re.driver_id = c.driver_id
      LEFT JOIN medical_consent mc ON re.driver_id = mc.driver_id
      WHERE re.event_id = $1
      ORDER BY d.first_name, d.last_name
    `, [event.event_id]);

    res.json({
      success: true,
      data: {
        event_id: event.event_id,
        event_name: event.event_name,
        event_date: event.event_date,
        location: event.location,
        drivers: driversResult.rows
      }
    });
  } catch (err) {
    console.error('❌ getNextRaceDrivers error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Upload event document (race results, incident reports, etc.)
app.post('/api/uploadEventDocument', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { event_id, document_type, file_name, file_content, uploaded_by_official } = req.body;
    
    if (!event_id || !document_type || !file_name || !file_content) {
      throw new Error('Missing required fields: event_id, document_type, file_name, file_content');
    }

    // Validate event exists
    const eventCheck = await pool.query('SELECT event_id FROM events WHERE event_id = $1', [event_id]);
    if (eventCheck.rows.length === 0) {
      throw new Error('Event not found');
    }

    const document_id = uuidv4();
    
    // Decode base64 file content
    const buffer = Buffer.from(file_content, 'base64');
    const file_size = buffer.length;
    
    // Create uploads directory if it doesn't exist
    const uploadDir = path.join(__dirname, 'uploads', 'event-documents', event_id);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Save file locally
    const file_path = path.join(uploadDir, `${document_id}_${file_name}`);
    fs.writeFileSync(file_path, buffer);

    // Save metadata to database
    await pool.query(
      `INSERT INTO event_documents (document_id, event_id, uploaded_by_official, document_type, file_name, file_path, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [document_id, event_id, uploaded_by_official || 'Unknown', document_type, file_name, file_path, file_size]
    );

    console.log(`📄 Document uploaded: ${file_name} (${file_size} bytes) for event ${event_id}`);

    res.json({
      success: true,
      data: {
        document_id: document_id,
        file_name: file_name,
        file_size: file_size,
        upload_date: new Date().toISOString(),
        message: 'Document uploaded successfully'
      }
    });
  } catch (err) {
    console.error('❌ Document upload error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get event documents
app.get('/api/getEventDocuments', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { event_id } = req.query;
    if (!event_id) {
      throw new Error('event_id required');
    }

    const docsResult = await pool.query(
      `SELECT 
        document_id, 
        event_id, 
        uploaded_by_official, 
        document_type, 
        file_name, 
        file_size,
        upload_date
       FROM event_documents 
       WHERE event_id = $1 
       ORDER BY upload_date DESC`,
      [event_id]
    );

    res.json({
      success: true,
      data: {
        event_id: event_id,
        documents: docsResult.rows || [],
        total: docsResult.rows.length
      }
    });
  } catch (err) {
    console.error('❌ Get documents error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Download event document
app.get('/api/downloadEventDocument/:document_id', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { document_id } = req.params;

    const docResult = await pool.query(
      'SELECT document_id, file_name, file_path FROM event_documents WHERE document_id = $1',
      [document_id]
    );

    if (docResult.rows.length === 0) {
      throw new Error('Document not found');
    }

    const doc = docResult.rows[0];
    
    // Check if file exists
    if (!fs.existsSync(doc.file_path)) {
      throw new Error('File not found on server');
    }

    // Send file
    res.download(doc.file_path, doc.file_name);
    console.log(`📥 Document downloaded: ${doc.file_name}`);
  } catch (err) {
    console.error('❌ Download error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Delete event document
app.post('/api/deleteEventDocument', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { document_id } = req.body;
    if (!document_id) {
      throw new Error('document_id required');
    }

    const docResult = await pool.query(
      'SELECT file_path FROM event_documents WHERE document_id = $1',
      [document_id]
    );

    if (docResult.rows.length === 0) {
      throw new Error('Document not found');
    }

    // Delete file from disk
    const file_path = docResult.rows[0].file_path;
    if (fs.existsSync(file_path)) {
      fs.unlinkSync(file_path);
    }

    // Delete from database
    await pool.query('DELETE FROM event_documents WHERE document_id = $1', [document_id]);

    console.log(`🗑️ Document deleted: ${document_id}`);

    res.json({
      success: true,
      data: { message: 'Document deleted successfully' }
    });
  } catch (err) {
    console.error('❌ Delete error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// MSA License Upload
app.post('/api/uploadMSALicense', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { driver_id, file_name, file_data, file_type } = req.body;

    if (!driver_id || !file_name || !file_data) {
      throw new Error('driver_id, file_name, and file_data required');
    }

    const document_id = uuidv4();
    const buffer = Buffer.from(file_data, 'base64');
    const file_size = buffer.length;
    const z1Key = `msa-licenses/${document_id}_${file_name}`;

    // Delete any existing license for this driver (Z1 + DB)
    const existingResult = await pool.query(
      'SELECT document_id, file_path FROM msa_licenses WHERE driver_id = $1',
      [driver_id]
    );

    if (existingResult.rows.length > 0) {
      const oldKey = existingResult.rows[0].file_path;
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: Z1_BUCKET, Key: oldKey }));
      } catch (delErr) {
        console.warn('⚠️ Could not delete old Z1 MSA file:', delErr.message);
      }
      await pool.query('DELETE FROM msa_licenses WHERE driver_id = $1', [driver_id]);
    }

    // Upload to Z1 persistent storage
    await s3.send(new PutObjectCommand({
      Bucket: Z1_BUCKET,
      Key: z1Key,
      Body: buffer,
      ContentType: file_type || 'application/octet-stream'
    }));

    // Store Z1 key in file_path column
    await pool.query(
      `INSERT INTO msa_licenses (document_id, driver_id, file_name, file_path, file_size, file_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [document_id, driver_id, file_name, z1Key, file_size, file_type]
    );

    console.log(`📄 MSA License uploaded to Z1 for driver ${driver_id}: ${file_name}`);

    res.json({
      success: true,
      data: {
        document_id: document_id,
        file_name: file_name,
        file_size: file_size,
        message: 'MSA License uploaded successfully'
      }
    });
  } catch (err) {
    console.error('❌ MSA upload error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get MSA License
app.get('/api/getMSALicense/:driver_id', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { driver_id } = req.params;

    const result = await pool.query(
      `SELECT document_id, driver_id, file_name, file_size, file_type, upload_date
       FROM msa_licenses 
       WHERE driver_id = $1`,
      [driver_id]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: null
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (err) {
    console.error('❌ Get MSA error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Download MSA License
app.get('/api/downloadMSALicense/:document_id', async (req, res) => {
  try {
    const { document_id } = req.params;

    const result = await pool.query(
      'SELECT file_path, file_name, file_type FROM msa_licenses WHERE document_id = $1',
      [document_id]
    );

    if (result.rows.length === 0) {
      throw new Error('Document not found');
    }

    const { file_path: z1Key, file_name, file_type } = result.rows[0];

    const s3Res = await s3.send(new GetObjectCommand({ Bucket: Z1_BUCKET, Key: z1Key }));

    res.setHeader('Content-Disposition', `attachment; filename="${file_name}"`);
    res.setHeader('Content-Type', file_type || 'application/octet-stream');
    s3Res.Body.pipe(res);
  } catch (err) {
    console.error('❌ Download error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Delete MSA License
app.post('/api/deleteMSALicense', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { document_id } = req.body;
    if (!document_id) {
      throw new Error('document_id required');
    }

    const docResult = await pool.query(
      'SELECT file_path FROM msa_licenses WHERE document_id = $1',
      [document_id]
    );

    if (docResult.rows.length === 0) {
      throw new Error('Document not found');
    }

    // Delete from Z1
    const z1Key = docResult.rows[0].file_path;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: Z1_BUCKET, Key: z1Key }));
    } catch (delErr) {
      console.warn('⚠️ Could not delete Z1 MSA file:', delErr.message);
    }

    // Delete from database
    await pool.query('DELETE FROM msa_licenses WHERE document_id = $1', [document_id]);

    console.log(`🗑️ MSA License deleted: ${document_id}`);

    res.json({
      success: true,
      data: { message: 'MSA License deleted successfully' }
    });
  } catch (err) {
    console.error('❌ MSA Delete error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get all MSA licenses for drivers in a specific event
app.get('/api/getEventDriversMSALicenses/:event_id', async (req, res) => {
  try {
    const { event_id } = req.params;
    if (!event_id) {
      throw new Error('event_id required');
    }

    const result = await pool.query(`
      SELECT 
        ml.document_id,
        ml.driver_id,
        ml.file_name,
        ml.file_size,
        ml.upload_date,
        d.first_name,
        d.last_name,
        d.class
      FROM msa_licenses ml
      JOIN drivers d ON ml.driver_id = d.driver_id
      JOIN race_entries re ON d.driver_id = re.driver_id
      WHERE re.event_id = $1
      AND re.entry_status IN ('confirmed', 'pending')
      ORDER BY d.first_name, d.last_name
    `, [event_id]);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    console.error('❌ Error getting event MSA licenses:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Export officials CSV in multiple formats
app.post('/api/exportOfficialsCSV', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { format } = req.body;
    if (!format) {
      throw new Error('Export format is required');
    }

    // Get next race and drivers
    const eventResult = await pool.query(
      `SELECT event_id, event_name, event_date 
       FROM events 
       WHERE event_date >= CURRENT_DATE
       ORDER BY event_date ASC
       LIMIT 1`
    );

    if (eventResult.rows.length === 0) {
      throw new Error('No upcoming races found');
    }

    const event = eventResult.rows[0];

    const driversResult = await pool.query(`
      SELECT DISTINCT
        d.driver_id,
        d.first_name,
        d.last_name,
        c.email,
        c.phone_mobile,
        d.class,
        d.date_of_birth,
        d.season_engine_rental,
        re.entry_id,
        re.engine,
        re.team_code,
        d.transponder_number,
        mc.medical_conditions,
        d.race_number,
        re.race_class,
        re.race_number as entry_race_number,
        d.license_number,
        d.kart_brand,
        d.team_name,
        d.nationality,
        d.championship,
        e.event_name,
        e.event_date,
        re.entry_status,
        re.payment_status,
        re.payment_reference,
        re.total_amount as entry_fee,
        re.amount_paid,
        re.ticket_engine_ref,
        re.ticket_tyres_ref,
        re.ticket_transponder_ref,
        re.ticket_fuel_ref,
        re.engine_serial,
        re.engine_assigned_at,
        re.transponder_serial,
        re.transponder_assigned_at,
        re.tyre_front_left,
        re.tyre_front_right,
        re.tyre_rear_left,
        re.tyre_rear_right,
        re.fuel_collected,
        re.created_at,
        re.updated_at
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      JOIN events e ON re.event_id = e.event_id
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      LEFT JOIN medical_consent mc ON d.driver_id = mc.driver_id
      WHERE re.event_id = $1
      AND re.entry_status IN ('confirmed', 'pending', 'pending_payment')
      ORDER BY d.class, d.first_name, d.last_name
    `, [event.event_id]);

    const drivers = driversResult.rows;
    let csv = '';

    if (format === 'drivers') {
      // Full driver list with all database fields (excluding payments)
      const headers = [
        'Driver ID', 'First Name', 'Last Name', 'Driver Name', 'Email', 'Phone', 
        'Class', 'Race Class', 'DOB', 'Nationality', 'Championship',
        'License Number', 'MSA License', 'Transponder Number',
        'Kart Brand', 'Team Name', 'Team Code', 'Medical Conditions',
        'Race Number', 'Entry Race Number',
        'Event Name', 'Event Date', 'Entry ID', 'Entry Status', 'Payment Status',
        'Entry Fee', 'Amount Paid', 'Payment Reference',
        'Season Engine Rental', 'Engine Rental', 'Engine Serial', 'Engine Assigned At',
        'Transponder Serial', 'Transponder Assigned At',
        'Tyre Front Left', 'Tyre Front Right', 'Tyre Rear Left', 'Tyre Rear Right',
        'Fuel Collected',
        'Ticket Engine Ref', 'Ticket Tyres Ref', 'Ticket Transponder Ref', 'Ticket Fuel Ref',
        'Entry Created At', 'Entry Updated At'
      ];
      const rows = drivers.map(d => [
        d.driver_id || '',
        d.first_name || '',
        d.last_name || '',
        `${d.first_name || ''} ${d.last_name || ''}`.trim(),
        d.email || '',
        d.phone_mobile || '',
        d.class || '',
        d.race_class || '',
        d.date_of_birth ? new Date(d.date_of_birth).toLocaleDateString('en-ZA') : '',
        d.nationality || '',
        d.championship || '',
        d.license_number || '',
        d.license_number || '',
        d.transponder_number || 'REQUIRED',
        d.kart_brand || '',
        d.team_name || '',
        d.team_code || '',
        d.medical_conditions || '',
        d.race_number || '',
        d.entry_race_number || '',
        d.event_name || '',
        d.event_date ? new Date(d.event_date).toLocaleDateString('en-ZA') : '',
        d.entry_id || '',
        d.entry_status || '',
        d.payment_status || '',
        d.entry_fee || '',
        d.amount_paid || '',
        d.payment_reference || '',
        d.season_engine_rental || '',
        (d.engine === 1 || d.engine === '1' || d.season_engine_rental === 'Y') ? 'Yes' : 'No',
        d.engine_serial || '',
        d.engine_assigned_at ? new Date(d.engine_assigned_at).toLocaleString('en-ZA') : '',
        d.transponder_serial || '',
        d.transponder_assigned_at ? new Date(d.transponder_assigned_at).toLocaleString('en-ZA') : '',
        d.tyre_front_left || '',
        d.tyre_front_right || '',
        d.tyre_rear_left || '',
        d.tyre_rear_right || '',
        d.fuel_collected ? 'Yes' : 'No',
        d.ticket_engine_ref || '',
        d.ticket_tyres_ref || '',
        d.ticket_transponder_ref || '',
        d.ticket_fuel_ref || '',
        d.created_at ? new Date(d.created_at).toLocaleString('en-ZA') : '',
        d.updated_at ? new Date(d.updated_at).toLocaleString('en-ZA') : ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      csv = [headers.join(','), ...rows].join('\n');
    } else if (format === 'signon') {
      // Sign-on sheet format (simplified for printing with signature space)
      const headers = ['#', 'Driver Name', 'Entrant Name', 'Class', 'Race#', 'Transponder', 'Signature'];
      const rows = drivers.map((d, idx) => [
        idx + 1,
        `${d.first_name} ${d.last_name}`,
        d.team_name || '',
        d.class || '',
        d.entry_race_number || d.race_number || '',
        d.transponder_number || '',
        ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      csv = [headers.join(','), ...rows].join('\n');
    } else if (format === 'timing') {
      // Helper function to escape CSV values
      const escapeCSV = (value) => {
        if (value === null || value === undefined) return '';
        const stringValue = String(value);
        if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
          return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
      };

      // Country code mapping (ISO 3166-1 alpha-3)
      const countryCodeMap = {
        'South Africa': 'RSA',
        'Zimbabwe': 'ZWE',
        'Mozambique': 'MOZ',
        'Namibia': 'NAM',
        'Botswana': 'BWA',
        'Zambia': 'ZMB',
        'United Kingdom': 'GBR',
        'USA': 'USA',
        'United States': 'USA',
        'Australia': 'AUS',
        'New Zealand': 'NZL'
      };

      // Timing system format - full 14 column format
      const headers = ['txp short', 'txpLong', 'Class', 'Race#', 'First Name', 'Last Name', 'License#', 'Chassis', 'Engine', 'Tyres', 'Image', 'Team', 'Country', 'Scoring'];
      const rows = drivers.map(d => {
          // Determine engine type based on class
          const raceClass = (d.race_class || d.class || '').toUpperCase();
          const isCadet = raceClass.includes('CADET');
          const engine = isCadet ? 'Tillotson' : 'Vortex';
          
          // Determine tyre brand based on class
          const tyres = isCadet ? 'XXXX' : 'Levanto';
          
          // Create image name (firstname + lastname, no spaces)
          const firstName = d.first_name || '';
          const lastName = d.last_name || '';
          const imageName = (firstName + lastName).replace(/\s+/g, '');
          
          // Get country code (default to RSA if not found)
          const countryCode = countryCodeMap[d.nationality] || 'RSA';
          
          // Determine scoring category based on championship field
          let scoring = '';
          if (d.championship) {
            const champ = d.championship.toUpperCase();
            if (champ.includes('NATIONAL') && champ.includes('REGIONAL')) {
              scoring = 'Nat + Reg';
            } else if (champ.includes('NATIONAL')) {
              scoring = 'Nat only';
            } else if (champ.includes('REGIONAL')) {
              scoring = 'Reg only';
            } else {
              scoring = 'Nat only';
            }
          } else {
            scoring = 'Nat only';
          }
          
          return [
            '', // txp short - leave blank
            escapeCSV(d.transponder_number || ''),
            escapeCSV(d.race_class || d.class || ''),
            escapeCSV(d.entry_race_number || d.race_number || ''),
            escapeCSV(firstName),
            escapeCSV(lastName),
            escapeCSV(d.license_number || ''),
            escapeCSV(d.kart_brand || ''),
            escapeCSV(engine),
            escapeCSV(tyres),
            escapeCSV(imageName),
            escapeCSV(d.team_name || ''),
            countryCode,
            escapeCSV(scoring)
          ].join(',');
        });
      csv = [headers.join(','), ...rows].join('\n');
    }

    // Set response headers for file download with event name
    const eventNameSafe = event.event_name.replace(/[^a-zA-Z0-9-]/g, '-').replace(/--+/g, '-');
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = format === 'drivers' ? `${eventNameSafe}-drivers-list-${dateStr}.csv`
                   : format === 'signon' ? `${eventNameSafe}-sign-on-${dateStr}.csv`
                   : `${eventNameSafe}-timing-sheet-${dateStr}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    console.log(`✅ Officials CSV export (${format}): ${drivers.length} drivers`);
    res.send(csv);
  } catch (err) {
    console.error('❌ exportOfficialsCSV error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Sign-On Sheet Excel export for officials portal
app.get('/api/officials/events/:eventId/exportExcel', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { eventId } = req.params;

    const { rows: entries } = await pool.query(
      `SELECT
         r.entry_id, r.event_id, r.race_class, r.entry_status,
         d.race_number,
         d.first_name AS driver_first_name, d.last_name AS driver_last_name,
         d.team_name, d.msa_license_number,
         c.full_name AS entrant_name
       FROM race_entries r
       LEFT JOIN drivers d ON r.driver_id = d.driver_id
       LEFT JOIN contacts c ON r.driver_id = c.driver_id
       WHERE r.event_id = $1
         AND r.entry_status != 'cancelled'
         AND (r.race_class IS NOT NULL AND r.race_class != '')
       ORDER BY r.race_class, d.race_number`,
      [eventId]
    );

    // Fetch optional S3 branding images
    async function s3ToBuffer(key) {
      try {
        const cmd = new GetObjectCommand({ Bucket: Z1_BUCKET, Key: key });
        const data = await s3.send(cmd);
        const chunks = [];
        for await (const chunk of data.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
      } catch { return null; }
    }
    const prefix = eventDocPrefix(eventId, 'branding');
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: Z1_BUCKET, Prefix: prefix }));
    let headerKey = null, footerKey = null;
    for (const obj of (listed.Contents || [])) {
      const base = obj.Key.replace(prefix, '').replace(/\.[^.]+$/, '').toLowerCase();
      if (base === 'header') headerKey = obj.Key;
      if (base === 'footer') footerKey = obj.Key;
    }
    const [headerBuf, footerBuf] = await Promise.all([
      headerKey ? s3ToBuffer(headerKey) : null,
      footerKey ? s3ToBuffer(footerKey) : null,
    ]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sign-On Sheet');
    const TOTAL_COLS = 8;

    ws.columns = [
      { key: 'race_number',  width: 12 },
      { key: 'race_class',   width: 16 },
      { key: 'driver_name',  width: 26 },
      { key: 'entrant_name', width: 26 },
      { key: 'team_name',    width: 24 },
      { key: 'msa_license',  width: 20 },
      { key: 'sign',         width: 28 },
      { key: 'qr',           width: 10 },
    ];

    let currentRow = 1;

    if (headerBuf) {
      const imgId = wb.addImage({ buffer: headerBuf, extension: headerKey.split('.').pop().replace('jpg','jpeg') });
      const HEADER_ROWS = 5;
      ws.addImage(imgId, { tl: { col: 0, row: currentRow - 1 }, br: { col: TOTAL_COLS, row: currentRow - 1 + HEADER_ROWS } });
      for (let r = currentRow; r < currentRow + HEADER_ROWS; r++) ws.getRow(r).height = 18;
      currentRow += HEADER_ROWS;
      ws.getRow(currentRow).height = 6;
      currentRow++;
    }

    ws.mergeCells(currentRow, 1, currentRow, TOTAL_COLS);
    const titleCell = ws.getCell(currentRow, 1);
    titleCell.value = `Sign-On Sheet — ${eventId}`;
    titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFD700' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
    ws.getRow(currentRow).height = 28;
    currentRow++;
    ws.getRow(currentRow).height = 4;
    currentRow++;

    const HEADERS = ['Race #', 'Class', 'Driver Full Name', 'Entrant Full Name', 'Team Name', 'MSA Licence #', 'Entrant Signature', 'QR'];
    const hdrRow = ws.getRow(currentRow);
    hdrRow.height = 22;
    HEADERS.forEach((h, i) => {
      const cell = hdrRow.getCell(i + 1);
      cell.value = h;
      cell.font  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
    });
    currentRow++;

    const ROW_HEIGHT = 56;
    const QR_SIZE = 60;
    for (const entry of entries) {
      const rowIdx = currentRow;
      ws.getRow(rowIdx).height = ROW_HEIGHT;
      const cols = [
        entry.race_number || '',
        entry.race_class  || '',
        [entry.driver_first_name, entry.driver_last_name].filter(Boolean).join(' '),
        entry.entrant_name || '',
        entry.team_name || '',
        entry.msa_license_number || '',
        '',
      ];
      const rowFill = (rowIdx % 2 === 0)
        ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } }
        : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
      cols.forEach((val, i) => {
        const cell = ws.getRow(rowIdx).getCell(i + 1);
        cell.value = val;
        cell.font  = { size: 10 };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill  = rowFill;
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
      });
      try {
        const qrBuf = await QRCode.toBuffer(String(entry.entry_id || entry.race_number || rowIdx), { width: QR_SIZE, margin: 1 });
        const qrId  = wb.addImage({ buffer: qrBuf, extension: 'png' });
        ws.addImage(qrId, { tl: { col: 7.1, row: rowIdx - 1 + 0.1 }, br: { col: 8, row: rowIdx - 1 + 0.9 }, editAs: 'oneCell' });
      } catch { /* skip QR on error */ }
      const qrCell = ws.getRow(rowIdx).getCell(8);
      qrCell.fill   = rowFill;
      qrCell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
      currentRow++;
    }

    if (footerBuf) {
      ws.getRow(currentRow).height = 6;
      currentRow++;
      const footerId = wb.addImage({ buffer: footerBuf, extension: footerKey.split('.').pop().replace('jpg','jpeg') });
      const FOOTER_ROWS = 4;
      ws.addImage(footerId, { tl: { col: 0, row: currentRow - 1 }, br: { col: TOTAL_COLS, row: currentRow - 1 + FOOTER_ROWS } });
      for (let r = currentRow; r < currentRow + FOOTER_ROWS; r++) ws.getRow(r).height = 15;
    }

    ws.views = [{ state: 'frozen', ySplit: headerBuf ? 9 : 3 }];

    const safeName = eventId.replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="SignOn_Sheet_${safeName}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
    console.log(`✅ Officials Excel sign-on export: ${entries.length} entries for ${eventId}`);
  } catch (err) {
    console.error('❌ officials exportExcel error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// Get audit log entries (unified: audit_log + equipment_scan_log)
app.post('/api/getAuditLog', async (req, res) => {
  try {
    const { driver, action, source, date_from, date_to, limit } = req.body;
    const safeLimit = Math.min(parseInt(limit) || 500, 2000);
    const params = [];
    const conditions = [];

    if (driver) {
      params.push(`%${driver}%`);
      const p = params.length;
      conditions.push(`(combined.driver_first_name ILIKE $${p} OR combined.driver_last_name ILIKE $${p} OR combined.driver_email ILIKE $${p})`);
    }

    if (action) {
      params.push(action);
      conditions.push(`combined.action = $${params.length}`);
    }

    if (source && source !== 'all') {
      params.push(source);
      conditions.push(`combined.source = $${params.length}`);
    }

    if (date_from) {
      params.push(date_from);
      conditions.push(`combined.event_time >= $${params.length}::date`);
    }

    if (date_to) {
      params.push(date_to);
      conditions.push(`combined.event_time < ($${params.length}::date + interval '1 day')`);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const query = `
      SELECT * FROM (
        SELECT
          'audit'            AS source,
          al.created_at      AS event_time,
          al.action,
          al.driver_id::text AS driver_id,
          COALESCE(d.first_name, '')       AS driver_first_name,
          COALESCE(d.last_name, '')        AS driver_last_name,
          COALESCE(al.driver_email, c.email, '') AS driver_email,
          al.field_name      AS detail,
          al.old_value,
          al.new_value,
          COALESCE(al.ip_address, '')      AS ip_address,
          NULL::text         AS equipment_serial,
          NULL::text         AS scanned_by,
          NULL::text         AS action_result,
          NULL::text         AS race_class
        FROM audit_log al
        LEFT JOIN drivers  d ON al.driver_id::text = d.driver_id::text
        LEFT JOIN contacts c ON al.driver_id::text = c.driver_id::text

        UNION ALL

        SELECT
          'equipment'        AS source,
          esl.scan_timestamp AS event_time,
          esl.scan_type      AS action,
          esl.driver_id,
          split_part(COALESCE(esl.driver_name,''), ' ', 1) AS driver_first_name,
          CASE WHEN position(' ' IN COALESCE(esl.driver_name,'')) > 0
               THEN substring(COALESCE(esl.driver_name,'') FROM position(' ' IN COALESCE(esl.driver_name,'')) + 1)
               ELSE '' END  AS driver_last_name,
          ''                 AS driver_email,
          esl.barcode_scanned AS detail,
          ''                 AS old_value,
          COALESCE(esl.notes, '') AS new_value,
          ''                 AS ip_address,
          esl.equipment_serial,
          esl.scanned_by,
          esl.action_result,
          esl.race_class
        FROM equipment_scan_log esl

        UNION ALL

        SELECT
          'dir'              AS source,
          dec.contact_date   AS event_time,
          CASE dec.contact_type
            WHEN 'Part Change' THEN 'dir_part_changed'
            ELSE 'dir_contact'
          END                AS action,
          NULL::text         AS driver_id,
          COALESCE(dec.person_name, '')  AS driver_first_name,
          ''                 AS driver_last_name,
          ''                 AS driver_email,
          COALESCE(dec.contact_type, '') AS detail,
          ''                 AS old_value,
          COALESCE(dec.description, dec.dir_notes, '') AS new_value,
          ''                 AS ip_address,
          dec.engine_serial  AS equipment_serial,
          'DIR Portal'       AS scanned_by,
          COALESCE(dec.outcome, '')      AS action_result,
          ''                 AS race_class
        FROM dir_engine_contacts dec
      ) combined
      ${whereClause}
      ORDER BY combined.event_time DESC
      LIMIT ${safeLimit}
    `;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: { logs: result.rows, total: result.rowCount }
    });
  } catch (err) {
    console.error('❌ getAuditLog error:', err.message);
    res.status(400).json({ success: false, error: { message: 'Failed to load audit log' } });
  }
});

// Export audit log as CSV (unified: audit_log + equipment_scan_log)
app.post('/api/exportAuditCSV', async (req, res) => {
  try {
    const { driver, action, source, date_from, date_to } = req.body;
    const params = [];
    const conditions = [];

    if (driver) {
      params.push(`%${driver}%`);
      const p = params.length;
      conditions.push(`(combined.driver_first_name ILIKE $${p} OR combined.driver_last_name ILIKE $${p} OR combined.driver_email ILIKE $${p})`);
    }
    if (action) { params.push(action); conditions.push(`combined.action = $${params.length}`); }
    if (source && source !== 'all') { params.push(source); conditions.push(`combined.source = $${params.length}`); }
    if (date_from) { params.push(date_from); conditions.push(`combined.event_time >= $${params.length}::date`); }
    if (date_to)   { params.push(date_to);   conditions.push(`combined.event_time < ($${params.length}::date + interval '1 day')`); }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const query = `
      SELECT * FROM (
        SELECT 'audit' AS source, al.created_at AS event_time, al.action,
          al.driver_id::text,
          COALESCE(d.first_name,'') AS driver_first_name,
          COALESCE(d.last_name,'')  AS driver_last_name,
          COALESCE(al.driver_email, c.email,'') AS driver_email,
          al.field_name AS detail, al.old_value, al.new_value,
          COALESCE(al.ip_address,'') AS ip_address,
          NULL::text AS equipment_serial, NULL::text AS scanned_by,
          NULL::text AS action_result, NULL::text AS race_class
        FROM audit_log al
        LEFT JOIN drivers  d ON al.driver_id::text = d.driver_id::text
        LEFT JOIN contacts c ON al.driver_id::text = c.driver_id::text
        UNION ALL
        SELECT 'equipment' AS source, esl.scan_timestamp AS event_time, esl.scan_type AS action,
          esl.driver_id,
          split_part(COALESCE(esl.driver_name,''),' ',1) AS driver_first_name,
          CASE WHEN position(' ' IN COALESCE(esl.driver_name,''))>0
               THEN substring(COALESCE(esl.driver_name,'') FROM position(' ' IN COALESCE(esl.driver_name,''))+1)
               ELSE '' END AS driver_last_name,
          '' AS driver_email,
          esl.barcode_scanned AS detail, '' AS old_value,
          COALESCE(esl.notes,'') AS new_value,
          '' AS ip_address,
          esl.equipment_serial, esl.scanned_by, esl.action_result, esl.race_class
        FROM equipment_scan_log esl
      ) combined
      ${whereClause}
      ORDER BY combined.event_time DESC
    `;

    const result = await pool.query(query, params);

    const headers = ['Source','Timestamp','Action','Driver Name','Email','Detail','Old Value','New Value','IP Address','Equipment Serial','Scanned By','Result','Race Class'];
    const rows = result.rows.map(log => [
      log.source || '',
      log.event_time ? new Date(log.event_time).toLocaleString('en-ZA') : '',
      log.action || '',
      [log.driver_first_name, log.driver_last_name].filter(Boolean).join(' ') || 'System',
      log.driver_email || '',
      log.detail || '',
      log.old_value || '',
      log.new_value || '',
      log.ip_address || '',
      log.equipment_serial || '',
      log.scanned_by || '',
      log.action_result || '',
      log.race_class || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

    const csv = [headers.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0,10)}.csv"`);
    console.log(`✅ Audit log export: ${result.rows.length} records`);
    res.send(csv);
  } catch (err) {
    console.error('❌ exportAuditCSV error:', err.message);
    res.status(400).json({ success: false, error: { message: 'Export failed' } });
  }
});

// ==================== PUSH NOTIFICATIONS ====================

// Initialize push subscriptions table
const initPushSubscriptionsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        driver_id INTEGER,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Push subscriptions table initialized');
  } catch (err) {
    console.error('Error creating push_subscriptions table:', err.message);
  }
};
initPushSubscriptionsTable();

// Get VAPID public key
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ 
    success: true, 
    publicKey: process.env.VAPID_PUBLIC_KEY 
  });
});

// Subscribe to push notifications
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { subscription, driverId } = req.body;
    
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ success: false, error: 'Invalid subscription' });
    }

    const keys = subscription.keys || {};
    
    // Upsert subscription
    await pool.query(`
      INSERT INTO push_subscriptions (driver_id, endpoint, p256dh, auth)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (endpoint) 
      DO UPDATE SET driver_id = $1, p256dh = $3, auth = $4, last_used = CURRENT_TIMESTAMP
    `, [driverId || null, subscription.endpoint, keys.p256dh || '', keys.auth || '']);

    res.json({ success: true, message: 'Subscribed to notifications' });
  } catch (err) {
    console.error('Push subscribe error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Unsubscribe from push notifications
app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    
    res.json({ success: true, message: 'Unsubscribed from notifications' });
  } catch (err) {
    console.error('Push unsubscribe error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send push notification (admin only)
app.post('/api/push/send', async (req, res) => {
  try {
    const { title, body, url, driverId, raceClass, eventId } = req.body;
    
    if (!title || !body) {
      return res.status(400).json({ success: false, error: 'Title and body required' });
    }

    let targetDriverIds = null;
    
    // If filtering by class, get driver IDs for that class
    if (raceClass && !driverId) {
      const classDrivers = await pool.query(
        'SELECT driver_id FROM drivers WHERE class = $1 AND is_deleted = false',
        [raceClass]
      );
      targetDriverIds = classDrivers.rows.map(r => r.driver_id);
      console.log(`Push targeting class ${raceClass}: ${targetDriverIds.length} drivers`);
    }
    
    // If filtering by event, get driver IDs for that event
    if (eventId && !driverId) {
      let eventQuery = `
        SELECT DISTINCT re.driver_id 
        FROM race_entries re 
        WHERE re.event_id = $1::text 
          AND (re.status IS NULL OR re.status != 'Cancelled')
      `;
      const params = [eventId];
      
      // If also filtering by class within event
      if (raceClass) {
        eventQuery += ' AND (re.race_class = $2 OR re.class = $2)';
        params.push(raceClass);
      }
      
      const eventDrivers = await pool.query(eventQuery, params);
      targetDriverIds = eventDrivers.rows.map(r => r.driver_id);
      console.log(`Push targeting event ${eventId}${raceClass ? ' class ' + raceClass : ''}: ${targetDriverIds.length} drivers`);
    }

    // Get subscriptions
    let query = 'SELECT * FROM push_subscriptions';
    let params = [];
    
    if (driverId) {
      // Single driver
      query += ' WHERE driver_id = $1';
      params = [driverId];
    } else if (targetDriverIds && targetDriverIds.length > 0) {
      // Multiple drivers by class or event
      query += ' WHERE driver_id = ANY($1)';
      params = [targetDriverIds];
    }
    // else: send to all subscriptions
    
    const result = await pool.query(query, params);
    console.log(`Found ${result.rows.length} push subscriptions to notify`);
    
    const payload = JSON.stringify({
      title,
      body,
      url: url || '/driver_portal.html'
    });

    // Determine notification type based on content
    let notificationType = 'general';
    if (eventId) notificationType = 'event';
    else if (title.toLowerCase().includes('registration') || body.toLowerCase().includes('registration')) notificationType = 'registration';
    else if (title.toLowerCase().includes('payment') || body.toLowerCase().includes('payment')) notificationType = 'payment';

    // Get event name if eventId provided
    let eventName = null;
    if (eventId) {
      try {
        const eventResult = await pool.query('SELECT event_name FROM events WHERE event_id = $1', [eventId]);
        if (eventResult.rows.length > 0) {
          eventName = eventResult.rows[0].event_name;
        }
      } catch (e) {
        console.log('Could not get event name:', e.message);
      }
    }

    let successCount = 0;
    let failCount = 0;
    const failedEndpoints = [];
    const notifiedDriverIds = new Set();

    // Send notifications in parallel batches of 10 for efficiency
    const batchSize = 10;
    for (let i = 0; i < result.rows.length; i += batchSize) {
      const batch = result.rows.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (sub) => {
        try {
          await webpush.sendNotification({
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth
            }
          }, payload);
          successCount++;
          
          // Track driver ID for notification history
          if (sub.driver_id) {
            notifiedDriverIds.add(sub.driver_id);
          }
          
          // Update last_used
          await pool.query('UPDATE push_subscriptions SET last_used = CURRENT_TIMESTAMP WHERE id = $1', [sub.id]);
        } catch (err) {
          failCount++;
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired or invalid - remove it
            failedEndpoints.push(sub.endpoint);
            await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
          }
        }
      }));
    }

    // Record notification history for each driver who received it
    for (const dId of notifiedDriverIds) {
      try {
        await pool.query(
          `INSERT INTO notification_history (driver_id, event_id, event_name, title, body, url, notification_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [dId, eventId || null, eventName, title, body, url || '/driver_portal.html', notificationType]
        );
      } catch (histErr) {
        console.log('Could not save notification history:', histErr.message);
      }
    }

    res.json({ 
      success: true, 
      sent: successCount, 
      failed: failCount,
      removed: failedEndpoints.length
    });
  } catch (err) {
    console.error('Push send error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get push notification stats (admin)
app.get('/api/push/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as total,
             COUNT(driver_id) as with_driver,
             COUNT(*) - COUNT(driver_id) as anonymous
      FROM push_subscriptions
    `);
    
    res.json({ 
      success: true, 
      subscribedCount: parseInt(result.rows[0].total) || 0,
      totalSent: 0, // We could track this in a separate table
      stats: result.rows[0] 
    });
  } catch (err) {
    console.error('Push stats error:', err.message);
    res.status(500).json({ success: false, subscribedCount: 0, totalSent: 0, error: err.message });
  }
});

// Get all push subscribers list (admin)
app.get('/api/push/subscribers', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ps.id, ps.driver_id, ps.endpoint, ps.created_at, ps.last_used,
             d.first_name, d.last_name, c.email, d.class AS racing_class
      FROM push_subscriptions ps
      LEFT JOIN drivers d ON ps.driver_id = d.driver_id
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      ORDER BY ps.created_at DESC
    `);
    
    res.json({ 
      success: true, 
      subscribers: result.rows.map(row => ({
        id: row.id,
        driverId: row.driver_id,
        driverName: row.first_name && row.last_name ? `${row.first_name} ${row.last_name}` : (row.driver_id ? 'Unknown Driver' : 'Anonymous'),
        email: row.email || '-',
        racingClass: row.racing_class || '-',
        endpoint: row.endpoint ? row.endpoint.substring(0, 50) + '...' : '-',
        createdAt: row.created_at,
        lastUsed: row.last_used
      }))
    });
  } catch (err) {
    console.error('Push subscribers error:', err.message);
    res.status(500).json({ success: false, error: err.message, subscribers: [] });
  }
});

// Get notification history for a driver
app.get('/api/notifications/history', async (req, res) => {
  try {
    const { driverId, type, eventId } = req.query;
    
    if (!driverId) {
      return res.status(400).json({ success: false, error: 'Driver ID required' });
    }
    
    let query = `
      SELECT id, driver_id, event_id, event_name, title, body, url, notification_type, created_at
      FROM notification_history
      WHERE driver_id = $1
    `;
    const params = [driverId];
    let paramIndex = 2;
    
    if (type) {
      query += ` AND notification_type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }
    
    if (eventId) {
      query += ` AND event_id = $${paramIndex}`;
      params.push(eventId);
      paramIndex++;
    }
    
    query += ' ORDER BY created_at DESC LIMIT 100';
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      notifications: result.rows
    });
  } catch (err) {
    console.error('Notification history error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get public notifications for an event (no auth required)
app.get('/api/notifications/event/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    
    // Get unique notifications sent for this event (deduplicated by title/body)
    const result = await pool.query(`
      SELECT DISTINCT ON (title, body) 
        id, event_id, event_name, title, body, url, notification_type, created_at as sent_at
      FROM notification_history
      WHERE event_id = $1
      ORDER BY title, body, created_at DESC
    `, [eventId]);
    
    res.json({
      success: true,
      notifications: result.rows
    });
  } catch (err) {
    console.error('Event notifications error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Disable caching for HTML files to ensure fresh content
app.use((req, res, next) => {
  if (req.url.endsWith('.html') || req.url === '/') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Fix #12: Protect admin.html + superadmin.html behind HTTP Basic Auth (adds browser-level barrier)
// This runs BEFORE express.static so it intercepts the file request first
app.get(['/admin.html', '/admin', '/superadmin.html', '/superadmin'], (req, res, next) => {
  const authHeader = req.headers.authorization;
  const adminSecret = process.env.ADMIN_SECRET || 'natsadmin2026';
  if (authHeader && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const [, pass] = decoded.split(':');
    if (pass === adminSecret) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="NATS Admin"');
  return res.status(401).send('Admin access required');
});

// Fix #13: Block direct access to server-side source files and uploads listing
// These must be declared BEFORE express.static
app.get([
  '/server.js', '/server-https.js',
  '/package.json', '/package-lock.json',
  '/.env', '/.env.example',
  '/adminNotificationQueue.js', '/admin_pdf_export.js',
], (req, res) => {
  res.status(403).json({ error: 'Forbidden' });
});

// Block directory listing of uploads (individual file URLs still work for legitimate use)
app.use('/uploads', (req, res, next) => {
  // Only allow direct file access (path has a filename with extension), not directory browsing
  if (req.path === '/' || !path.extname(req.path)) {
    return res.status(403).json({ error: 'Directory listing not allowed' });
  }
  next();
});

// ── Public shareable board pages (no auth — read-only, shareable via WhatsApp) ─

// ── Shared helpers for /share/* board pages ──────────────────────────────────

// Class colour map — matches CLASS_COLORS in admin.html
const SHARE_CLASS_COLORS = {
  'Cadet':         { bg:'#dc2626', text:'#fff'    },
  'Mini ROK':      { bg:'#f59e0b', text:'#1a1a1a' },
  'Mini ROK U10':  { bg:'#f97316', text:'#fff'    },
  'Mini ROK U/10': { bg:'#f97316', text:'#fff'    },
  'OK-J':          { bg:'#16a34a', text:'#fff'    },
  'OK Junior':     { bg:'#16a34a', text:'#fff'    },
  'OK-N':          { bg:'#0ea5e9', text:'#fff'    },
  'OK National':   { bg:'#0ea5e9', text:'#fff'    },
  'KZ2':           { bg:'#7c3aed', text:'#fff'    },
  'Senior ROK':    { bg:'#1e40af', text:'#fff'    },
};

function shareClassColor(cls) {
  return SHARE_CLASS_COLORS[cls] || { bg:'#475569', text:'#fff' };
}

// Fetch branding images (header/footer) for an event from S3
async function getShareBranding(eventId) {
  try {
    const prefix = eventDocPrefix(eventId, 'branding');
    const data = await s3.send(new ListObjectsV2Command({ Bucket: Z1_BUCKET, Prefix: prefix }));
    const result = { header: null, footer: null };
    for (const obj of (data.Contents || [])) {
      const filename = obj.Key.replace(prefix, '');
      const base = filename.replace(/\.[^.]+$/, '').toLowerCase();
      if (base === 'header') result.header = `${Z1_BASE_URL}/${obj.Key}`;
      if (base === 'footer') result.footer = `${Z1_BASE_URL}/${obj.Key}`;
    }
    return result;
  } catch (_) { return { header: null, footer: null }; }
}

// Shared page CSS — same base for both boards
function shareBoardCSS(accentBg = '#0f172a') {
  return `
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;min-height:100vh;color:#1e293b;}
    .branding-header img,.branding-footer img{width:100%;max-width:100%;display:block;}
    .page-header{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;}
    .page-header h1{color:#fff;font-size:20px;font-weight:700;margin:0;}
    .page-header .sub{color:#94a3b8;font-size:12px;margin-top:3px;}
    .page-header .evtname{color:#f59e0b;font-size:13px;font-weight:600;margin-top:2px;}
    .header-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;}
    .refresh-btn{padding:7px 13px;background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap;}
    .refresh-btn:hover{background:rgba(255,255,255,0.18);}
    .summary-bar{background:#1e3a5f;color:#94a3b8;font-size:12px;padding:6px 20px;text-align:right;}
    .summary-bar strong{color:#f59e0b;}
    .content{padding:16px;max-width:960px;margin:0 auto;}
    .class-group{margin-bottom:24px;}
    .class-title{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;padding:10px 16px;border-radius:6px 6px 0 0;display:flex;align-items:center;justify-content:space-between;}
    .class-stats{font-size:11px;font-weight:500;text-transform:none;letter-spacing:0;opacity:0.75;}
    .table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
    table{width:100%;border-collapse:collapse;background:white;border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);}
    th{background:#0f172a;color:#cbd5e1;padding:10px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;white-space:nowrap;}
    td{padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;vertical-align:middle;}
    tr:last-child td{border-bottom:none;}
    tr.assigned,tr.registered{background:#f0fdf4;}
    tr.unassigned td,tr.unregistered td{color:#94a3b8;}
    .driver-name{font-weight:700;color:#059669;font-size:14px;}
    .race-num{display:inline-block;background:#1e3a5f;color:white;padding:2px 9px;border-radius:12px;font-size:12px;font-weight:700;}
    .draw-num{display:inline-block;background:#f59e0b;color:#1a1a1a;padding:2px 9px;border-radius:4px;font-size:13px;font-weight:800;}
    .mono{font-family:'Courier New',monospace;font-size:12px;letter-spacing:0.03em;}
    .badge-green{display:inline-block;background:#d1fae5;color:#059669;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;}
    .badge-red{display:inline-block;background:#fee2e2;color:#dc2626;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;}
    .badge-amber{display:inline-block;background:#fef3c7;color:#b45309;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;}
    tr.parc-ferme{background:#fffbeb;}
    tr.parc-ferme td{color:#92400e;}
    .time-badge{display:inline-block;background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;}
    .empty{color:#cbd5e1;}
    .page-footer{text-align:center;padding:20px 16px;color:#94a3b8;font-size:12px;border-top:1px solid #e2e8f0;margin-top:8px;}
    .page-footer a{color:#94a3b8;}
    @media(max-width:600px){
      .page-header h1{font-size:16px;}
      td,th{padding:8px 7px;font-size:12px;}
      .draw-num,.driver-name{font-size:12px;}
    }
  `;
}

app.get('/share/engine-draw', async (req, res) => {
  try {
    const selectedEventId = req.query.event_id || 'live';
    const selectedDayLabel = req.query.day_label || '';   // '' = all days
    const reportType = req.query.report_type || 'draw';   // 'draw' or 'possession'
    const isLive = selectedEventId === 'live';
    const isPossession = reportType === 'possession';

    // Always fetch event list for the selector
    const eventsRes = await pool.query(
      `SELECT event_id, event_name, event_date FROM events ORDER BY event_date DESC NULLS LAST`
    );
    const allEvents = eventsRes.rows;

    // Branding: use selected event or latest
    const brandingEventId = isLive
      ? (allEvents.length ? allEvents[0].event_id : null)
      : selectedEventId;
    const branding = brandingEventId ? await getShareBranding(brandingEventId) : { header: null, footer: null };

    const generatedAt = new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' });

    let engines = [];
    let pageTitle = 'Engine Draw Board — Live';
    let eventLabel = 'Live Pool';
    let isHistorical = false;
    let availableDays = [];

    if (isLive) {
      // ── Live: current pool with current assignments ─────────────────────
      const result = await pool.query(`
        SELECT pe.engine_id, pe.draw_number, pe.engine_serial, pe.seal_number,
               pe.carb_number, pe.airbox_number, pe.exhaust_number,
               pe.class, pe.notes, pe.active,
               -- Currently active assignment (not returned)
               re_active.entry_id                                AS active_entry_id,
               d_active.first_name || ' ' || d_active.last_name AS active_driver_name,
               d_active.race_number                              AS active_race_number,
               -- Parc fermé: latest overnight-sealed return for this engine
               pf.overnight_seal                                 AS pf_overnight_seal,
               pf.draw_number                                    AS pf_draw_number,
               d_pf.first_name || ' ' || d_pf.last_name         AS pf_driver_name,
               d_pf.race_number                                  AS pf_race_number
        FROM pool_engines pe
        -- Active (engine not yet returned)
        LEFT JOIN race_entries re_active
               ON UPPER(re_active.engine_serial) = UPPER(pe.engine_serial)
              AND re_active.engine_returned IS NOT TRUE
              AND pe.engine_serial IS NOT NULL
              AND pe.engine_serial <> ''
        LEFT JOIN drivers d_active ON re_active.driver_id = d_active.driver_id
        -- Parc fermé: most recent entry_engine_draws record with overnight seal
        LEFT JOIN LATERAL (
          SELECT eed2.overnight_seal, eed2.draw_number, re2.driver_id
          FROM entry_engine_draws eed2
          JOIN race_entries re2 ON eed2.entry_id = re2.entry_id
          WHERE UPPER(eed2.engine_serial) = UPPER(pe.engine_serial)
            AND eed2.returned = true
            AND eed2.overnight_seal IS NOT NULL
            AND eed2.returned_at >= NOW() - INTERVAL '7 days'
          ORDER BY eed2.returned_at DESC NULLS LAST
          LIMIT 1
        ) pf ON re_active.entry_id IS NULL
        LEFT JOIN drivers d_pf ON pf.driver_id = d_pf.driver_id
        WHERE pe.deleted_at IS NULL AND pe.active = true
        ORDER BY pe.class,
          NULLIF(regexp_replace(pe.draw_number,'[^0-9]','','g'),'')::int NULLS LAST,
          pe.draw_number
      `);
      const seenLiveSerials = new Set();
      engines = result.rows.filter(e => {
        const key = e.engine_serial
          ? `serial:${String(e.engine_serial).toUpperCase()}`
          : `pool:${e.engine_id}`;
        if (seenLiveSerials.has(key)) return false;
        seenLiveSerials.add(key);
        return true;
      }).map(e => ({
        draw_number:          e.pf_draw_number || e.draw_number,
        engine_serial:        e.engine_serial,
        seal_number:          e.seal_number,
        carb_number:          e.carb_number,
        class:                e.class,
        assigned_driver_name: e.active_driver_name || (!e.active_entry_id ? e.pf_driver_name : null) || null,
        assigned_race_number: e.active_race_number || (!e.active_entry_id ? e.pf_race_number : null) || null,
        returned:             false,
        parc_ferme:           !e.active_entry_id && !!e.pf_overnight_seal,
        overnight_seal:       !e.active_entry_id ? (e.pf_overnight_seal || null) : null
      }));
    } else {
      // ── Historical: draws from entry_engine_draws for this event ────────
      isHistorical = true;
      const evt = allEvents.find(e => e.event_id === selectedEventId);
      if (evt) {
        eventLabel = `${evt.event_name} — ${new Date(evt.event_date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}`;
        pageTitle  = `Engine Draw Board — ${evt.event_name}`;
      }

      // Fetch distinct day labels for this event (for the day dropdown)
      const daysRes = await pool.query(`
        SELECT DISTINCT COALESCE(eed.day_label, TO_CHAR(eed.assigned_at AT TIME ZONE 'Africa/Johannesburg', 'FMDay DD Mon YYYY')) AS day_label,
               MIN(eed.assigned_at) AS first_at
        FROM entry_engine_draws eed
        JOIN race_entries re ON eed.entry_id = re.entry_id
        WHERE re.event_id = $1
        GROUP BY 1
        ORDER BY MIN(eed.assigned_at)
      `, [selectedEventId]);
      availableDays = daysRes.rows.map(r => r.day_label);

      // Build query conditions
      const params = [selectedEventId];
      let extraWhere = '';
      if (selectedDayLabel) {
        params.push(selectedDayLabel);
        extraWhere += ` AND COALESCE(eed.day_label, TO_CHAR(eed.assigned_at AT TIME ZONE 'Africa/Johannesburg', 'FMDay DD Mon YYYY')) = $${params.length}`;
      }
      if (isPossession) {
        extraWhere += ` AND eed.overnight_seal IS NOT NULL AND (eed.session_type = 'OVERNIGHT' OR eed.returned = true)`;
      }

      const result = await pool.query(`
        SELECT
          eed.draw_number,
          eed.engine_serial,
          COALESCE(eed.day_label, TO_CHAR(eed.assigned_at AT TIME ZONE 'Africa/Johannesburg', 'FMDay DD Mon YYYY')) AS day_label,
          eed.session_type,
          eed.assigned_at,
          eed.returned,
          eed.returned_at,
          eed.overnight_seal,
          eed.overnight_seal_verified_at,
          d.first_name || ' ' || d.last_name AS assigned_driver_name,
          d.race_number                        AS assigned_race_number,
          COALESCE(pe.class, re.race_class)    AS class,
          pe.seal_number,
          pe.carb_number
        FROM entry_engine_draws eed
        JOIN race_entries re ON eed.entry_id = re.entry_id
        JOIN drivers d       ON re.driver_id = d.driver_id
        LEFT JOIN pool_engines pe
               ON UPPER(pe.engine_serial) = UPPER(eed.engine_serial)
              AND pe.deleted_at IS NULL
        WHERE re.event_id = $1${extraWhere}
        ORDER BY eed.assigned_at,
          COALESCE(pe.class, re.race_class),
          NULLIF(regexp_replace(eed.draw_number,'[^0-9]','','g'),'')::int NULLS LAST,
          eed.draw_number
      `, params);
      engines = result.rows;

      // Also check for engines currently booked out in race_entries but with no
      // open entry_engine_draws record (e.g. collectEngine ran before this fix was deployed)
      const missingRes = await pool.query(`
        SELECT re.entry_id, re.engine_serial,
               d.first_name || ' ' || d.last_name AS assigned_driver_name,
               d.race_number                        AS assigned_race_number,
               COALESCE(pe.class, re.race_class)    AS class,
               pe.seal_number, pe.carb_number,
               pe.draw_number
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        LEFT JOIN pool_engines pe
               ON UPPER(pe.engine_serial) = UPPER(re.engine_serial) AND pe.deleted_at IS NULL
        WHERE re.event_id = $1
          AND re.engine_serial IS NOT NULL
          AND (re.engine_returned = false OR re.engine_returned IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM entry_engine_draws eed2
            WHERE eed2.entry_id = re.entry_id
              AND eed2.returned = false
          )
      `, [selectedEventId]);

      if (missingRes.rows.length > 0 && !isPossession) {
        const missingEngines = missingRes.rows.map(r => ({
          draw_number:          r.draw_number || '?',
          engine_serial:        r.engine_serial,
          seal_number:          r.seal_number,
          carb_number:          r.carb_number,
          class:                r.class,
          day_label:            'BOOKED OUT',
          assigned_driver_name: r.assigned_driver_name,
          assigned_race_number: r.assigned_race_number,
          returned:             false,
          _orphan:              true
        }));
        // Only include if "All Days" or "BOOKED OUT" day selected
        if (!selectedDayLabel || selectedDayLabel === 'BOOKED OUT') {
          engines = [...engines, ...missingEngines];
        }
        // Always add BOOKED OUT to the day dropdown if there are orphaned engines
        if (!availableDays.includes('BOOKED OUT')) {
          availableDays.push('BOOKED OUT');
        }
      }
    }

    const assignedCount = engines.filter(e => e.assigned_driver_name && !e.returned).length;

    const eventOptions = allEvents.map(e => {
      const d = new Date(e.event_date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
      const sel = e.event_id === selectedEventId ? ' selected' : '';
      return `<option value="${e.event_id}"${sel}>${e.event_name} — ${d}</option>`;
    }).join('');

    // Day options (only for historical mode)
    const dayOptionsHTML = isHistorical && availableDays.length > 0 ? `
      <select name="day_label" onchange="this.form.submit()" style="padding:7px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;background:white;cursor:pointer;">
        <option value="">All Days</option>
        ${availableDays.map(d => `<option value="${d}"${d === selectedDayLabel ? ' selected' : ''}>${d}</option>`).join('')}
      </select>` : '';

    // Report type toggle (only for historical mode)
    const reportTypeHTML = isHistorical ? `
      <span style="font-size:12px;font-weight:700;color:#1e293b;white-space:nowrap;margin-left:6px;">Report:</span>
      <a href="/share/engine-draw?event_id=${selectedEventId}&day_label=${encodeURIComponent(selectedDayLabel)}&report_type=draw"
         style="padding:5px 12px;border-radius:5px;font-size:12px;font-weight:700;text-decoration:none;border:1px solid #cbd5e1;${reportType==='draw'?'background:#1e3a5f;color:white;':'background:white;color:#334155;'}">
        &#128195; Draw Report</a>
      <a href="/share/engine-draw?event_id=${selectedEventId}&day_label=${encodeURIComponent(selectedDayLabel)}&report_type=possession"
         style="padding:5px 12px;border-radius:5px;font-size:12px;font-weight:700;text-decoration:none;border:1px solid #cbd5e1;${reportType==='possession'?'background:#b45309;color:white;':'background:white;color:#334155;'}">
        &#128274; Overnight Possession</a>` : '';

    // ── Build content HTML ──────────────────────────────────────────────────
    let classGroupsHTML = '';

    if (engines.length === 0) {
      const emptyMsg = isPossession
        ? 'No overnight possession records found for this selection.<br><small style="font-size:12px;">Engines are listed here after they are returned with an overnight seal.</small>'
        : 'No engine draw records found for this event or day.';
      classGroupsHTML = `<div style="text-align:center;padding:60px 20px;color:#64748b;font-family:sans-serif;">
           <div style="font-size:40px;margin-bottom:12px;">${isPossession ? '&#128274;' : '&#128237;'}</div>
           <div style="font-size:16px;font-weight:600;">${emptyMsg}</div>
         </div>`;
    } else if (isHistorical && isPossession) {
      // ── Possession report: flat list grouped by class (day already filtered)
      const possessionLabel = selectedDayLabel ? ` — ${selectedDayLabel}` : '';
      const classes = [...new Set(engines.map(e => e.class || 'Unclassified'))];
      classGroupsHTML = `<div class="day-section last-day">
        <div class="day-header" style="background:#92400e;">
          <span class="day-title">&#128274; OVERNIGHT POSSESSION REPORT${possessionLabel}</span>
          <span class="day-stats">${engines.length} engine${engines.length !== 1 ? 's' : ''} sealed</span>
        </div>
        ${classes.map(cls => {
          const { bg, text } = shareClassColor(cls);
          const clsEngines = engines.filter(e => (e.class || 'Unclassified') === cls);
          const rows = clsEngines.map(e => {
            const retAt = e.returned_at ? new Date(e.returned_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit' }) : '—';
            const verified = e.overnight_seal_verified_at ? ' &#10003;' : '';
            return `<tr>
              <td><span class="draw-num" style="background:${bg};color:${text};">${e.draw_number || '—'}</span></td>
              <td><span class="driver-name">${e.assigned_driver_name || '—'}</span></td>
              <td>${e.assigned_race_number ? `<span class="race-num">#${e.assigned_race_number}</span>` : '<span class="empty">—</span>'}</td>
              <td class="mono">${e.engine_serial || '—'}</td>
              <td class="mono">${e.carb_number || '—'}</td>
              <td class="mono" style="font-weight:800;font-size:14px;color:#d97706;background:#fffbeb;">${e.overnight_seal || '—'}${verified}</td>
              <td class="mono" style="font-size:11px;color:#64748b;">${retAt}</td>
            </tr>`;
          }).join('');
          return `<div class="class-group">
            <div class="class-title" style="background:${bg};color:${text};">${cls} <span class="class-stats">${clsEngines.length} sealed</span></div>
            <div class="table-scroll"><table>
              <thead><tr><th>Draw #</th><th>Driver</th><th>Race #</th><th>Engine Serial</th><th>Carb #</th><th style="background:#fffbeb;color:#92400e;">&#128274; Overnight Seal #</th><th>Returned At</th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div>
          </div>`;
        }).join('')}
      </div>`;
    } else if (isHistorical) {
      // Historical draw report: group by day → then by class within each day
      const days = [...new Set(engines.map(e => e.day_label || 'Unknown'))];
      // Sort days by the earliest assigned_at in each group
      const dayOrder = {};
      engines.forEach(e => {
        const d = e.day_label || 'Unknown';
        if (!dayOrder[d] || new Date(e.assigned_at) < new Date(dayOrder[d])) dayOrder[d] = e.assigned_at;
      });
      days.sort((a, b) => new Date(dayOrder[a]) - new Date(dayOrder[b]));

      classGroupsHTML = days.map((day, dayIdx) => {
        const dayEngines = engines.filter(e => (e.day_label || 'Unknown') === day);
        const classes = [...new Set(dayEngines.map(e => e.class || 'Unclassified'))];
        const isLastDay = dayIdx === days.length - 1;

        const classSections = classes.map(cls => {
          const { bg, text } = shareClassColor(cls);
          const clsEngines = dayEngines.filter(e => (e.class || 'Unclassified') === cls);
          const rows = clsEngines.map(e => {
            const returned = !!e.returned;
            const assignedAt = e.assigned_at ? new Date(e.assigned_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit' }) : '';
            return `<tr class="${returned ? 'unassigned' : 'assigned'}">
              <td><span class="draw-num" style="background:${bg};color:${text};">${e.draw_number || '—'}</span></td>
              <td><span class="driver-name">${e.assigned_driver_name || '—'}</span></td>
              <td>${e.assigned_race_number ? `<span class="race-num">#${e.assigned_race_number}</span>` : '<span class="empty">—</span>'}</td>
              <td class="mono">${e.engine_serial || '—'}</td>
              <td class="mono">${e.carb_number || '—'}</td>
              <td class="mono">${e.seal_number || '—'}</td>
              <td style="font-size:11px;color:#475569;font-weight:600;">${e.session_type || '—'}</td>
              <td class="mono" style="font-size:11px;color:#64748b;">${assignedAt}</td>
              <td>${returned ? '<span class="badge-red">Returned</span>' : '<span class="badge-green">Assigned</span>'}</td>
            </tr>`;
          }).join('');
          const assignedInClass = clsEngines.filter(e => !e.returned).length;
          return `<div class="class-group">
            <div class="class-title" style="background:${bg};color:${text};">${cls} <span class="class-stats">${assignedInClass}/${clsEngines.length} assigned</span></div>
            <div class="table-scroll"><table>
              <thead><tr><th>Draw #</th><th>Driver</th><th>Race #</th><th>Engine Serial</th><th>Carb #</th><th>Seal #</th><th>Mode</th><th>Time</th><th>Status</th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div>
          </div>`;
        }).join('');

        const dayTotal   = dayEngines.length;
        const dayAssigned = dayEngines.filter(e => !e.returned).length;
        return `<div class="day-section${isLastDay ? ' last-day' : ''}">
          <div class="day-header" style="${day === 'BOOKED OUT' ? 'background:#92400e;' : ''}">
            <span class="day-title">${day === 'BOOKED OUT' ? '&#9888; BOOKED OUT (no draw record)' : day}</span>
            <span class="day-stats">${dayAssigned}/${dayTotal} assignments</span>
          </div>
          ${classSections}
        </div>`;
      }).join('');
    } else {
      // Live: group by class
      const classes = [...new Set(engines.map(e => e.class || 'Unclassified'))];
      classGroupsHTML = classes.map(cls => {
        const { bg, text } = shareClassColor(cls);
        const clsEngines = engines.filter(e => (e.class || 'Unclassified') === cls);
        const rows = clsEngines.map(e => {
          let statusCell;
          if (e.parc_ferme) {
            statusCell = `<span class="badge-amber">&#128274; PARC FERM&#201;</span>`;
          } else if (e.assigned_driver_name) {
            statusCell = `<span class="badge-green">Assigned</span>`;
          } else {
            statusCell = `<span class="badge-red">Available</span>`;
          }
          const overnightSealCell = e.overnight_seal
            ? `<td class="mono" style="font-weight:800;color:#d97706;background:#fffbeb;">${e.overnight_seal}</td>`
            : `<td class="mono" style="color:#94a3b8;">—</td>`;
          return `<tr class="${e.parc_ferme ? 'parc-ferme' : (e.assigned_driver_name ? 'assigned' : 'unassigned')}">
            <td><span class="draw-num" style="background:${bg};color:${text};">${e.draw_number || '—'}</span></td>
            <td>${e.assigned_driver_name ? `<span class="driver-name">${e.assigned_driver_name}</span>` : '<span class="empty">—</span>'}</td>
            <td>${e.assigned_race_number ? `<span class="race-num">#${e.assigned_race_number}</span>` : '<span class="empty">—</span>'}</td>
            <td class="mono">${e.engine_serial || '—'}</td>
            <td class="mono">${e.carb_number || '—'}</td>
            <td class="mono">${e.seal_number || '—'}</td>
            ${overnightSealCell}
            <td>${statusCell}</td>
          </tr>`;
        }).join('');
        const assignedInClass = clsEngines.filter(e => e.assigned_driver_name && !e.parc_ferme).length;
        const parcFermeCount  = clsEngines.filter(e => e.parc_ferme).length;
        const statsLabel = parcFermeCount > 0
          ? `${assignedInClass} assigned · ${parcFermeCount} &#128274; parc ferm&#233;`
          : `${assignedInClass}/${clsEngines.length} assigned`;
        return `<div class="class-group">
          <div class="class-title" style="background:${bg};color:${text};">${cls} <span class="class-stats">${statsLabel}</span></div>
          <div class="table-scroll"><table>
            <thead><tr><th>Draw #</th><th>Driver</th><th>Race #</th><th>Engine Serial</th><th>Carb #</th><th>Seal #</th><th style="background:#fffbeb;color:#92400e;">&#128274; Night Seal</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </div>`;
      }).join('');
    }

    // Build event selector bar CSS + HTML
    const selectorBarHTML = `
      <div class="event-selector-bar no-print">
        <form method="get" action="/share/engine-draw" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="font-size:12px;font-weight:700;color:#1e293b;white-space:nowrap;">View draw for:</label>
          <select name="event_id" onchange="this.form.submit()" style="padding:7px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;background:white;cursor:pointer;min-width:260px;">
            <option value="live"${isLive ? ' selected' : ''}>&#9679; Live Pool (current)</option>
            <optgroup label="Past Events">
              ${eventOptions}
            </optgroup>
          </select>
          ${dayOptionsHTML}
          <input type="hidden" name="report_type" value="${reportType}">
          <span style="font-size:12px;color:#64748b;">${isLive ? 'Showing current engine assignments' : `Historical draw: ${eventLabel}`}</span>
        </form>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          ${reportTypeHTML}
          <button onclick="window.print()" style="padding:7px 18px;background:#1e3a5f;color:white;border:none;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;margin-left:8px;">&#128438; Print / Save PDF</button>
        </div>
      </div>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>
  <link rel="icon" type="image/png" href="/rok-cup-favicon.png">
  <style>
    ${shareBoardCSS()}
    .event-selector-bar {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; padding: 10px 16px; background: #f8fafc;
      border-bottom: 1px solid #e2e8f0; flex-wrap: wrap;
    }
    @media print {
      .no-print { display: none !important; }
      body { background: white !important; }
      .content { padding: 0 !important; max-width: 100% !important; }
      .day-section { page-break-after: always; break-after: page; margin-bottom: 0 !important; }
      .day-section.last-day { page-break-after: avoid; break-after: avoid; }
      .class-group { page-break-inside: avoid; break-inside: avoid; }
      table { box-shadow: none !important; }
      .summary-bar { display: none !important; }
    }
    .day-section { margin-bottom: 32px; }
    .day-header {
      display: flex; align-items: center; justify-content: space-between;
      background: #0f172a; color: #f8fafc;
      padding: 10px 18px; margin-bottom: 12px;
      font-size: 15px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
    }
    .day-stats { font-size: 12px; font-weight: 500; opacity: 0.65; text-transform: none; letter-spacing: 0; }
  </style>
</head>
<body>
  ${selectorBarHTML}
  ${branding.header ? `<div class="branding-header"><img src="${branding.header}" alt="Event Header"></div>` : ''}
  <div class="page-header">
    <div>
      <h1>${isPossession ? '&#128274; Overnight Possession Report' : '&#128295; Engine Draw Board'}</h1>
      <div class="sub">${isLive ? 'Live Pool' : eventLabel}${selectedDayLabel ? ` &bull; ${selectedDayLabel}` : ''} &bull; Generated: ${generatedAt}</div>
    </div>
    <div class="header-right no-print">
      ${isLive ? `<a href="/share/engine-draw" class="refresh-btn">&#128260; Refresh</a>` : ''}
    </div>
  </div>
  <div class="summary-bar">
    ${isPossession
      ? `<strong>${engines.length}</strong> engine${engines.length !== 1 ? 's' : ''} sealed in overnight possession`
      : `<strong>${assignedCount}</strong> of <strong>${engines.length}</strong> engines assigned`}
    ${isHistorical ? ' <span style="margin-left:12px;font-size:11px;opacity:0.75;">(historical record)</span>' : ''}
  </div>
  <div class="content">${classGroupsHTML}</div>
  ${branding.footer ? `<div class="branding-footer"><img src="${branding.footer}" alt="Event Footer"></div>` : ''}
  <div class="page-footer">NATS Race Management System &bull; <a href="https://rokthenats.co.za">rokthenats.co.za</a></div>
</body></html>`);
  } catch (err) {
    console.error('GET /share/engine-draw error:', err.message);
    res.status(500).send(`<h2 style="font-family:sans-serif;padding:40px;color:#dc2626;">Error loading engine draw: ${err.message}</h2>`);
  }
});

app.get('/share/tyre-board', async (req, res) => {
  try {
    const { event_id } = req.query;

    // No event selected — show event picker
    if (!event_id) {
      const evtRes = await pool.query(`
        SELECT event_id, event_name, event_date FROM events
        ORDER BY event_date DESC NULLS LAST LIMIT 20
      `);
      const options = evtRes.rows.map(e => {
        const dateStr = e.event_date ? new Date(e.event_date).toLocaleDateString('en-ZA', { day:'numeric', month:'short', year:'numeric' }) : '';
        return `<a href="/share/tyre-board?event_id=${encodeURIComponent(e.event_id)}" class="event-link">
          <strong>${e.event_name}</strong><span class="event-date">${dateStr}</span>
        </a>`;
      }).join('');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!DOCTYPE html><html lang="en"><head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
        <title>NATS Tyre Board — Select Event</title>
        <link rel="icon" type="image/png" href="/rok-cup-favicon.png">
        <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;min-height:100vh;}
        .page-header{background:linear-gradient(135deg,#0f172a,#1e3a5f);padding:20px;}
        .page-header h1{color:#fff;font-size:20px;font-weight:700;}.page-header .sub{color:#94a3b8;font-size:12px;margin-top:4px;}
        .content{padding:24px;max-width:600px;margin:0 auto;}.title{font-size:15px;font-weight:700;color:#1e293b;margin-bottom:14px;}
        .event-link{display:flex;justify-content:space-between;align-items:center;background:white;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin-bottom:10px;text-decoration:none;color:#1e293b;transition:border-color 0.15s;}
        .event-link:hover{border-color:#f59e0b;background:#fffbeb;}.event-link strong{font-size:14px;}
        .event-date{font-size:12px;color:#64748b;}</style>
        </head><body>
        <div class="page-header"><h1>🏁 Tyre Registration Board</h1><div class="sub">Select an event to view registrations</div></div>
        <div class="content"><div class="title">Select Event</div>${options || '<p style="color:#94a3b8;font-size:14px;">No events found</p>'}</div>
        </body></html>`);
    }

    const [entryRes, evtRes, branding] = await Promise.all([
      pool.query(`
        SELECT r.entry_id, r.race_class,
               r.tyre_front_left, r.tyre_front_right, r.tyre_rear_left, r.tyre_rear_right,
               r.tyre_sets, r.tyres_registered_at,
               d.first_name, d.last_name, d.race_number
        FROM race_entries r
        LEFT JOIN drivers d ON r.driver_id = d.driver_id
        WHERE r.event_id = $1
          AND r.entry_status NOT IN ('cancelled','incomplete')
        ORDER BY r.race_class, d.race_number::int NULLS LAST, d.last_name
      `, [event_id]),
      pool.query(`SELECT event_name, event_date FROM events WHERE event_id = $1`, [event_id]),
      getShareBranding(event_id),
    ]);

    const evt = evtRes.rows[0] || {};
    const eventLabel = evt.event_name || 'Event';
    const eventDate = evt.event_date ? new Date(evt.event_date).toLocaleDateString('en-ZA', { day:'numeric', month:'long', year:'numeric' }) : '';
    const generatedAt = new Date().toLocaleString('en-ZA', { timeZone:'Africa/Johannesburg', dateStyle:'medium', timeStyle:'short' });

    const entries = entryRes.rows;
    const registeredEntries = entries.filter(e => e.tyre_front_left || (e.tyre_sets && e.tyre_sets.length));
    const classes = [...new Set(entries.map(e => e.race_class || 'General'))];

    const classGroupsHTML = classes.map(cls => {
      const { bg, text } = shareClassColor(cls);
      const clsEntries = entries.filter(e => (e.race_class || 'General') === cls);
      const rows = clsEntries.map(e => {
        const hasTyres = !!(e.tyre_front_left || (e.tyre_sets && e.tyre_sets.length));
        let sets = [];
        try { sets = Array.isArray(e.tyre_sets) ? e.tyre_sets : (e.tyre_sets ? JSON.parse(e.tyre_sets) : []); } catch(_) {}
        const displaySet = sets.length > 0 ? sets[sets.length - 1] : { fl: e.tyre_front_left, fr: e.tyre_front_right, rl: e.tyre_rear_left, rr: e.tyre_rear_right };
        const regTime = e.tyres_registered_at ? new Date(e.tyres_registered_at).toLocaleTimeString('en-ZA', { timeZone:'Africa/Johannesburg', hour:'2-digit', minute:'2-digit' }) : null;
        const multiSet = sets.length > 1 ? `<span style="background:#fef3c7;color:#92400e;font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;margin-left:4px;">${sets.length} sets</span>` : '';

        if (hasTyres && displaySet) {
          return `<tr class="registered">
            <td>${e.race_number ? `<span class="race-num">#${e.race_number}</span>` : '—'}</td>
            <td class="driver-name">${e.first_name || ''} ${e.last_name || ''}</td>
            <td class="mono">${displaySet.fl || '—'}</td>
            <td class="mono">${displaySet.fr || '—'}</td>
            <td class="mono">${displaySet.rl || '—'}</td>
            <td class="mono">${displaySet.rr || '—'}</td>
            <td>${regTime ? `<span class="time-badge">${regTime}</span>` : '—'}${multiSet}</td>
          </tr>`;
        } else {
          return `<tr class="unregistered">
            <td>${e.race_number ? `<span class="race-num" style="opacity:0.4">#${e.race_number}</span>` : '—'}</td>
            <td style="color:#94a3b8">${e.first_name || ''} ${e.last_name || ''}</td>
            <td colspan="4" style="color:#cbd5e1;font-size:12px;font-style:italic;">Not yet registered</td>
            <td><span class="badge-red">Pending</span></td>
          </tr>`;
        }
      }).join('');
      const regInClass = clsEntries.filter(e => e.tyre_front_left || (e.tyre_sets && e.tyre_sets.length)).length;
      return `<div class="class-group">
        <div class="class-title" style="background:${bg};color:${text};">${cls} <span class="class-stats">${regInClass}/${clsEntries.length} registered</span></div>
        <div class="table-scroll">
        <table>
          <thead><tr><th>Race #</th><th>Driver</th><th>FL</th><th>FR</th><th>RL</th><th>RR</th><th>Time</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
    }).join('');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NATS Tyre Board — ${eventLabel}</title>
  <link rel="icon" type="image/png" href="/rok-cup-favicon.png">
  <style>${shareBoardCSS()}</style>
</head>
<body>
  ${branding.header ? `<div class="branding-header"><img src="${branding.header}" alt="Event Header"></div>` : ''}
  <div class="page-header">
    <div>
      <h1>🏁 Tyre Registration Board</h1>
      <div class="evtname">${eventLabel}${eventDate ? ' &bull; ' + eventDate : ''}</div>
      <div class="sub">Generated: ${generatedAt}</div>
    </div>
    <div class="header-right">
      <a href="/share/tyre-board?event_id=${encodeURIComponent(event_id)}" class="refresh-btn">🔄 Refresh</a>
      <a href="/share/tyre-board" class="refresh-btn" style="font-size:11px;padding:5px 10px;opacity:0.7;">↩ Events</a>
    </div>
  </div>
  <div class="summary-bar">
    <strong>${registeredEntries.length}</strong> of <strong>${entries.length}</strong> drivers registered tyres
  </div>
  <div class="content">${classGroupsHTML || '<p style="padding:40px;color:#94a3b8;text-align:center;">No entries found for this event.</p>'}</div>
  ${branding.footer ? `<div class="branding-footer"><img src="${branding.footer}" alt="Event Footer"></div>` : ''}
  <div class="page-footer">NATS Race Management System &bull; <a href="https://rokthenats.co.za">rokthenats.co.za</a></div>
</body></html>`);
  } catch (err) {
    console.error('GET /share/tyre-board error:', err.message);
    res.status(500).send(`<h2 style="font-family:sans-serif;padding:40px;color:#dc2626;">Error loading tyre board: ${err.message}</h2>`);
  }
});

// Clean URL: /winternats opens index.html and JS auto-opens the Race Specific tab
app.get('/winternats', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve static files from the project root (AFTER all API routes)
// Block server-side source files from being served directly
app.use((req, res, next) => {
  const blocked = /^\/(\.env|server\.js|package(?:-lock)?\.json|.*\.bat|.*\.sh|logs\/|uploads\/)/.test(req.path);
  if (blocked) return res.status(403).send('Forbidden');
  next();
});
app.use(express.static(path.join(__dirname, '.')));

// Fix #17: safeError helper — never expose raw error messages in production
const safeError = (err, fallback = 'An unexpected error occurred') => {
  const isDev = process.env.NODE_ENV === 'development';
  return isDev ? (err?.message || fallback) : fallback;
};

// =========================================================
// EXPRESS ERROR HANDLING MIDDLEWARE - Catch all route errors
// =========================================================
app.use((err, req, res, next) => {
  console.error('❌ Express error:', err.message);
  console.error('Stack:', err.stack);
  const isDev = process.env.NODE_ENV === 'development';
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error',
    ...(isDev && { detail: err.message })
  });
});

// ============= EVENT DOCUMENTS (Google Drive / JSON Config) =============
// Reads from event-documents.json - no file uploads needed!
// Static class-level documents that always appear in their respective folders
// regardless of which event is loaded. Add new season docs here.
const STATIC_CLASS_DOCS = [
  {
    display_name: 'Race Day Instructions — Autumn Nats 2026',
    document_type: 'Mini ROK',
    file_path: '/documents/raceday/RDOC002-mini-rok-autumn-nats-2026-race-day-instructions.html',
    preview_url: '/documents/raceday/RDOC002-mini-rok-autumn-nats-2026-race-day-instructions.html',
    category: 'mini',
    icon: '📄',
    isStatic: true
  },
  {
    display_name: 'Race Day Instructions — Autumn Nats 2026',
    document_type: 'OK Junior',
    file_path: '/documents/raceday/RDOC003-ok-junior-autumn-nats-2026-race-day-instructions.html',
    preview_url: '/documents/raceday/RDOC003-ok-junior-autumn-nats-2026-race-day-instructions.html',
    category: 'okj',
    icon: '📄',
    isStatic: true
  },
  {
    display_name: 'Race Day Instructions — Autumn Nats 2026',
    document_type: 'OK National',
    file_path: '/documents/raceday/RDOC004-ok-national-autumn-nats-2026-race-day-instructions.html',
    preview_url: '/documents/raceday/RDOC004-ok-national-autumn-nats-2026-race-day-instructions.html',
    category: 'okn',
    icon: '📄',
    isStatic: true
  },
  {
    display_name: 'Tyre Collection Instructions — Autumn Nats 2026',
    document_type: 'General',
    file_path: '/documents/raceday/RDOC005-tyre-collection-autumn-nats-2026.html',
    preview_url: '/documents/raceday/RDOC005-tyre-collection-autumn-nats-2026.html',
    category: 'general',
    icon: '📄',
    isStatic: true
  },
  {
    display_name: 'Controlled Fuel Instructions — Autumn Nats 2026',
    document_type: 'General',
    file_path: '/documents/raceday/RDOC006-controlled-fuel-autumn-nats-2026.html',
    preview_url: '/documents/raceday/RDOC006-controlled-fuel-autumn-nats-2026.html',
    category: 'general',
    icon: '📄',
    isStatic: true
  },
  {
    display_name: 'Self-Declaration Scrutineering Form — Autumn Nats 2026',
    document_type: 'General',
    file_path: '/documents/raceday/RDOC007-self-declaration-scrutineering-autumn-nats-2026.html',
    preview_url: '/documents/raceday/RDOC007-self-declaration-scrutineering-autumn-nats-2026.html',
    category: 'general',
    icon: '📋',
    isStatic: true
  },
  {
    display_name: 'Sticker Placement for Scrutineering — Autumn Nats 2026',
    document_type: 'General',
    file_path: '/documents/raceday/RDOC008-sticker-placement-scrutineering-autumn-nats-2026.html',
    preview_url: '/documents/raceday/RDOC008-sticker-placement-scrutineering-autumn-nats-2026.html',
    category: 'general',
    icon: '🏷️',
    isStatic: true
  },
  // ── WINTER NATS 2026 — FK · 10–12 July 2026 ──
  {
    display_name: 'Race Day Instructions — Winter Nats 2026',
    document_type: 'Mini ROK',
    file_path: '/documents/raceday/RDOC009-mini-rok-winter-nats-2026-race-day-instructions.html',
    preview_url: '/documents/raceday/RDOC009-mini-rok-winter-nats-2026-race-day-instructions.html',
    category: 'mini',
    icon: '📄',
    isStatic: true
  },
  {
    display_name: 'Race Day Instructions — Winter Nats 2026',
    document_type: 'OK Junior',
    file_path: '/documents/raceday/RDOC010-ok-junior-winter-nats-2026-race-day-instructions.html',
    preview_url: '/documents/raceday/RDOC010-ok-junior-winter-nats-2026-race-day-instructions.html',
    category: 'okj',
    icon: '📄',
    isStatic: true
  },
  {
    display_name: 'Race Day Instructions — Winter Nats 2026',
    document_type: 'OK National',
    file_path: '/documents/raceday/RDOC011-ok-national-winter-nats-2026-race-day-instructions.html',
    preview_url: '/documents/raceday/RDOC011-ok-national-winter-nats-2026-race-day-instructions.html',
    category: 'okn',
    icon: '📄',
    isStatic: true
  },
  {
    display_name: 'Tyre Collection Instructions — Winter Nats 2026',
    document_type: 'General',
    file_path: '/documents/raceday/RDOC012-tyre-collection-winter-nats-2026.html',
    preview_url: '/documents/raceday/RDOC012-tyre-collection-winter-nats-2026.html',
    category: 'general',
    icon: '📄',
    isStatic: true
  },
  {
    display_name: 'Controlled Fuel Instructions — Winter Nats 2026',
    document_type: 'General',
    file_path: '/documents/raceday/RDOC013-controlled-fuel-winter-nats-2026.html',
    preview_url: '/documents/raceday/RDOC013-controlled-fuel-winter-nats-2026.html',
    category: 'general',
    icon: '📄',
    isStatic: true
  },
  {
    display_name: 'Self-Declaration Scrutineering Form — Winter Nats 2026',
    document_type: 'General',
    file_path: '/documents/raceday/RDOC014-self-declaration-scrutineering-winter-nats-2026.html',
    preview_url: '/documents/raceday/RDOC014-self-declaration-scrutineering-winter-nats-2026.html',
    category: 'general',
    icon: '📋',
    isStatic: true
  },
  {
    display_name: 'Sticker Placement for Scrutineering — Winter Nats 2026',
    document_type: 'General',
    file_path: '/documents/raceday/RDOC015-sticker-placement-scrutineering-winter-nats-2026.html',
    preview_url: '/documents/raceday/RDOC015-sticker-placement-scrutineering-winter-nats-2026.html',
    category: 'general',
    icon: '🏷️',
    isStatic: true
  },
  {
    display_name: 'Friday Timetable — Winter Nats 2026',
    document_type: 'General',
    file_path: '/documents/raceday/RDOC016-friday-winter-nats-2026-timetable.pdf',
    preview_url: '/documents/raceday/RDOC016-friday-winter-nats-2026-timetable.pdf',
    category: 'general',
    icon: '📅',
    isStatic: true
  },
  {
    display_name: 'Saturday Timetable — Winter Nats 2026',
    document_type: 'General',
    file_path: '/documents/raceday/RDOC017-saturday-winter-nats-2026-timetable.pdf',
    preview_url: '/documents/raceday/RDOC017-saturday-winter-nats-2026-timetable.pdf',
    category: 'general',
    icon: '📅',
    isStatic: true
  },
  {
    display_name: 'Sunday Timetable — Winter Nats 2026',
    document_type: 'General',
    file_path: '/documents/raceday/RDOC018-sunday-winter-nats-2026-timetable.pdf',
    preview_url: '/documents/raceday/RDOC018-sunday-winter-nats-2026-timetable.pdf',
    category: 'general',
    icon: '📅',
    isStatic: true
  }
];

app.get('/api/events/:eventId/docs', async (req, res) => {
  try {
    const { eventId } = req.params;
    const fs = require('fs');
    const path = require('path');

    // ── 1. Check S3 first (admin-uploaded files via admin panel) ─────────────
    const S3_FOLDER_META = {
      'official':  { category: 'official', label: 'OFFICIAL' },
      'general':   { category: 'general',  label: 'General' },
      'cadet':     { category: 'cadet',    label: 'Cadet / Mini ROK U10' },
      'mini-rok':  { category: 'mini',     label: 'Mini ROK' },
      'ok-j':      { category: 'okj',      label: 'OK-J' },
      'ok-n':      { category: 'okn',      label: 'OK-N' }
    };
    try {
      const s3Docs = [];
      const s3ListAbortSignal = AbortSignal.timeout(2500);
      for (const [folderKey, meta] of Object.entries(S3_FOLDER_META)) {
        const prefix = eventDocPrefix(eventId, folderKey);
        const listCmd = new ListObjectsV2Command({ Bucket: Z1_BUCKET, Prefix: prefix });
        const data = await s3.send(listCmd, { abortSignal: s3ListAbortSignal });
        for (const obj of (data.Contents || [])) {
          const filename = obj.Key.replace(prefix, '');
          if (!filename || filename.startsWith('.')) continue;
          const ext = path.extname(filename).toLowerCase();
          let icon = '📄';
          if (ext === '.pdf') icon = '📕';
          else if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) icon = '🖼️';
          else if (['.doc', '.docx'].includes(ext)) icon = '📝';
          else if (['.xls', '.xlsx'].includes(ext)) icon = '📊';
          const fileUrl = `${Z1_BASE_URL}/${obj.Key}`;
          s3Docs.push({
            display_name: path.basename(filename, ext).replace(/[-_]/g, ' '),
            document_type: meta.label,
            file_path: fileUrl,
            preview_url: fileUrl,
            category: meta.category,
            icon
          });
        }
      }
      if (s3Docs.length > 0) {
        const merged = [...s3Docs, ...STATIC_CLASS_DOCS];
        return res.json({ success: true, documents: merged, count: merged.length, source: 's3' });
      }
    } catch (s3Err) {
      console.warn('S3 doc list failed, falling back to filesystem:', s3Err.message);
    }

    // ── 2. Scan filesystem (legacy local uploads) ─────────────────────────────
    const fsDocFolderMap = {
      'official':  { category: 'official',  label: 'OFFICIAL' },
      'general':   { category: 'general',   label: 'General' },
      'cadet':     { category: 'cadet',     label: 'Cadet / Mini ROK U10' },
      'mini-rok':  { category: 'mini',      label: 'Mini ROK' },
      'ok-j':      { category: 'okj',       label: 'OK-J' },
      'ok-n':      { category: 'okn',       label: 'OK-N' }
    };
    const baseDir = path.join(__dirname, 'uploads', 'event-docs', eventId);
    const fsDocs = [];
    if (fs.existsSync(baseDir)) {
      for (const [folderDir, meta] of Object.entries(fsDocFolderMap)) {
        const dir = path.join(baseDir, folderDir);
        if (!fs.existsSync(dir)) continue;
        fs.readdirSync(dir).forEach(file => {
          if (file.startsWith('.') || file === 'README.txt') return;
          const ext = path.extname(file).toLowerCase();
          let icon = '📄';
          if (ext === '.pdf') icon = '📕';
          else if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) icon = '🖼️';
          else if (['.doc', '.docx'].includes(ext)) icon = '📝';
          else if (['.xls', '.xlsx'].includes(ext)) icon = '📊';
          const fileUrl = `/uploads/event-docs/${eventId}/${folderDir}/${encodeURIComponent(file)}`;
          fsDocs.push({
            display_name: path.basename(file, ext).replace(/[-_]/g, ' '),
            document_type: meta.label,
            file_path: fileUrl,
            preview_url: fileUrl,
            category: meta.category,
            icon
          });
        });
      }
    }
    if (fsDocs.length > 0) {
      const merged = [...fsDocs, ...STATIC_CLASS_DOCS];
      return res.json({ success: true, documents: merged, count: merged.length, source: 'filesystem' });
    }

    // ── 2. Fallback: JSON config file ─────────────────────────────────────────
    const configPath = path.join(__dirname, 'data', 'event-documents.json');
    
    if (!fs.existsSync(configPath)) {
      return res.json({ success: true, documents: [...STATIC_CLASS_DOCS], count: STATIC_CLASS_DOCS.length, source: 'static' });
    }
    
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const eventDocs = configData.events?.[eventId];
    
    if (!eventDocs || !eventDocs.documents || eventDocs.documents.length === 0) {
      return res.json({ success: true, documents: [...STATIC_CLASS_DOCS], count: STATIC_CLASS_DOCS.length, source: 'static' });
    }
    
    // Map documents with icons based on type
    const documents = eventDocs.documents
      .filter(doc => doc.url && doc.url !== 'https://drive.google.com/file/d/YOUR_FILE_ID/view?usp=sharing')
      .map(doc => {
        let icon = '📄';
        const typeLower = (doc.type || '').toLowerCase();
        if (typeLower.includes('regulation') || typeLower.includes('sr')) icon = '📕';
        else if (typeLower.includes('entry') || typeLower.includes('list')) icon = '📋';
        else if (typeLower.includes('time') || typeLower.includes('schedule')) icon = '🕐';
        else if (typeLower.includes('result')) icon = '🏆';
        else if (typeLower.includes('bulletin')) icon = '📢';
        else if (typeLower.includes('notice')) icon = '⚠️';
        else if (typeLower.includes('map')) icon = '🗺️';
        
        let url = doc.url;
        if (url.includes('drive.google.com/file/d/')) {
          const match = url.match(/\/d\/([^\/]+)/);
          if (match) url = `https://drive.google.com/file/d/${match[1]}/preview`;
        }
        
        return {
          display_name: doc.name,
          document_type: doc.type || 'Document',
          file_path: doc.url,
          preview_url: url,
          icon: icon
        };
      })
      .sort((a, b) => {
        const priority = { 'Supplementary Regulations': 1, 'Entry List': 2, 'Timetable': 3, 'Results': 4, 'Bulletin': 5, 'Notice': 6 };
        const aPri = priority[a.document_type] || 99;
        const bPri = priority[b.document_type] || 99;
        if (aPri !== bPri) return aPri - bPri;
        return a.display_name.localeCompare(b.display_name);
      });
    
    const allDocs = [...documents, ...STATIC_CLASS_DOCS];
    res.json({ success: true, documents: allDocs, count: allDocs.length, eventName: eventDocs.name });
    
  } catch (err) {
    console.error('Error reading event documents:', err);
    res.json({ success: true, documents: [], error: err.message });
  }
});

// Fix #14: Equipment management routes mounted via app.use() below (routes/equipment.js).
// The live scan/management endpoints immediately below (verifyScanner, poolEngines, drawEngines etc.)
// are distinct from equipment.js — do not remove them.
// Dead duplicate copies that existed AFTER the app.use() mount have been removed.

// ── Scanner identity ──────────────────────────────────────────────────
// Public: verify a scanner PIN and return the scanner name
app.post('/api/verifyScanner', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.json({ success: false, error: 'PIN required' });
    const result = await pool.query(
      'SELECT scanner_id, scanner_name FROM scanners WHERE pin_code = $1',
      [String(pin).trim()]
    );
    if (!result.rows.length) return res.json({ success: false, error: 'Invalid code' });
    res.json({ success: true, scanner_id: result.rows[0].scanner_id, scanner_name: result.rows[0].scanner_name });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Admin: list scanners
app.get('/api/scanners', async (req, res) => {
  try {
    const result = await pool.query('SELECT scanner_id, scanner_name, pin_code, created_at FROM scanners ORDER BY created_at');
    res.json({ success: true, scanners: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Admin: add scanner
app.post('/api/scanners', async (req, res) => {
  try {
    const { scanner_name, pin_code } = req.body;
    if (!scanner_name || !pin_code) return res.json({ success: false, error: 'Name and PIN required' });
    if (!/^\d{4}$/.test(String(pin_code))) return res.json({ success: false, error: 'PIN must be exactly 4 digits' });
    const result = await pool.query(
      'INSERT INTO scanners (scanner_name, pin_code) VALUES ($1, $2) RETURNING scanner_id, scanner_name, pin_code',
      [scanner_name.trim(), String(pin_code).trim()]
    );
    res.json({ success: true, scanner: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.json({ success: false, error: 'That PIN is already in use' });
    res.json({ success: false, error: err.message });
  }
});

// Admin: delete scanner
app.delete('/api/scanners/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM scanners WHERE scanner_id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Public read-only endpoint for draw station (engine-draw.html — no admin auth needed)
app.get('/api/drawEngines', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pe.*,
             d.first_name || ' ' || d.last_name AS assigned_driver_name,
             d.race_number                        AS assigned_race_number
      FROM pool_engines pe
      LEFT JOIN race_entries re
             ON UPPER(re.engine_serial) = UPPER(pe.engine_serial)
            AND re.engine_returned IS NOT TRUE
            AND re.engine_serial IS NOT NULL
            AND pe.engine_serial IS NOT NULL
            AND pe.engine_serial <> ''
      LEFT JOIN drivers d ON re.driver_id = d.driver_id
      ORDER BY pe.class, pe.draw_number
    `);
    res.json({ success: true, engines: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// \u2500\u2500 Pool Engines ─────────────────────────────────────────────
// GET: list all pool engines (with current driver assignment if any)
app.get('/api/poolEngines', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pe.*,
             d.first_name || ' ' || d.last_name AS assigned_driver_name,
             d.race_number                        AS assigned_race_number
      FROM pool_engines pe
      LEFT JOIN race_entries re
             ON UPPER(re.engine_serial) = UPPER(pe.engine_serial)
            AND re.engine_returned IS NOT TRUE
            AND re.engine_serial IS NOT NULL
            AND pe.engine_serial IS NOT NULL
            AND pe.engine_serial <> ''
      LEFT JOIN drivers d ON re.driver_id = d.driver_id
      ORDER BY pe.class, pe.draw_number
    `);
    res.json({ success: true, engines: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET: ALL pool engines ever (incl. soft-deleted) for admin history view
app.get('/api/allPoolEngines', async (req, res) => {
  try {
    const poolRes = await pool.query(`
      SELECT pe.engine_id, pe.draw_number, pe.engine_serial, pe.seal_number,
             pe.carb_number, pe.airbox_number, pe.exhaust_number,
             pe.class, pe.notes, pe.active, pe.created_at, pe.deleted_at,
             d.first_name || ' ' || d.last_name AS assigned_driver_name,
             d.race_number                        AS assigned_race_number,
             re.engine_assigned_at, re.entry_id  AS active_entry_id,
             re.engine_returned
      FROM pool_engines pe
      LEFT JOIN race_entries re
             ON UPPER(re.engine_serial) = UPPER(pe.engine_serial)
            AND re.engine_returned IS NOT TRUE
            AND re.engine_serial IS NOT NULL
            AND pe.engine_serial IS NOT NULL
            AND pe.engine_serial <> ''
      LEFT JOIN drivers d ON re.driver_id = d.driver_id
      ORDER BY pe.deleted_at IS NOT NULL, pe.class,
               NULLIF(regexp_replace(pe.draw_number,'[^0-9]','','g'),'')::int NULLS LAST,
               pe.draw_number
    `);

    const orphanRes = await pool.query(`
      SELECT DISTINCT s.serial, s.last_used, s.src
      FROM (
        SELECT UPPER(engine_serial) AS serial,
               MAX(engine_assigned_at)::TEXT AS last_used, 'race_entry' AS src
        FROM race_entries
        WHERE engine_serial IS NOT NULL AND engine_serial <> ''
        GROUP BY UPPER(engine_serial)
        UNION
        SELECT UPPER(equipment_serial), MAX(scan_timestamp)::TEXT, 'scan_log'
        FROM equipment_scan_log
        WHERE equipment_serial IS NOT NULL AND equipment_serial <> ''
        GROUP BY UPPER(equipment_serial)
      ) s
      WHERE s.serial NOT IN (
        SELECT UPPER(engine_serial) FROM pool_engines WHERE engine_serial <> ''
      )
    `);

    res.json({ success: true, engines: poolRes.rows, orphans: orphanRes.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST: add a pool engine
app.post('/api/poolEngines', async (req, res) => {
  try {
    const { draw_number, engine_serial, seal_number, carb_number, airbox_number, exhaust_number, class: cls, notes } = req.body;
    if (!draw_number) return res.json({ success: false, error: 'Draw number is required' });
    const result = await pool.query(
      `INSERT INTO pool_engines (draw_number, engine_serial, seal_number, carb_number, airbox_number, exhaust_number, class, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [String(draw_number).trim(), engine_serial||'', seal_number||'', carb_number||'', airbox_number||'', exhaust_number||'', cls||'', notes||'']
    );
    res.json({ success: true, engine: result.rows[0] });
    // Log initial seal to audit trail (so history exists even if never edited)
    if (seal_number && String(seal_number).trim()) {
      try {
        await pool.query(
          `INSERT INTO audit_log (action, field_name, old_value, new_value, driver_email, created_at) VALUES ($1,$2,$3,$4,$5,NOW())`,
          ['pool_engine_seal_changed', 'seal_number', '(none)', String(seal_number).trim(),
           `Draw #${String(draw_number).trim()} | Serial: ${engine_serial || 'N/A'}`]
        );
      } catch (_) {}
    }
  } catch (err) {
    if (err.code === '23505') return res.json({ success: false, error: 'Draw number already exists for this class' });
    res.json({ success: false, error: err.message });
  }
});

// PUT: update a pool engine
app.put('/api/poolEngines/:id', async (req, res) => {
  try {
    const { draw_number, engine_serial, seal_number, carb_number, airbox_number, exhaust_number, class: cls, notes, active } = req.body;

    // Fetch ALL current fields so we can detect any change
    const prev = await pool.query(
      'SELECT draw_number, engine_serial, seal_number, carb_number, airbox_number, exhaust_number, class, notes FROM pool_engines WHERE engine_id=$1',
      [req.params.id]
    );
    const prevRow = prev.rows[0];

    const result = await pool.query(
      `UPDATE pool_engines SET
         draw_number=$1, engine_serial=$2, seal_number=$3, carb_number=$4,
         airbox_number=$5, exhaust_number=$6, class=$7, notes=$8, active=$9, updated_at=NOW()
       WHERE engine_id=$10 RETURNING *`,
      [draw_number, engine_serial||'', seal_number||'', carb_number||'', airbox_number||'', exhaust_number||'', cls||'', notes||'', active !== false, req.params.id]
    );
    if (!result.rows.length) return res.json({ success: false, error: 'Engine not found' });

    // Audit log + scan log: record ALL field changes transparently
    if (prevRow) {
      const fieldDefs = [
        { key: 'draw_number',    label: 'Draw #'       },
        { key: 'engine_serial',  label: 'Engine Serial' },
        { key: 'seal_number',    label: 'Seal'         },
        { key: 'carb_number',    label: 'Carb'         },
        { key: 'airbox_number',  label: 'Airbox'       },
        { key: 'exhaust_number', label: 'Exhaust'      },
        { key: 'class',          label: 'Class'        },
        { key: 'notes',          label: 'Notes'        },
      ];
      const newVals = {
        draw_number:    String(draw_number  ||'').trim(),
        engine_serial:  String(engine_serial||'').trim(),
        seal_number:    String(seal_number  ||'').trim(),
        carb_number:    String(carb_number  ||'').trim(),
        airbox_number:  String(airbox_number||'').trim(),
        exhaust_number: String(exhaust_number||'').trim(),
        class:          String(cls          ||'').trim(),
        notes:          String(notes        ||'').trim(),
      };
      const changes = [];
      for (const f of fieldDefs) {
        const oldVal = String(prevRow[f.key] || '').trim();
        const newVal = newVals[f.key];
        if (oldVal !== newVal) {
          changes.push({ label: f.label, oldVal, newVal });
          try {
            await pool.query(
              `INSERT INTO audit_log (action, field_name, old_value, new_value, driver_email, created_at)
               VALUES ($1,$2,$3,$4,$5,NOW())`,
              [
                `pool_engine_${f.key}_changed`,
                f.key,
                oldVal || '(none)',
                newVal || '(none)',
                `Draw #${prevRow.draw_number} | Serial: ${prevRow.engine_serial || 'N/A'}`
              ]
            );
          } catch (_) {}
        }
      }

      // Write a single scan_log row per affected serial so the history panel shows the edit
      if (changes.length > 0) {
        const changeText = changes.map(c => `${c.label}: "${c.oldVal||'–'}" → "${c.newVal||'–'}"`).join(' | ');
        // Log against both old and new serial (in case serial itself changed)
        const serials = [...new Set(
          [prevRow.engine_serial, newVals.engine_serial].filter(Boolean).map(s => s.toUpperCase())
        )];
        for (const serial of serials) {
          try {
            await pool.query(
              `INSERT INTO equipment_scan_log
                 (scan_type, equipment_serial, scanned_by, notes, action_result, scan_timestamp)
               VALUES ('admin_edit', $1, 'Admin', $2, 'success', NOW())`,
              [serial, changeText]
            );
          } catch (_) {}
        }
      }
    }

    res.json({ success: true, engine: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.json({ success: false, error: 'Draw number already exists for this class' });
    res.json({ success: false, error: err.message });
  }
});

// DELETE: remove a pool engine (preserve to audit_log first)
app.delete('/api/poolEngines/:id', async (req, res) => {
  try {
    const prev = await pool.query(
      'SELECT draw_number, engine_serial, seal_number, carb_number, airbox_number, exhaust_number, class, notes FROM pool_engines WHERE engine_id=$1',
      [req.params.id]
    );
    if (prev.rows.length) {
      const r = prev.rows[0];
      try {
        await pool.query(
          `INSERT INTO audit_log (action, field_name, old_value, new_value, driver_email, created_at) VALUES ($1,$2,$3,$4,$5,NOW())`,
          [
            'pool_engine_deleted', 'engine_serial',
            r.engine_serial || '(none)', '(deleted)',
            `Draw #${r.draw_number} | Serial: ${r.engine_serial || 'N/A'} | Seal: ${r.seal_number || 'N/A'} | Class: ${r.class || 'N/A'} | Carb: ${r.carb_number || '-'} | Airbox: ${r.airbox_number || '-'} | Exhaust: ${r.exhaust_number || '-'}`
          ]
        );
      } catch (_) {}
    }
    // Soft-delete — keep the row so history remains queryable forever
    await pool.query('UPDATE pool_engines SET deleted_at=NOW(), active=false WHERE engine_id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET: seal number history for an engine (by serial) — works even if engine was deleted
app.get('/api/engineSealHistory', async (req, res) => {
  try {
    const { serial } = req.query;
    if (!serial) return res.json({ success: false, error: 'serial parameter required' });

    // Try live engine table first
    const eng = await pool.query(
      `SELECT engine_id, draw_number, engine_serial, seal_number, class, created_at
       FROM pool_engines WHERE LOWER(engine_serial)=LOWER($1) LIMIT 1`,
      [serial]
    );

    // All seal-change audit entries for this serial
    const hist = await pool.query(
      `SELECT old_value, new_value, created_at FROM audit_log
       WHERE action='pool_engine_seal_changed'
         AND driver_email ILIKE $1
       ORDER BY created_at ASC`,
      [`%Serial: ${serial}%`]
    );

    // Check if it was ever deleted
    const delLog = await pool.query(
      `SELECT driver_email, created_at FROM audit_log
       WHERE action='pool_engine_deleted'
         AND driver_email ILIKE $1
       ORDER BY created_at DESC LIMIT 1`,
      [`%Serial: ${serial}%`]
    );

    let engine;
    if (eng.rows.length) {
      engine = eng.rows[0];
    } else if (hist.rows.length || delLog.rows.length) {
      // Reconstruct from audit log (engine was deleted)
      const ref        = (delLog.rows[0] || hist.rows[hist.rows.length - 1])?.driver_email || '';
      const drawMatch  = ref.match(/Draw #([^\s|]+)/);
      const classMatch = ref.match(/Class: ([^|]+)/);
      const sealMatch  = ref.match(/Seal: ([^|]+)/);
      engine = {
        engine_id:     null,
        draw_number:   drawMatch  ? drawMatch[1].trim()  : '?',
        engine_serial: serial.toUpperCase(),
        seal_number:   sealMatch  ? sealMatch[1].trim()  : null,
        class:         classMatch ? classMatch[1].trim() : null,
        created_at:    hist.rows[0]?.created_at || null,
        deleted:       true
      };
    } else {
      return res.json({ success: false, error: 'Engine not found — no records exist for this serial' });
    }

    res.json({
      success:     true,
      engine,
      history:     hist.rows,
      was_deleted: !!delLog.rows.length,
      deleted_at:  delLog.rows[0]?.created_at || null
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.use(require('./routes/equipment')(pool, logEquipmentScan));
app.use(require('./routes/access')(pool, requireAdmin));
app.use(require('./routes/checkin')(pool, requireAdmin));

// returnEngine is handled by routes/equipment.js (mounted above)
// Return signature viewer
app.get('/api/engineReturnSignature', async (req, res) => {
  try {
    const { entryId } = req.query;
    if (!entryId) return res.json({ success: false, error: 'entryId required' });
    const result = await pool.query(`
      SELECT log_id, scan_timestamp, driver_name, equipment_serial, notes, signature_data
      FROM equipment_scan_log
      WHERE entry_id = $1 AND scan_type = 'engine_return'
      ORDER BY scan_timestamp DESC
      LIMIT 1
    `, [entryId]);
    if (!result.rows.length) return res.json({ success: false, error: 'No return record found' });
    const row = result.rows[0];
    res.json({
      success: true,
      log_id:         row.log_id,
      returned_at:    row.scan_timestamp,
      driver_name:    row.driver_name,
      engine_serial:  row.equipment_serial,
      notes:          row.notes,
      has_signature:  !!row.signature_data,
      signature_data: row.signature_data
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});


// ── FLAG DISPLAY ────────────────────────────────────────────────────────────

// Set the current flag (called by clerk.html - no auth required, local network only)
app.post('/api/flag/set', (req, res) => {
  const allowed = ['red', 'yellow', 'green', 'blue', 'white', 'checkered', 'none'];
  const { flag } = req.body;
  if (!flag || !allowed.includes(flag)) {
    return res.status(400).json({ success: false, error: 'Invalid flag' });
  }
  currentFlag = flag;
  const payload = JSON.stringify({ flag });
  for (const client of flagClients) {
    try { client.write(`data: ${payload}\n\n`); } catch (_) { flagClients.delete(client); }
  }
  res.json({ success: true, flag });
});

// SSE stream for flag.html
app.get('/api/flag/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  // Send current flag immediately on connect
  res.write(`data: ${JSON.stringify({ flag: currentFlag })}\n\n`);
  flagClients.add(res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); flagClients.delete(res); }
  }, 15000);
  req.on('close', () => { clearInterval(ping); flagClients.delete(res); });
});

// ── APEX TIMING WATCHER ──────────────────────────────────────────────────────
// Connects to the Apex Timing WebSocket and mirrors flag changes to flag.html
// Protocol reverse-engineered from javascript_live_timing.min.js:
//   - Data: newline-separated lines, each pipe-delimited: dataId|cssClass|value
//   - WebSocket URL: wss://<host>:<port+3>/  (HTTPS) or ws://<host>:<port+2>/
//   - No handshake needed — just connect and receive

const APEX_FLAG_CLASSES = {
  // ── Confirmed from live data on 'light' data-id ──────────────────────────
  // These are the CSS classes Apex Timing sets on the main flag indicator element.
  'lg':         'green',       // lights go / green flag (race running)
  'ly':         'yellow',      // yellow flag
  'lr':         'red',         // red flag
  'lc':         'checkered',   // chequered flag
  'lo':         'none',        // lights out / session not started
  'ls':         'none',        // safety conditions
  // ── Legacy / alternative class names ─────────────────────────────────────
  'gr':         'green',
  'yf':         'yellow',
  'rf':         'red',
  'bf':         'blue',
  'wf':         'white',
  'ch':         'checkered',
  'chequered':  'checkered',
  'checkered':  'checkered',
  'no':         'none',
  'sc':         'none',        // safety car
  // Fallback: full-word variants
  'green':      'green',
  'yellow':     'yellow',
  'red':        'red',
  'blue':       'blue',
  'white':      'white',
};

// Ring buffer for recent raw messages — readable via /api/apex/status for debugging
let apexMessageLog = [];
const APEX_LOG_MAX = 200;

let apexSocket = null;
let apexReconnectTimer = null;
let apexReconnectDelay = 5000;
const APEX_MAX_RECONNECT = 60000;

const apexConfig = {
  enabled: false,
  host: 'www.apex-timing.com',
  port: 7550,
  // 'light' confirmed from live data: the main race status element uses this data-id.
  // Set to null to accept any element that carries a known flag class (for debugging).
  flagDataId: 'light',
};

function apexBroadcastFlag(flagName, dataId) {
  if (!flagName || flagName === currentFlag) return;
  currentFlag = flagName;
  const payload = JSON.stringify({ flag: flagName });
  for (const client of flagClients) {
    try { client.write(`data: ${payload}\n\n`); } catch (_) { flagClients.delete(client); }
  }
  console.log(`[Apex] Flag → ${flagName} (from data-id="${dataId}")`);
}

function apexHandleData(raw) {
  if (!raw || !raw.trim()) return;
  const lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Log to ring buffer (truncate long lines)
    const logEntry = { ts: Date.now(), line: line.length > 150 ? line.slice(0, 150) + '…' : line };
    apexMessageLog.push(logEntry);
    if (apexMessageLog.length > APEX_LOG_MAX) apexMessageLog.shift();

    const parts = line.split('|');
    if (parts.length < 2) continue;

    const dataId = parts[0];
    const cssClass = parts[1];

    const flagName = APEX_FLAG_CLASSES[cssClass];
    if (flagName === undefined) continue;

    // If flagDataId is configured, only respond to that specific element
    if (apexConfig.flagDataId && dataId !== apexConfig.flagDataId) {
      console.log(`[Apex] Flag class "${cssClass}" on data-id="${dataId}" (not watching this id, flagDataId="${apexConfig.flagDataId}")`);
      continue;
    }

    apexBroadcastFlag(flagName, dataId);
  }
}

function apexConnect() {
  if (!apexConfig.enabled) return;

  const url = `wss://${apexConfig.host}:${apexConfig.port + 3}/`;
  console.log(`[Apex] Connecting to ${url}`);

  try {
    apexSocket = new WebSocket(url);

    apexSocket.onopen = function () {
      console.log('[Apex] Connected to Apex Timing WebSocket');
      apexReconnectDelay = 5000; // reset backoff on success
    };

    apexSocket.onmessage = function (event) {
      apexHandleData(event.data);
    };

    apexSocket.onerror = function (err) {
      console.log('[Apex] WebSocket error:', err.message || err.type || 'unknown error');
    };

    apexSocket.onclose = function () {
      console.log('[Apex] Disconnected');
      apexSocket = null;
      if (apexConfig.enabled) {
        apexReconnectTimer = setTimeout(apexConnect, apexReconnectDelay);
        apexReconnectDelay = Math.min(apexReconnectDelay * 2, APEX_MAX_RECONNECT);
      }
    };
  } catch (e) {
    console.log('[Apex] Connect error:', e.message);
    if (apexConfig.enabled) {
      apexReconnectTimer = setTimeout(apexConnect, apexReconnectDelay);
      apexReconnectDelay = Math.min(apexReconnectDelay * 2, APEX_MAX_RECONNECT);
    }
  }
}

// Enable the Apex watcher (call this when a race goes live)
app.post('/api/apex/enable', (req, res) => {
  // Optional: override host/port/flagDataId from body
  if (req.body.host) apexConfig.host = req.body.host;
  if (req.body.port) apexConfig.port = parseInt(req.body.port, 10);
  if (req.body.flagDataId !== undefined) apexConfig.flagDataId = req.body.flagDataId || null;

  apexConfig.enabled = true;
  if (apexReconnectTimer) { clearTimeout(apexReconnectTimer); apexReconnectTimer = null; }
  const isOpen = apexSocket && apexSocket.readyState === 1; // 1 = OPEN
  if (!isOpen) {
    apexReconnectDelay = 5000;
    apexConnect();
  }
  res.json({ success: true, status: 'enabled', config: { host: apexConfig.host, port: apexConfig.port, flagDataId: apexConfig.flagDataId } });
});

// Disable the Apex watcher
app.post('/api/apex/disable', (req, res) => {
  apexConfig.enabled = false;
  if (apexReconnectTimer) { clearTimeout(apexReconnectTimer); apexReconnectTimer = null; }
  if (apexSocket) { try { apexSocket.close(); } catch (_) {} apexSocket = null; }
  res.json({ success: true, status: 'disabled' });
});

// Status + debug log (last 20 messages)
app.get('/api/apex/status', (req, res) => {
  res.json({
    enabled: apexConfig.enabled,
    connected: !!(apexSocket && apexSocket.readyState === 1),
    config: { host: apexConfig.host, port: apexConfig.port, flagDataId: apexConfig.flagDataId },
    currentFlag,
    recentMessages: apexMessageLog.slice(-20),
  });
});

// ── LIVE MONITOR SSE STREAM ──────────────────────────────────────────────────

// Live monitor SSE stream
app.get('/api/monitor/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write(': connected\n\n');
  monitorClients.add(res);
  // keepalive ping every 15s so connection doesn't silently time out
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); monitorClients.delete(res); }
  }, 15000);
  req.on('close', () => { clearInterval(ping); monitorClients.delete(res); });
});

// ── DIR ENGINE CONTACT LOG ───────────────────────────────────────────────────

// POST /api/dir/log — create a new contact record
app.post('/api/dir/log', async (req, res) => {
  try {
    const {
      engine_serial, person_name, driver_id,
      contact_date, contact_type, outcome,
      fault_category, description, dir_notes,
      follow_up, follow_up_notes
    } = req.body;

    if (!person_name) return res.status(400).json({ success: false, error: 'person_name is required' });
    if (!outcome)     return res.status(400).json({ success: false, error: 'outcome is required' });

    const result = await pool.query(`
      INSERT INTO dir_engine_contacts
        (engine_serial, person_name, driver_id, contact_date, contact_type,
         outcome, fault_category, description, dir_notes, follow_up, follow_up_notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      engine_serial ? engine_serial.toUpperCase() : null,
      person_name,
      driver_id || null,
      contact_date || new Date(),
      contact_type || 'Inspection',
      outcome,
      fault_category || null,
      description || null,
      dir_notes || null,
      follow_up === true || follow_up === 'true',
      follow_up_notes || null
    ]);

    const row0 = result.rows[0];
    // Broadcast to live monitor
    const dirEvt = JSON.stringify({
      log_id:           'dir_' + row0.contact_id,
      scan_timestamp:   row0.contact_date || new Date(),
      scan_type:        'dir_contact',
      driver_name:      person_name,
      race_class:       null,
      equipment_serial: engine_serial ? engine_serial.toUpperCase() : null,
      action_result:    'success',
      notes:            dir_notes || description || null,
      barcode_scanned:  null,
      event_id:         null,
      event_name:       null,
      scanned_by:       'DIR Portal',
      dir_outcome:      outcome,
      dir_contact_type: contact_type || 'Inspection',
      dir_follow_up:    follow_up === true || follow_up === 'true',
    });
    for (const client of monitorClients) {
      try { client.write(`data: ${dirEvt}\n\n`); } catch(_) { monitorClients.delete(client); }
    }

    res.json({ success: true, contact: row0 });
  } catch (err) {
    console.error('Error creating DIR contact log:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/logs — list all logs, optional filters: outcome, engine_serial, from, to
app.get('/api/dir/logs', async (req, res) => {
  try {
    const { outcome, engine_serial, search, from, to, limit = 200 } = req.query;
    const params = [];
    const where = [];

    if (outcome)       { params.push(outcome);                      where.push(`outcome = $${params.length}`); }
    if (engine_serial) { params.push(engine_serial.toUpperCase());  where.push(`engine_serial = $${params.length}`); }
    if (search)        { params.push(`%${search}%`);               where.push(`(person_name ILIKE $${params.length} OR engine_serial ILIKE $${params.length} OR description ILIKE $${params.length})`); }
    if (from)          { params.push(from);                         where.push(`contact_date >= $${params.length}`); }
    if (to)            { params.push(to);                           where.push(`contact_date <= $${params.length}`); }

    params.push(parseInt(limit));
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const result = await pool.query(`
      SELECT * FROM dir_engine_contacts
      ${whereClause}
      ORDER BY contact_date DESC
      LIMIT $${params.length}
    `, params);

    // Summary counts
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome = 'engine_fault')    AS engine_faults,
        COUNT(*) FILTER (WHERE outcome = 'user_error')      AS user_errors,
        COUNT(*) FILTER (WHERE outcome = 'mechanic_error')  AS mechanic_errors,
        COUNT(*) FILTER (WHERE outcome = 'inconclusive')    AS inconclusive,
        COUNT(*) FILTER (WHERE outcome = 'no_fault')        AS no_fault,
        COUNT(*)                                             AS total
      FROM dir_engine_contacts
    `);

    res.json({ success: true, logs: result.rows, stats: stats.rows[0] });
  } catch (err) {
    console.error('Error fetching DIR logs:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/engine/:serial — full history for one engine serial
app.get('/api/dir/engine/:serial', async (req, res) => {
  try {
    const serial = req.params.serial.toUpperCase();
    const result = await pool.query(`
      SELECT * FROM dir_engine_contacts
      WHERE engine_serial = $1
      ORDER BY contact_date DESC
    `, [serial]);
    res.json({ success: true, serial, logs: result.rows });
  } catch (err) {
    console.error('Error fetching engine contact log:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/dir/log/:id — remove a single log entry
app.delete('/api/dir/log/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM dir_engine_contacts WHERE contact_id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting DIR log:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/engineParts/:serial — full parts record for engine by serial
app.get('/api/dir/engineParts/:serial', async (req, res) => {
  try {
    const serial = req.params.serial.toUpperCase().trim();
    const result = await pool.query(
      `SELECT engine_id, draw_number, engine_serial, seal_number, carb_number,
              airbox_number, exhaust_number, class, notes, active, updated_at
       FROM pool_engines WHERE LOWER(engine_serial)=LOWER($1) LIMIT 1`,
      [serial]
    );
    if (!result.rows.length) return res.json({ success: false, error: 'Engine not found in pool' });
    res.json({ success: true, engine: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/dir/enginePart — update a single part field, log change, broadcast to monitor
app.patch('/api/dir/enginePart', async (req, res) => {
  try {
    const { serial, field, newValue, changedBy } = req.body;
    const ALLOWED = ['seal_number','carb_number','airbox_number','exhaust_number','notes'];
    if (!serial) return res.json({ success: false, error: 'serial required' });
    if (!ALLOWED.includes(field)) return res.json({ success: false, error: 'Invalid field: ' + field });

    const LABELS = { seal_number:'Seal', carb_number:'Carb', airbox_number:'Airbox', exhaust_number:'Exhaust', notes:'Notes' };
    const label = LABELS[field];

    // Fetch current row
    const eng = await pool.query(
      `SELECT engine_id, draw_number, engine_serial, ${field} AS cur_val, class
       FROM pool_engines WHERE LOWER(engine_serial)=LOWER($1) LIMIT 1`,
      [serial]
    );
    if (!eng.rows.length) return res.json({ success: false, error: 'Engine not found' });
    const row = eng.rows[0];
    const oldValue = (row.cur_val || '').trim();
    const cleanNew = (newValue || '').trim();

    // Update the field
    await pool.query(
      `UPDATE pool_engines SET ${field}=$1, updated_at=NOW() WHERE engine_id=$2`,
      [cleanNew, row.engine_id]
    );

    // Insert dir_engine_contacts record as part-change history
    const description = `${label} changed: "${oldValue || '—'}" → "${cleanNew || '—'}"`;
    const logResult = await pool.query(
      `INSERT INTO dir_engine_contacts
         (engine_serial, contact_type, outcome, description, person_name, contact_date)
       VALUES ($1,'Part Change','Noted',$2,$3,NOW()) RETURNING *`,
      [serial.toUpperCase(), description, changedBy || 'DIR Portal']
    );
    const logRow = logResult.rows[0];

    // Broadcast to monitor
    const evt = JSON.stringify({
      log_id:           'dir_' + logRow.contact_id,
      scan_type:        'part_change',
      driver_name:      changedBy || 'DIR Portal',
      equipment_serial: serial.toUpperCase(),
      dir_outcome:      'Noted',
      dir_contact_type: 'Part Change',
      dir_field_name:   label,
      dir_old_value:    oldValue,
      dir_new_value:    cleanNew,
      notes:            description,
      scanned_by:       'DIR Portal',
      scan_timestamp:   new Date().toISOString()
    });
    for (const client of monitorClients) {
      try { client.write(`data: ${evt}\n\n`); } catch (_) { monitorClients.delete(client); }
    }

    // Audit log for ALL part changes
    await pool.query(
      `INSERT INTO audit_log (action, field_name, old_value, new_value, driver_email, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [
        `dir_part_changed`,
        field,
        oldValue || '(none)',
        cleanNew || '(none)',
        `Serial: ${row.engine_serial} | Draw #${row.draw_number} | ${label}`
      ]
    ).catch(() => {});

    // Also keep legacy seal-history entry so existing seal history lookups still work
    if (field === 'seal_number') {
      await pool.query(
        `INSERT INTO audit_log (action, field_name, old_value, new_value, driver_email, created_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        ['pool_engine_seal_changed', 'seal_number', oldValue || '(none)', cleanNew || '(none)',
         `Draw #${row.draw_number} | Serial: ${row.engine_serial}`]
      ).catch(() => {});
    }

    res.json({ success: true, log: logRow, oldValue });
  } catch (err) {
    console.error('Error updating engine part:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── END DIR ENGINE CONTACT LOG ──────────────────────────────────────────────

// Lookup driver by race number — returns all confirmed entries with equipment
app.get('/api/lookupDriverByNumber', async (req, res) => {
  try {
    const { raceNumber } = req.query;
    if (!raceNumber) return res.json({ success: false, error: 'Race number required' });

    const normNum = String(raceNumber).trim().toUpperCase();
    const result = await pool.query(`
      SELECT re.entry_id, re.driver_id, re.race_class,
             CASE WHEN re.engine_returned = true THEN NULL ELSE re.engine_serial END AS engine_serial,
             re.tyre_front_left, re.tyre_front_right, re.tyre_rear_left, re.tyre_rear_right,
             re.tyre_sets,
             re.ticket_engine_ref, re.ticket_tyres_ref, re.ticket_transponder_ref, re.ticket_fuel_ref,
             re.entry_items,
             d.first_name, d.last_name, d.race_number,
             e.event_name, e.event_date, re.event_id
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN events e ON re.event_id = e.event_id
      WHERE (
        d.race_number = $1
        OR UPPER(re.driver_barcode_1) = $1
        OR UPPER(re.driver_barcode_2) = $1
        OR UPPER(re.driver_barcode_3) = $1
        OR UPPER(re.ticket_engine_ref) = $1
        OR UPPER(re.ticket_tyres_ref) = $1
        OR UPPER(re.ticket_transponder_ref) = $1
      )
        AND re.payment_status IN ('Completed','completed','Confirmed','confirmed','paid','pending_payment','Pending','pending','free','Free')
        AND re.entry_status NOT IN ('cancelled','canceled')
      ORDER BY e.event_date DESC NULLS LAST, re.created_at DESC
    `, [normNum]);

    if (result.rows.length === 0) {
      return res.json({ success: false, error: 'No confirmed entry found for this race number' });
    }

    // For each entry build the equipment object, falling back to scan log if DB columns are null
    const entries = [];
    for (const row of result.rows) {
      let engineSerial = row.engine_serial || null;
      let fl = row.tyre_front_left  || null;
      let fr = row.tyre_front_right || null;
      let rl = row.tyre_rear_left   || null;
      let rr = row.tyre_rear_right  || null;

      if (!engineSerial) {
        // Check scan log — but only if the most recent engine scan is an assign (not a return)
        const el = await pool.query(`
          SELECT equipment_serial, scan_type FROM equipment_scan_log
          WHERE driver_id = $1 AND scan_type IN ('engine_assign','LOAN_ASSIGN','engine_return')
            AND action_result = 'success' AND equipment_serial IS NOT NULL
          ORDER BY scan_timestamp DESC LIMIT 1
        `, [row.driver_id]);
        if (el.rows.length && el.rows[0].scan_type !== 'engine_return') {
          engineSerial = el.rows[0].equipment_serial;
        }
      }

      if (!fl || !fr || !rl || !rr) {
        const tl = await pool.query(`
          SELECT equipment_serial FROM equipment_scan_log
          WHERE driver_id = $1 AND scan_type = 'tyres_register'
            AND action_result = 'success' AND equipment_serial IS NOT NULL
          ORDER BY scan_timestamp DESC LIMIT 1
        `, [row.driver_id]);
        if (tl.rows.length) {
          const raw = tl.rows[0].equipment_serial;
          const flM = raw.match(/FL:(\S+)/i); const frM = raw.match(/FR:(\S+)/i);
          const rlM = raw.match(/RL:(\S+)/i); const rrM = raw.match(/RR:(\S+)/i);
          if (flM) fl = flM[1]; if (frM) fr = frM[1];
          if (rlM) rl = rlM[1]; if (rrM) rr = rrM[1];
        }
      }

      const tyresOk = !!(fl && fr && rl && rr);
      // Build tyre_sets array and flat all_tyre_serials for multi-set verification
      let tyreSets = [];
      try { tyreSets = Array.isArray(row.tyre_sets) ? row.tyre_sets : (row.tyre_sets ? JSON.parse(row.tyre_sets) : []); } catch(_) {}
      let allTyreSerials = tyreSets.flatMap(s => [s.fl, s.fr, s.rl, s.rr].filter(Boolean).map(v => v.toUpperCase()));
      // Fall back to individual column values if tyre_sets is empty
      if (allTyreSerials.length === 0 && tyresOk) {
        allTyreSerials = [fl, fr, rl, rr].filter(Boolean).map(v => v.toUpperCase());
      }
      entries.push({
        driver_id:   row.driver_id,
        entry_id:    row.entry_id,
        first_name:  row.first_name,
        last_name:   row.last_name,
        race_number: row.race_number,
        race_class:  row.race_class,
        event_name:  row.event_name  || null,
        event_date:  row.event_date  || null,
        event_id:    row.event_id    || null,
        engine_serial:    engineSerial,
        registered_tyres: tyresOk || allTyreSerials.length > 0,
        tyres: tyresOk ? { front_left: fl, front_right: fr, rear_left: rl, rear_right: rr } : null,
        tyre_sets:       tyreSets,
        all_tyre_serials: allTyreSerials,
        ticket_engine_ref:      row.ticket_engine_ref      || null,
        ticket_tyres_ref:       row.ticket_tyres_ref       || null,
        ticket_transponder_ref: row.ticket_transponder_ref || null,
        ticket_fuel_ref:        row.ticket_fuel_ref        || null,
        entry_items: row.entry_items || []
      });
    }

    const first = entries[0];
    res.json({
      success: true,
      entries,
      driver: {
        driver_id:   first.driver_id,
        entry_id:    first.entry_id,
        first_name:  first.first_name,
        last_name:   first.last_name,
        race_number: first.race_number,
        race_class:  first.race_class,
        engine_serial: first.engine_serial
      },
      registered_tyres: first.registered_tyres,
      tyres:            first.tyres
    });
  } catch (err) {
    console.error('Error looking up driver:', err);
    res.json({ success: false, error: err.message });
  }
});

// Log a driver check-in / engine verify / tyre verify event from check.html
app.post('/api/logDriverCheck', async (req, res) => {
  try {
    const { driver_id, entry_id, driver_name, race_class, engine_serial, scan_type, action_result, notes, scanned_by } = req.body;
    if (!driver_id) return res.json({ success: false, error: 'driver_id required' });
    await logEquipmentScan({
      scan_type: scan_type || 'driver_check',
      entry_id:         entry_id   || null,
      driver_id:        driver_id,
      driver_name:      driver_name || null,
      race_class:       race_class  || null,
      equipment_serial: engine_serial || null,
      scanned_by:       scanned_by || 'Check Station',
      action_result:    action_result || 'success',
      notes:            notes || null
    });
    res.json({ success: true });
  } catch (err) {
    console.error('logDriverCheck error:', err);
    res.json({ success: false, error: err.message });
  }
});

// Look up a race entry by tyre ticket barcode (for tyre-station.html)
app.get('/api/lookupTicket', async (req, res) => {
  try {
    const { barcode } = req.query;
    if (!barcode) return res.json({ success: false, error: 'barcode required' });
    const b = barcode.toUpperCase().trim();
    const result = await pool.query(`
      SELECT re.entry_id, re.driver_id, re.race_class,
             re.engine_serial, re.tyre_front_left, re.tyre_front_right,
             re.tyre_rear_left, re.tyre_rear_right, re.tyre_sets,
             re.ticket_tyres_ref, re.event_id,
             d.first_name, d.last_name, d.race_number,
             e.event_name, e.event_date
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN events e ON re.event_id = e.event_id
      WHERE UPPER(re.ticket_tyres_ref) = $1
        AND re.entry_status NOT IN ('cancelled','canceled')
      ORDER BY e.event_date DESC NULLS LAST LIMIT 1
    `, [b]);
    if (result.rows.length === 0) return res.json({ success: false, error: 'Tyre ticket not found' });
    const row = result.rows[0];
    let tyreSets = [];
    try { tyreSets = Array.isArray(row.tyre_sets) ? row.tyre_sets : (row.tyre_sets ? JSON.parse(row.tyre_sets) : []); } catch(_) {}
    res.json({
      success: true,
      driver: {
        driver_id:    row.driver_id,
        entry_id:     row.entry_id,
        first_name:   row.first_name,
        last_name:    row.last_name,
        race_number:  row.race_number,
        race_class:   row.race_class,
        event_name:   row.event_name   || null,
        event_date:   row.event_date   || null,
        event_id:     row.event_id     || null,
        engine_serial: row.engine_serial || null,
        ticket_tyres_ref: row.ticket_tyres_ref || null,
        tyre_sets:    tyreSets,
        tyres: (row.tyre_front_left && row.tyre_front_right && row.tyre_rear_left && row.tyre_rear_right)
          ? { front_left: row.tyre_front_left, front_right: row.tyre_front_right,
              rear_left:  row.tyre_rear_left,  rear_right:  row.tyre_rear_right }
          : null
      }
    });
  } catch (err) {
    console.error('lookupTicket error:', err);
    res.json({ success: false, error: err.message });
  }
});

// Save tyre serials for a race entry (called by tyre-station.html)
app.post('/api/assignTyres', async (req, res) => {
  try {
    const { ticketBarcode, tyres, driverId, entryId, scannedBy } = req.body;
    if (!entryId || !tyres) return res.json({ success: false, error: 'entryId and tyres required' });
    const { front_left: fl, front_right: fr, rear_left: rl, rear_right: rr } = tyres;
    if (!fl || !fr || !rl || !rr) return res.json({ success: false, error: 'All 4 tyre positions required' });

    const existing = await pool.query(
      'SELECT tyre_sets, driver_id, event_id, race_class FROM race_entries WHERE entry_id = $1',
      [entryId]
    );
    if (existing.rows.length === 0) return res.json({ success: false, error: 'Entry not found' });
    const entryRow = existing.rows[0];
    let currentSets = [];
    try { currentSets = Array.isArray(entryRow.tyre_sets) ? entryRow.tyre_sets : (entryRow.tyre_sets ? JSON.parse(entryRow.tyre_sets) : []); } catch(_) {}

    const newSet = { fl: fl.toUpperCase(), fr: fr.toUpperCase(), rl: rl.toUpperCase(), rr: rr.toUpperCase() };
    const updatedSets = [...currentSets, newSet];

    await pool.query(`
      UPDATE race_entries SET
        tyre_sets         = $1,
        tyre_front_left   = $2,
        tyre_front_right  = $3,
        tyre_rear_left    = $4,
        tyre_rear_right   = $5,
        tyres_registered_at = NOW(),
        updated_at        = NOW()
      WHERE entry_id = $6
    `, [JSON.stringify(updatedSets), newSet.fl, newSet.fr, newSet.rl, newSet.rr, entryId]);

    const serialSummary = `FL:${newSet.fl} FR:${newSet.fr} RL:${newSet.rl} RR:${newSet.rr}`;
    await logEquipmentScan({
      scan_type:        'tyres_register',
      barcode_scanned:  ticketBarcode || null,
      entry_id:         entryId,
      driver_id:        driverId || entryRow.driver_id,
      equipment_serial: serialSummary,
      scanned_by:       scannedBy || 'Tyre Station',
      action_result:    'success',
      notes:            `Set #${updatedSets.length} registered — ${serialSummary}`,
      event_id:         entryRow.event_id,
      race_class:       entryRow.race_class
    });

    res.json({ success: true, setNumber: updatedSets.length, totalSets: updatedSets.length });
  } catch (err) {
    console.error('assignTyres error:', err);
    res.json({ success: false, error: err.message });
  }
});

// Equipment tracking - search by driver name or race number
app.get('/api/equipmentTracking', async (req, res) => {
  try {
    const { search } = req.query;
    
    if (!search) {
      return res.json({ success: false, error: 'Search term required' });
    }
    
    const searchTerm = `%${search}%`;
    
    // Search by driver name or race number
    const result = await pool.query(`
      SELECT re.entry_id, re.driver_id, re.race_class, re.created_at,
             re.engine_serial, re.engine_assigned_at, re.engine_returned, 
             re.engine_returned_at, re.engine_issue,
             re.tyre_front_left, re.tyre_front_right, re.tyre_rear_left, re.tyre_rear_right,
             re.tyres_registered_at,
             re.transponder_serial, re.transponder_assigned_at,
             re.fuel_collected, re.fuel_collected_at,
             d.first_name, d.last_name, d.race_number,
             CONCAT(d.first_name, ' ', d.last_name) as driver_name,
             e.event_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN events e ON re.event_id = e.event_id
      WHERE CONCAT(d.first_name, ' ', d.last_name) ILIKE $1
         OR d.race_number::text = $2
      ORDER BY re.created_at DESC
    `, [searchTerm, search]);
    
    res.json({ 
      success: true, 
      entries: result.rows,
      count: result.rows.length 
    });
  } catch (err) {
    console.error('Error getting equipment tracking:', err);
    res.json({ success: false, error: err.message });
  }
});

// Get equipment grouped by driver for an event
app.get('/api/equipmentByDriver', async (req, res) => {
  try {
    const { event_id } = req.query;
    
    if (!event_id) {
      return res.json({ success: false, error: 'Event ID required' });
    }
    
    const result = await pool.query(`
      SELECT re.entry_id, re.driver_id, re.race_class,
             re.ticket_engine_ref, re.ticket_tyres_ref, re.ticket_transponder_ref, re.ticket_fuel_ref,
             re.engine_serial, re.engine_assigned_at, re.engine_returned, 
             re.tyre_front_left, re.tyre_front_right, re.tyre_rear_left, re.tyre_rear_right,
             re.tyres_registered_at,
             re.transponder_serial, re.transponder_assigned_at,
             re.fuel_collected, re.fuel_collected_at,
             CONCAT(d.first_name, ' ', d.last_name) as driver_name,
             d.race_number
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.event_id = $1 AND re.entry_status != 'cancelled'
      ORDER BY d.last_name, d.first_name
    `, [event_id]);
    
    res.json({ 
      success: true, 
      entries: result.rows 
    });
  } catch (err) {
    console.error('Error getting equipment by driver:', err);
    res.json({ success: false, error: err.message });
  }
});

// Get equipment grouped by item type for an event
app.get('/api/equipmentByItem', async (req, res) => {
  try {
    const { event_id } = req.query;
    
    if (!event_id) {
      return res.json({ success: false, error: 'Event ID required' });
    }
    
    // Get engines currently out (not returned)
    const enginesResult = await pool.query(`
      SELECT re.engine_serial, re.engine_assigned_at, re.race_class,
             CONCAT(d.first_name, ' ', d.last_name) as driver_name,
             d.race_number
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.event_id = $1 
        AND re.engine_serial IS NOT NULL 
        AND re.engine_returned = false
      ORDER BY re.engine_assigned_at DESC
    `, [event_id]);
    
    // Get transponders currently out
    const transpondersResult = await pool.query(`
      SELECT re.transponder_serial, re.transponder_assigned_at, re.race_class,
             CONCAT(d.first_name, ' ', d.last_name) as driver_name,
             d.race_number
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.event_id = $1 
        AND re.transponder_serial IS NOT NULL
      ORDER BY re.transponder_assigned_at DESC
    `, [event_id]);
    
    res.json({ 
      success: true, 
      equipment: {
        engines: enginesResult.rows,
        transponders: transpondersResult.rows
      }
    });
  } catch (err) {
    console.error('Error getting equipment by item:', err);
    res.json({ success: false, error: err.message });
  }
});

// ─── Reel Maker: Z1 bucket listing proxy ─────────────────────────────────────
// Lists video files in a Z1 bucket — bypasses browser CORS issues on listing
app.get('/api/reel/list', async (req, res) => {
  const bucket = (req.query.bucket || '').replace(/[^a-zA-Z0-9_\-]/g, '');
  const prefix = req.query.prefix || '';
  if (!bucket) return res.status(400).json({ error: 'bucket required' });

  const cmd = new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000 });

  // Retry up to 3 times — Z1 occasionally drops the first connection
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await s3.send(cmd, { abortSignal: AbortSignal.timeout(12000) });
      const files = (data.Contents || [])
        .filter(o => !o.Key.endsWith('/') && /\.(mp4|mov|webm)$/i.test(o.Key))
        .map(o => ({ key: o.Key, size: o.Size || 0 }));
      return res.json({ files, keys: files.map(f => f.key) }); // keys kept for backward compat
    } catch (err) {
      console.warn(`[reel/list] attempt ${attempt} failed: ${err.message}`);
      if (attempt === 3) return res.status(500).json({ error: err.message });
      await new Promise(r => setTimeout(r, 800 * attempt)); // 0.8s, 1.6s back-off
    }
  }
});

// ─── Reel Maker: Z1 video stream proxy ───────────────────────────────────────
// Streams a video from Z1 to the browser with proper range-request support
// so <video> elements can scrub/seek without ERR_HTTP2_PROTOCOL_ERROR
app.get('/api/reel/video', async (req, res) => {
  try {
    const bucket = (req.query.bucket || '').replace(/[^a-zA-Z0-9_\-]/g, '');
    const key    = req.query.key || '';
    if (!bucket || !key) return res.status(400).send('bucket and key required');

    // Use HeadObjectCommand for metadata ONLY — avoids opening a body stream we might not use
    const headMeta = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const totalSize = headMeta.ContentLength;
    const mimeType  = headMeta.ContentType || 'video/mp4';

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end   = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      const chunkSize = end - start + 1;

      const rangeObj = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=${start}-${end}`
      }));

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType
      });
      rangeObj.Body.pipe(res);
    } else {
      // Full file — stream directly
      const fullObj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      res.writeHead(200, {
        'Content-Length': totalSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes'
      });
      fullObj.Body.pipe(res);
    }
  } catch (err) {
    console.error('Video proxy error:', err.message);
    if (!res.headersSent) res.status(500).send(err.message);
  }
});
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`✅ NATS Driver Registry server running on port ${PORT}`);
  console.log('🛡️ Global error handlers installed');
});

// ─── Admin Event Document Management (Z1/S3-backed) ──────────────────────────
const ADMIN_DOC_FOLDERS = {
  'official':  'official',
  'general':   'general',
  'cadet':     'cadet',
  'mini-rok':  'mini-rok',
  'ok-j':      'ok-j',
  'ok-n':      'ok-n',
  'branding':  'branding'
};

// Helper: S3 key prefix for an event's docs
function eventDocPrefix(eventId, folder) {
  const safeEvent = String(eventId).replace(/[^a-zA-Z0-9_\-]/g, '_');
  return `event-docs/${safeEvent}/${folder}/`;
}

// List docs for an event (admin) — reads from S3
app.get('/api/admin/events/:eventId/docs', requireAdmin, async (req, res) => {
  try {
    const { eventId } = req.params;
    const result = [];
    for (const [folderKey, folderDir] of Object.entries(ADMIN_DOC_FOLDERS)) {
      const prefix = eventDocPrefix(eventId, folderDir);
      const listCmd = new ListObjectsV2Command({ Bucket: Z1_BUCKET, Prefix: prefix });
      const data = await s3.send(listCmd);
      for (const obj of (data.Contents || [])) {
        const filename = obj.Key.replace(prefix, '');
        if (!filename || filename.startsWith('.')) continue;
        result.push({
          folder:   folderKey,
          filename,
          size:     obj.Size,
          url:      `${Z1_BASE_URL}/${obj.Key}`
        });
      }
    }
    res.json({ success: true, docs: result });
  } catch (err) {
    console.error('S3 list error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Upload a doc for an event (admin) — writes to S3
app.post('/api/admin/events/:eventId/docs', requireAdmin, async (req, res) => {
  try {
    const { eventId } = req.params;
    const { folder, filename, fileContent } = req.body;
    if (!folder || !filename || !fileContent) {
      return res.status(400).json({ success: false, error: 'folder, filename and fileContent required' });
    }
    if (!ADMIN_DOC_FOLDERS[folder]) {
      return res.status(400).json({ success: false, error: 'Invalid folder' });
    }
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._\- ()]/g, '_');
    const key = eventDocPrefix(eventId, ADMIN_DOC_FOLDERS[folder]) + safeName;
    const buffer = Buffer.from(fileContent, 'base64');

    // Guess content type from extension
    const ext = path.extname(safeName).toLowerCase();
    const mimeMap = { '.pdf':'application/pdf', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
                      '.png':'image/png', '.gif':'image/gif', '.doc':'application/msword',
                      '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                      '.xls':'application/vnd.ms-excel',
                      '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    const contentType = mimeMap[ext] || 'application/octet-stream';

    await s3.send(new PutObjectCommand({
      Bucket: Z1_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: 'public-read'
    }));
    console.log(`📄 Admin uploaded ${safeName} → s3://${Z1_BUCKET}/${key}`);
    res.json({ success: true, filename: safeName, url: `${Z1_BASE_URL}/${key}` });
  } catch (err) {
    console.error('S3 upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete a doc for an event (admin) — removes from S3
app.delete('/api/admin/events/:eventId/docs', requireAdmin, async (req, res) => {
  try {
    const { eventId } = req.params;
    const { folder, filename } = req.body;
    if (!folder || !filename) {
      return res.status(400).json({ success: false, error: 'folder and filename required' });
    }
    if (!ADMIN_DOC_FOLDERS[folder]) return res.status(400).json({ success: false, error: 'Invalid folder' });
    const safeName = path.basename(filename);
    const key = eventDocPrefix(eventId, ADMIN_DOC_FOLDERS[folder]) + safeName;
    await s3.send(new DeleteObjectCommand({ Bucket: Z1_BUCKET, Key: key }));
    console.log(`🗑️ Admin deleted s3://${Z1_BUCKET}/${key}`);
    res.json({ success: true });
  } catch (err) {
    console.error('S3 delete error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Public: Get branding images (header/footer) for an event — no auth required, files are public in S3
app.get('/api/events/:eventId/branding', async (req, res) => {
  try {
    const { eventId } = req.params;
    const prefix = eventDocPrefix(eventId, 'branding');
    const data = await s3.send(new ListObjectsV2Command({ Bucket: Z1_BUCKET, Prefix: prefix }));
    const result = { header: null, footer: null };
    for (const obj of (data.Contents || [])) {
      const filename = obj.Key.replace(prefix, '');
      const base = filename.replace(/\.[^.]+$/, '').toLowerCase();
      if (base === 'header') result.header = `${Z1_BASE_URL}/${obj.Key}`;
      if (base === 'footer') result.footer = `${Z1_BASE_URL}/${obj.Key}`;
    }
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, header: null, footer: null });
  }
});

// Admin: Export race entries as Excel (.xlsx) with QR codes and event branding
app.get('/api/admin/events/:eventId/exportExcel', requireAdmin, async (req, res) => {
  try {
    const { eventId } = req.params;

    // ── Fetch entries ──────────────────────────────────────────────────────────
    const { rows: entries } = await pool.query(
      `SELECT
         r.entry_id, r.event_id, r.race_class, r.entry_status,
         d.race_number,
         d.first_name AS driver_first_name, d.last_name AS driver_last_name,
         d.team_name, d.msa_license_number,
         c.full_name AS entrant_name
       FROM race_entries r
       LEFT JOIN drivers d ON r.driver_id = d.driver_id
       LEFT JOIN contacts c ON r.driver_id = c.driver_id
       WHERE r.event_id = $1
         AND r.entry_status != 'cancelled'
         AND (r.race_class IS NOT NULL AND r.race_class != '')
       ORDER BY r.race_class, d.race_number`,
      [eventId]
    );

    // ── Helper: download S3 object as Buffer ──────────────────────────────────
    async function s3ToBuffer(key) {
      try {
        const cmd = new GetObjectCommand({ Bucket: Z1_BUCKET, Key: key });
        const data = await s3.send(cmd);
        const chunks = [];
        for await (const chunk of data.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
      } catch { return null; }
    }

    // ── Fetch branding images from S3 ─────────────────────────────────────────
    const prefix = eventDocPrefix(eventId, 'branding');
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: Z1_BUCKET, Prefix: prefix }));
    let headerKey = null, footerKey = null;
    for (const obj of (listed.Contents || [])) {
      const base = obj.Key.replace(prefix, '').replace(/\.[^.]+$/, '').toLowerCase();
      if (base === 'header') headerKey = obj.Key;
      if (base === 'footer') footerKey = obj.Key;
    }
    const [headerBuf, footerBuf] = await Promise.all([
      headerKey ? s3ToBuffer(headerKey) : null,
      footerKey ? s3ToBuffer(footerKey) : null,
    ]);

    // ── Build workbook ────────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Race Entries');

    // Fixed column widths
    ws.columns = [
      { key: 'race_number',    width: 12  },
      { key: 'race_class',     width: 16  },
      { key: 'driver_name',    width: 26  },
      { key: 'entrant_name',   width: 26  },
      { key: 'team_name',      width: 24  },
      { key: 'msa_license',    width: 20  },
      { key: 'sign',           width: 28  },
      { key: 'qr',             width: 10  },
    ];

    let currentRow = 1;

    // ── Header image ─────────────────────────────────────────────────────────
    const TOTAL_COLS = 8;
    if (headerBuf) {
      const imgId = wb.addImage({ buffer: headerBuf, extension: headerKey.split('.').pop().replace('jpg','jpeg') });
      const HEADER_ROWS = 5;
      ws.addImage(imgId, { tl: { col: 0, row: currentRow - 1 }, br: { col: TOTAL_COLS, row: currentRow - 1 + HEADER_ROWS } });
      for (let r = currentRow; r < currentRow + HEADER_ROWS; r++) ws.getRow(r).height = 18;
      currentRow += HEADER_ROWS;
      ws.getRow(currentRow).height = 6; // gap
      currentRow++;
    }

    // ── Title row ─────────────────────────────────────────────────────────────
    ws.mergeCells(currentRow, 1, currentRow, TOTAL_COLS);
    const titleCell = ws.getCell(currentRow, 1);
    titleCell.value = `Race Entries — ${eventId}`;
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
    titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFD700' } };
    ws.getRow(currentRow).height = 28;
    currentRow++;
    ws.getRow(currentRow).height = 4;
    currentRow++;

    // ── Header row ────────────────────────────────────────────────────────────
    const HEADERS = ['Race #', 'Class', 'Driver Full Name', 'Entrant Full Name', 'Team Name', 'MSA Licence #', 'Entrant Signature', 'QR'];
    const hdrRow  = ws.getRow(currentRow);
    hdrRow.height = 22;
    HEADERS.forEach((h, i) => {
      const cell = hdrRow.getCell(i + 1);
      cell.value = h;
      cell.font  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
    });
    currentRow++;

    // ── Data rows ──────────────────────────────────────────────────────────────
    const ROW_HEIGHT = 56; // pixels — enough for QR
    const QR_SIZE    = 60; // px — QR image

    for (const entry of entries) {
      const rowIdx = currentRow;
      const dataRow = ws.getRow(rowIdx);
      dataRow.height = ROW_HEIGHT;

      const cols = [
        entry.race_number || '',
        entry.race_class  || '',
        [entry.driver_first_name, entry.driver_last_name].filter(Boolean).join(' '),
        entry.entrant_name || '',
        entry.team_name || '',
        entry.msa_license_number || '',
        '',   // Sign column — left blank
      ];

      const isEven  = (rowIdx % 2 === 0);
      const rowFill = isEven
        ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } }
        : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };

      cols.forEach((val, i) => {
        const cell = dataRow.getCell(i + 1);
        cell.value = val;
        cell.font  = { size: 10 };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill  = rowFill;
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
      });

      // QR code image in column 8
      try {
        const qrData = entry.entry_id || entry.race_number || String(rowIdx);
        const qrBuf  = await QRCode.toBuffer(String(qrData), { width: QR_SIZE, margin: 1 });
        const qrId   = wb.addImage({ buffer: qrBuf, extension: 'png' });
        // Position: tl/br in fractions of column/row — leave 1px padding
        ws.addImage(qrId, {
          tl: { col: 7.1, row: rowIdx - 1 + 0.1 },
          br: { col: 8,   row: rowIdx - 1 + 0.9 },
          editAs: 'oneCell'
        });
      } catch { /* skip QR on error */ }

      // Border for QR cell
      const qrCell = dataRow.getCell(8);
      qrCell.fill   = rowFill;
      qrCell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };

      currentRow++;
    }

    // ── Footer image ─────────────────────────────────────────────────────────
    if (footerBuf) {
      ws.getRow(currentRow).height = 6;
      currentRow++;
      const footerId = wb.addImage({ buffer: footerBuf, extension: footerKey.split('.').pop().replace('jpg','jpeg') });
      const FOOTER_ROWS = 4;
      ws.addImage(footerId, { tl: { col: 0, row: currentRow - 1 }, br: { col: TOTAL_COLS, row: currentRow - 1 + FOOTER_ROWS } });
      for (let r = currentRow; r < currentRow + FOOTER_ROWS; r++) ws.getRow(r).height = 15;
    }

    // ── Freeze header ────────────────────────────────────────────────────────
    ws.views = [{ state: 'frozen', ySplit: headerBuf ? 9 : 3 }];

    // ── Send file ────────────────────────────────────────────────────────────
    const safeName = eventId.replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Race_Entries_${safeName}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Excel export error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Get a single race entry by ID (for pre-populating the Update Entry Items modal)
app.get('/api/admin/getEntry/:entryId', requireAdmin, async (req, res) => {
  try {
    const { entryId } = req.params;
    const result = await pool.query(
      `SELECT re.*, d.first_name, d.last_name, c.email AS driver_email
       FROM race_entries re
       LEFT JOIN drivers d ON re.driver_id = d.driver_id
       LEFT JOIN contacts c ON re.driver_id = c.driver_id
       WHERE re.entry_id = $1`,
      [entryId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Entry not found' });
    }
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('Error fetching entry:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Get all ticket HTML for a single race entry (for PDF download)
app.get('/api/admin/entryTicketsHTML/:entryId', requireAdmin, async (req, res) => {
  try {
    const { entryId } = req.params;

    const result = await pool.query(
      `SELECT
        re.*,
        d.first_name, d.last_name, d.race_number AS driver_race_number,
        c.email AS driver_email,
        e.event_name, e.event_date, e.location
       FROM race_entries re
       LEFT JOIN drivers d ON re.driver_id = d.driver_id
       LEFT JOIN contacts c ON re.driver_id = c.driver_id
       LEFT JOIN events e ON re.event_id = e.event_id
       WHERE re.entry_id = $1`,
      [entryId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Entry not found' });
    }

    const entry = result.rows[0];
    const driverName = `${entry.first_name || ''} ${entry.last_name || ''}`.trim();
    const raceNumber = entry.driver_race_number || entry.race_number || '';

    // Parse entry_items
    let entryItems = [];
    if (entry.entry_items) {
      try { entryItems = JSON.parse(entry.entry_items); } catch { entryItems = [entry.entry_items]; }
    }
    const itemIncludes = (term) => entryItems.some(i => String(i).toLowerCase().includes(term));
    const hasEngine = itemIncludes('engine') || entry.engine == 1;
    const hasTyres = itemIncludes('tyre');
    const hasTransponder = itemIncludes('transponder');
    const hasFuel = itemIncludes('fuel');

    // Helper to parse multi-ref fields (may be JSON array or plain string)
    const parseRefs = (field) => {
      if (!field) return [];
      try { const p = JSON.parse(field); return Array.isArray(p) ? p : [field]; } catch { return [field]; }
    };

    // Build page-break-separated ticket HTML
    const PAGE_BREAK = '<div style="page-break-after:always;"></div>';
    const ticketParts = [];

    // Race entry ticket (reference = payment_reference)
    const raceRef = entry.payment_reference || String(entry.entry_id);
    ticketParts.push(generateRaceTicketHTML({
      reference: raceRef,
      eventName: entry.event_name || 'Race Event',
      eventDate: entry.event_date,
      eventLocation: entry.location || '',
      raceClass: entry.race_class || '',
      driverName,
      raceNumber,
      teamCode: entry.team_code || ''
    }));

    // Engine rental tickets
    if (hasEngine && entry.ticket_engine_ref) {
      const refs = parseRefs(entry.ticket_engine_ref);
      const dayLabels = refs.length >= 3
        ? ['FRIDAY – PRACTICE DAY', 'SATURDAY', 'SUNDAY']
        : refs.length === 2 ? ['SATURDAY', 'SUNDAY'] : [''];
      refs.forEach((ref, i) => {
        ticketParts.push(generateEngineRentalTicketHTML({
          reference: ref, eventName: entry.event_name, eventDate: entry.event_date,
          eventLocation: entry.location, raceClass: entry.race_class, driverName,
          raceNumber, dayLabel: dayLabels[i] || ''
        }));
      });
    }

    // Tyre rental tickets
    if (hasTyres && entry.ticket_tyres_ref) {
      const refs = parseRefs(entry.ticket_tyres_ref);
      const dayLabels = refs.length >= 2 ? ['SATURDAY', 'SUNDAY'] : [''];
      refs.forEach((ref, i) => {
        ticketParts.push(generateTyreRentalTicketHTML({
          reference: ref, eventName: entry.event_name, eventDate: entry.event_date,
          eventLocation: entry.location, raceClass: entry.race_class, driverName,
          raceNumber, dayLabel: dayLabels[i] || ''
        }));
      });
    }

    // Transponder rental tickets
    if (hasTransponder && entry.ticket_transponder_ref) {
      const refs = parseRefs(entry.ticket_transponder_ref);
      const dayLabels = refs.length >= 2 ? ['SATURDAY', 'SUNDAY'] : [''];
      refs.forEach((ref, i) => {
        ticketParts.push(generateTransponderRentalTicketHTML({
          reference: ref, eventName: entry.event_name, eventDate: entry.event_date,
          eventLocation: entry.location, raceClass: entry.race_class, driverName,
          raceNumber, dayLabel: dayLabels[i] || ''
        }));
      });
    }

    // Fuel ticket
    if (hasFuel && entry.ticket_fuel_ref) {
      const refs = parseRefs(entry.ticket_fuel_ref);
      const dayLabel = refs.length >= 3 ? 'FRIDAY · SATURDAY · SUNDAY' : '';
      ticketParts.push(generateFuelTicketHTML({
        reference: refs[0], eventName: entry.event_name, eventDate: entry.event_date,
        eventLocation: entry.location, raceClass: entry.race_class, driverName,
        raceNumber, dayLabel
      }));
    }

    const combinedHTML = ticketParts.join(PAGE_BREAK);

    res.json({
      success: true,
      html: combinedHTML,
      driverName,
      raceNumber,
      ticketCount: ticketParts.length
    });
  } catch (err) {
    console.error('❌ entryTicketsHTML error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Handle 404 for API routes — must be after ALL route registrations
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found' });
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    pool.end().then(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    pool.end().then(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});
