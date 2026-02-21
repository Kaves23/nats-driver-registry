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
    const cols = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='drivers' ORDER BY ordinal_position`
    );
    console.log('DRIVERS COLUMNS:', cols.rows.map(r => r.column_name).join(', '));

    // Check if msa_license or similar field exists
    const licenseCol = cols.rows.find(r => r.column_name.includes('license') || r.column_name.includes('msa'));
    console.log('LICENSE COLUMN:', licenseCol ? licenseCol.column_name : 'NOT FOUND');

    // Sample a few drivers to see name format
    const sample = await pool.query(
      `SELECT driver_id, first_name, last_name, class, championship, race_number FROM drivers LIMIT 10`
    );
    console.log('SAMPLE DRIVERS:', JSON.stringify(sample.rows, null, 2));

    process.exit(0);
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
})();
