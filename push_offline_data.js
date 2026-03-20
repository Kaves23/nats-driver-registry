/**
 * Standalone end-of-day push script.
 * Reads all engine draws + race_entries engine fields from the local raceday DB
 * and upserts them into the cloud DB.
 *
 * Run from C:\NATSSITE:
 *   node push_offline_data.js
 *
 * (Server does NOT need to be running)
 */

require('dotenv').config({ path: '.env.raceday' });
const { Pool } = require('pg');

const localPool = new Pool({
  host:     'localhost',
  port:     5432,
  database: 'nats_raceday',
  user:     'nats',
  password: 'natslocal',
  ssl:      false
});

const cloudPool = new Pool({
  host:                   process.env.CLOUD_DB_HOST,
  port:                   parseInt(process.env.CLOUD_DB_PORT || '6432'),
  database:               process.env.CLOUD_DB_DATABASE,
  user:                   process.env.CLOUD_DB_USERNAME,
  password:               process.env.CLOUD_DB_PASSWORD,
  ssl:                    { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

async function main() {
  console.log('\n=== OFFLINE DATA PUSH ===\n');

  console.log('Connecting to local DB...');
  await localPool.query('SELECT 1');
  console.log('✅ Local DB OK');

  console.log('Connecting to cloud DB...');
  await cloudPool.query('SELECT 1');
  console.log('✅ Cloud DB OK\n');

  // ── 1. entry_engine_draws ─────────────────────────────────────────────
  const { rows: draws } = await localPool.query(
    `SELECT entry_id, engine_serial, draw_number, day_label, assigned_at,
            returned, returned_at, engine_issue, replaced_by, notes
     FROM entry_engine_draws ORDER BY assigned_at`
  );
  console.log(`Found ${draws.length} draw records in local DB...`);

  let pushed = 0, updated = 0, skipped = 0;
  for (const row of draws) {
    const ins = await cloudPool.query(
      `INSERT INTO entry_engine_draws
         (entry_id, engine_serial, draw_number, day_label, assigned_at,
          returned, returned_at, engine_issue, replaced_by, notes)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
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
      pushed++;
      console.log(`  ↑ NEW   ${row.day_label || 'today'} | ${row.engine_serial.padEnd(10)} | ${row.entry_id}`);
    } else if (row.returned) {
      const upd = await cloudPool.query(
        `UPDATE entry_engine_draws
         SET returned=$3, returned_at=$4, engine_issue=$5
         WHERE entry_id=$1 AND UPPER(engine_serial)=UPPER($2) AND returned=false`,
        [row.entry_id, row.engine_serial, row.returned, row.returned_at, row.engine_issue]
      );
      if (upd.rowCount > 0) { updated++; console.log(`  ↺ UPDT  ${row.engine_serial.padEnd(10)} returned`); }
      else skipped++;
    } else {
      skipped++;
    }
  }
  console.log(`\n✅ Draws: ${pushed} new | ${updated} return-updated | ${skipped} already synced`);

  // ── 2. race_entries engine columns ────────────────────────────────────
  const { rows: entries } = await localPool.query(
    `SELECT entry_id, engine_serial, engine_assigned_at, engine_returned, engine_returned_at
     FROM race_entries WHERE engine_serial IS NOT NULL`
  );
  console.log(`\nUpdating ${entries.length} race_entries engine fields...`);
  let entriesUpdated = 0;
  for (const row of entries) {
    const upd = await cloudPool.query(
      `UPDATE race_entries
       SET engine_serial=$2, engine_assigned_at=$3, engine_returned=$4,
           engine_returned_at=$5, updated_at=NOW()
       WHERE entry_id=$1`,
      [row.entry_id, row.engine_serial, row.engine_assigned_at,
       row.engine_returned, row.engine_returned_at]
    );
    if (upd.rowCount > 0) entriesUpdated++;
  }
  console.log(`✅ Race entries: ${entriesUpdated} updated`);

  console.log('\n🎉 Push complete!\n');
  await localPool.end();
  await cloudPool.end();
}

main().catch(async e => {
  console.error('\n❌ Push failed:', e.message);
  await localPool.end().catch(() => {});
  await cloudPool.end().catch(() => {});
  process.exit(1);
});
