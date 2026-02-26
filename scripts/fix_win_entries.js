require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  // 1. Find driver
  const drv = await pool.query(
    `SELECT d.driver_id, d.first_name, d.last_name, d.next_race_entry_status
     FROM drivers d
     JOIN contacts c ON c.driver_id = d.driver_id
     WHERE c.email = 'win@rokthenats.co.za'`
  );
  if (!drv.rows.length) { console.log('Driver not found'); await pool.end(); return; }
  const driver = drv.rows[0];
  const did = driver.driver_id;
  console.log(`Found driver: ${driver.first_name} ${driver.last_name} (${did})`);

  // 2. Get all entries sorted oldest first
  const entries = await pool.query(
    `SELECT re.entry_id, re.race_class, re.payment_status, re.amount_paid, re.created_at
     FROM race_entries re
     WHERE re.driver_id = $1
     ORDER BY re.created_at ASC`,
    [did]
  );
  console.log(`Total entries: ${entries.rows.length}`);

  if (entries.rows.length <= 1) { console.log('Nothing to clean up'); await pool.end(); return; }

  // Keep the first Completed entry, fall back to very first entry
  const keepEntry = entries.rows.find(r => r.payment_status === 'Completed') || entries.rows[0];
  console.log(`Keeping entry: ${keepEntry.entry_id} (${keepEntry.payment_status}, amount: ${keepEntry.amount_paid})`);

  const toDelete = entries.rows.filter(r => r.entry_id !== keepEntry.entry_id).map(r => r.entry_id);
  console.log(`Deleting ${toDelete.length} duplicate entries...`);

  for (const id of toDelete) {
    await pool.query('DELETE FROM race_entries WHERE entry_id = $1', [id]);
    console.log(`  Deleted: ${id}`);
  }

  // 3. Reset next_race_entry_status since Feb 14 race is complete
  await pool.query(
    `UPDATE drivers SET next_race_entry_status = NULL, next_race_engine_rental_status = NULL WHERE driver_id = $1`,
    [did]
  );
  console.log('Reset next_race_entry_status and next_race_engine_rental_status to NULL');

  // 4. Add msa_license_number column if it doesn't exist
  await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS msa_license_number VARCHAR(100)`);
  console.log('msa_license_number column ensured on drivers table');

  console.log('\nAll done!');
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
