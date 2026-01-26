const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'us-east-3.pg.psdb.cloud',
  port: parseInt(process.env.DB_PORT) || 6432,
  database: process.env.DB_DATABASE || 'postgres',
  user: process.env.DB_USERNAME || 'postgres.xhjhjl0nh1cp',
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000
});

async function checkPointsTable() {
  try {
    // Check if points table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'points'
      );
    `);
    
    console.log('Points table exists:', tableCheck.rows[0].exists);
    
    if (tableCheck.rows[0].exists) {
      // Get table structure
      const columns = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'points'
        ORDER BY ordinal_position;
      `);
      
      console.log('\nPoints table columns:');
      columns.rows.forEach(col => {
        console.log(`  - ${col.column_name}: ${col.data_type} (${col.is_nullable})`);
      });
      
      // Check row count
      const count = await pool.query('SELECT COUNT(*) FROM points');
      console.log(`\nTotal points records: ${count.rows[0].count}`);
      
      // Get sample data if any
      if (parseInt(count.rows[0].count) > 0) {
        const sample = await pool.query('SELECT * FROM points LIMIT 3');
        console.log('\nSample data:');
        console.log(sample.rows);
      }
    } else {
      console.log('\n⚠️  Points table does not exist. Will need to create it.');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

checkPointsTable();
