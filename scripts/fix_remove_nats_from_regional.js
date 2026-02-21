/**
 * Remove incorrectly added ROK NATS rows for the NR Round 1 regional race.
 * Regional races only score Northern Regions — not NATS.
 */
require('dotenv').config();
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
  try {
    const result = await pool.query(
      `DELETE FROM points WHERE championship_type = 'ROK NATS' RETURNING points_id`
    );
    console.log(`✅ Removed ${result.rowCount} incorrect ROK NATS rows from regional race.`);

    const remaining = await pool.query(`SELECT COUNT(*) FROM points`);
    console.log(`   Remaining records: ${remaining.rows[0].count} (all Northern Regions)`);

    process.exit(0);
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
})();
