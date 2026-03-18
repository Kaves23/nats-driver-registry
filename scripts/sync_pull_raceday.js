/**
 * sync_pull_raceday.js
 * Run the NIGHT BEFORE the race to seed the local PostgreSQL database
 * with a full snapshot from the cloud.
 *
 * Usage: node scripts/sync_pull_raceday.js
 * (run from D:\LIVENATSSITE with .env.raceday already configured)
 */
require('dotenv').config({ path: '.env.raceday' });
const { Pool } = require('pg');

const cloudPool = new Pool({
  host:     process.env.CLOUD_DB_HOST,
  port:     parseInt(process.env.CLOUD_DB_PORT || '6432'),
  database: process.env.CLOUD_DB_DATABASE,
  user:     process.env.CLOUD_DB_USERNAME,
  password: process.env.CLOUD_DB_PASSWORD,
  ssl:      { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 10000
});

const localPool = new Pool({
  host:     'localhost',
  port:     5432,
  database: 'nats_raceday',
  user:     'nats',
  password: 'natslocal',
  ssl:      false,
  max: 3
});

// Tables to snapshot in dependency order (parents before children)
const TABLES = [
  'events',
  'drivers',
  'contacts',
  'engines',
  'engine_assignments',
  'race_entries',
  'audit_log',
  'event_class_pricing',
  'equipment_scan_log',
  'tyre_scans',
  'part_changes',
  'transponders'
];

async function getLocalColumns(tableName) {
  const { rows } = await localPool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'`,
    [tableName]
  );
  return rows.map(r => r.column_name);
}

async function pullTable(tableName, localClient) {
  process.stdout.write(`  Pulling ${tableName}... `);

  // Check table exists in local DB
  const { rows: tableCheck } = await localPool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_schema = 'public'`,
    [tableName]
  );
  if (!tableCheck.length) {
    console.log('⚠️  SKIPPED (table does not exist locally)');
    return 0;
  }

  // Get columns that exist in BOTH cloud and local
  const localCols = await getLocalColumns(tableName);
  const { rows: cloudRows } = await cloudPool.query(`SELECT * FROM ${tableName} LIMIT 1`);
  if (!cloudRows.length) {
    // table exists but is empty — just truncate local and return
    await localClient.query(`TRUNCATE TABLE ${tableName} CASCADE`);
    console.log('(empty)');
    return 0;
  }
  const cloudCols = Object.keys(cloudRows[0]);
  const cols = cloudCols.filter(c => localCols.includes(c));

  if (!cols.length) {
    console.log('⚠️  SKIPPED (no matching columns)');
    return 0;
  }

  // Fetch all rows from cloud using only matching columns
  const { rows } = await cloudPool.query(`SELECT ${cols.map(c => `"${c}"`).join(',')} FROM ${tableName}`);

  // Clear local table (CASCADE handles FK children)
  await localClient.query(`TRUNCATE TABLE ${tableName} CASCADE`);

  let inserted = 0;
  for (const row of rows) {
    const vals = cols.map(c => row[c]);
    const ph   = cols.map((_, i) => `$${i + 1}`).join(',');
    try {
      await localClient.query(
        `INSERT INTO ${tableName} (${cols.map(c => `"${c}"`).join(',')}) VALUES (${ph}) ON CONFLICT DO NOTHING`,
        vals
      );
      inserted++;
    } catch (e) {
      // skip individual bad rows silently
    }
  }
  console.log(`${inserted} rows ✓`);
  return inserted;
}

(async () => {
  let totalRows = 0;
  try {
    // Test connections
    await cloudPool.query('SELECT 1');
    console.log('✅ Cloud DB connected');
    await localPool.query('SELECT 1');
    console.log('✅ Local DB connected');
    console.log('');
    console.log('📥 Pulling snapshot from cloud...');
    console.log('─'.repeat(40));

    // Use a single client so session_replication_role applies to all operations
    const localClient = await localPool.connect();
    try {
      await localClient.query('SET session_replication_role = replica');
      for (const table of TABLES) {
        try {
          totalRows += await pullTable(table, localClient);
        } catch (e) {
          console.log(`⚠️  SKIPPED (${e.message})`);
        }
      }
    } finally {
      await localClient.query('SET session_replication_role = DEFAULT');
      localClient.release();
    }

    console.log('─'.repeat(40));
    console.log(`\n✅ Done! ${totalRows} total rows copied to local DB.`);
    console.log('   The laptop is ready for race day.\n');
  } catch (e) {
    console.error('\n❌ Fatal error:', e.message);
    console.error('   Check that PostgreSQL is running and .env.raceday is correct.\n');
    process.exit(1);
  } finally {
    await cloudPool.end().catch(() => {});
    await localPool.end().catch(() => {});
  }
})();
