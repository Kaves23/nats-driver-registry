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

async function findJohn() {
  try {
    const result = await pool.query(`
      SELECT driver_id, first_name, last_name 
      FROM drivers 
      WHERE first_name ILIKE 'joh%'
      ORDER BY last_name
    `);
    
    console.log(`Found ${result.rows.length} drivers named John:`);
    result.rows.forEach(d => {
      console.log(`  - ${d.first_name} ${d.last_name} (${d.driver_id})`);
    });
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

findJohn();
