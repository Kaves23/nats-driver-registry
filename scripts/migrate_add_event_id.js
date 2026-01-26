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

async function migrate() {
  try {
    console.log('🔄 Starting migration...');

    // Check if event_id column already exists
    const checkCol = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'race_entries' AND column_name = 'event_id'
    `);

    if (checkCol.rows.length > 0) {
      console.log('ℹ️  event_id column already exists');
      pool.end();
      process.exit(0);
    }

    // Add event_id column
    console.log('➕ Adding event_id column to race_entries table...');
    await pool.query(`
      ALTER TABLE race_entries 
      ADD COLUMN event_id character varying
    `);

    console.log('✅ event_id column added');

    // Add created_at and updated_at columns if they don't exist
    const checkCreated = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'race_entries' AND column_name = 'created_at'
    `);

    if (checkCreated.rows.length === 0) {
      console.log('➕ Adding created_at column...');
      await pool.query(`
        ALTER TABLE race_entries 
        ADD COLUMN created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
      `);
      console.log('✅ created_at column added');
    }

    const checkUpdated = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'race_entries' AND column_name = 'updated_at'
    `);

    if (checkUpdated.rows.length === 0) {
      console.log('➕ Adding updated_at column...');
      await pool.query(`
        ALTER TABLE race_entries 
        ADD COLUMN updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
      `);
      console.log('✅ updated_at column added');
    }

    // Add entry_status column if it doesn't exist (for new event entries)
    const checkStatus = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'race_entries' AND column_name = 'entry_status'
    `);

    if (checkStatus.rows.length === 0) {
      console.log('➕ Adding entry_status column...');
      await pool.query(`
        ALTER TABLE race_entries 
        ADD COLUMN entry_status character varying DEFAULT 'pending'
      `);
      console.log('✅ entry_status column added');
    }

    // Add amount_paid column if it doesn't exist
    const checkAmount = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'race_entries' AND column_name = 'amount_paid'
    `);

    if (checkAmount.rows.length === 0) {
      console.log('➕ Adding amount_paid column...');
      await pool.query(`
        ALTER TABLE race_entries 
        ADD COLUMN amount_paid numeric DEFAULT 0
      `);
      console.log('✅ amount_paid column added');
    }

    console.log('\n✅ Migration complete!');
    console.log('\nUpdated race_entries table columns:');
    const result = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'race_entries'
      ORDER BY ordinal_position
    `);
    result.rows.forEach(col => {
      console.log(`   - ${col.column_name}: ${col.data_type}`);
    });

    pool.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration error:', err.message);
    pool.end();
    process.exit(1);
  }
}

migrate();
