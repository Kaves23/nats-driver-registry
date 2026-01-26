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

async function addColumn() {
  try {
    await pool.query(`
      ALTER TABLE drivers 
      ADD COLUMN IF NOT EXISTS season_entry_status VARCHAR(50) DEFAULT 'Not Registered'
    `);
    console.log('✅ Added season_entry_status column to drivers table');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

addColumn();
