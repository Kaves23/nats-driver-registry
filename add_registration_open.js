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

async function addRegistrationOpenColumn() {
  const client = await pool.connect();
  
  try {
    console.log('🔧 Adding registration_open column to events table...');
    
    // Check if column exists
    const checkColumn = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'events' AND column_name = 'registration_open'
    `);
    
    if (checkColumn.rows.length > 0) {
      console.log('✅ Column registration_open already exists');
    } else {
      // Add the column with default value false
      await client.query(`
        ALTER TABLE events 
        ADD COLUMN registration_open BOOLEAN DEFAULT false
      `);
      console.log('✅ Added registration_open column (defaults to false)');
    }
    
    // Show current events
    const events = await client.query('SELECT event_id, event_name, registration_open FROM events');
    console.log(`\n📊 Current events (${events.rows.length}):`);
    events.rows.forEach(e => {
      console.log(`  - ${e.event_name}: registration_open = ${e.registration_open}`);
    });
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

addRegistrationOpenColumn();
