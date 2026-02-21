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
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='points' ORDER BY ordinal_position`
    );
    console.log('COLUMNS:', cols.rows.map(r => r.column_name).join(', '));

    const cnt = await pool.query('SELECT COUNT(*) FROM points');
    console.log('TOTAL ROWS:', cnt.rows[0].count);

    const sample = await pool.query('SELECT * FROM points LIMIT 5');
    console.log('SAMPLE:', JSON.stringify(sample.rows, null, 2));

    const winDriver = await pool.query(
      `SELECT d.driver_id, d.first_name, d.last_name, d.class, d.championship
       FROM contacts c JOIN drivers d ON c.driver_id = d.driver_id
       WHERE c.email = 'win@rokthenats.co.za'`
    );
    console.log('WIN DRIVER:', JSON.stringify(winDriver.rows, null, 2));

    process.exit(0);
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
})();
