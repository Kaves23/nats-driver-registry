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

// Tables to snapshot — add any new tables here
const TABLES = [
  'drivers',
  'contacts',
  'engines',
  'engine_assignments',
  'race_entries',
  'audit_log',
  'events',
  'event_class_pricing',
  'equipment_scan_log',
  'tyre_scans',
  'part_changes',
  'transponders'
];

async function pullTable(tableName) {
  process.stdout.write(`  Pulling ${tableName}... `);
  const { rows } = await cloudPool.query(`SELECT * FROM ${tableName}`);
  if (!rows.length) {
    console.log('(empty)');
    return 0;
  }
  const cols = Object.keys(rows[0]);
  await localPool.query(`DELETE FROM ${tableName}`);
  let inserted = 0;
  for (const row of rows) {
    const vals = cols.map(c => row[c]);
    const ph   = cols.map((_, i) => `$${i + 1}`).join(',');
    await localPool.query(
      `INSERT INTO ${tableName} (${cols.join(',')}) VALUES (${ph}) ON CONFLICT DO NOTHING`,
      vals
    );
    inserted++;
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

    for (const table of TABLES) {
      try {
        totalRows += await pullTable(table);
      } catch (e) {
        console.log(`⚠️  SKIPPED (${e.message})`);
      }
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
