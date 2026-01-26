#!/usr/bin/env node
/**
 * Manual Update Script: Set engine and team_code for test entries
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

async function updateTestEntries() {
  try {
    console.log('🔄 Starting retroactive population of engine and team_code...\n');

    // Get the test driver by email from contacts table
    const driverResult = await pool.query(
      `SELECT d.driver_id FROM drivers d 
       JOIN contacts c ON d.driver_id = c.driver_id 
       WHERE LOWER(c.email) = 'win@rokthenats.co.za' 
       LIMIT 1`
    );

    if (driverResult.rows.length === 0) {
      console.error('❌ Test driver not found with email win@rokthenats.co.za');
      process.exit(1);
    }

    const driverId = driverResult.rows[0].driver_id;
    console.log(`✅ Found driver: ${driverId}\n`);

    // Get all entries for this driver
    const entriesResult = await pool.query(
      `SELECT entry_id, driver_id, entry_items, engine, team_code, created_at FROM race_entries WHERE driver_id = $1 ORDER BY created_at DESC`,
      [driverId]
    );

    console.log(`📊 Found ${entriesResult.rows.length} race entries for this driver:\n`);
    
    entriesResult.rows.forEach((entry, idx) => {
      console.log(`${idx + 1}. Entry ID: ${entry.entry_id}`);
      console.log(`   Created: ${entry.created_at}`);
      console.log(`   Current engine: ${entry.engine}, team_code: ${entry.team_code}`);
    });

    // Update all entries to have engine = 1 and team_code = 'k0k0r0'
    const updateResult = await pool.query(
      `UPDATE race_entries SET engine = 1, team_code = 'k0k0r0' WHERE driver_id = $1 RETURNING entry_id, engine, team_code`,
      [driverId]
    );

    console.log(`\n✅ Updated ${updateResult.rows.length} entries:\n`);
    
    updateResult.rows.forEach((entry, idx) => {
      console.log(`${idx + 1}. Entry ${entry.entry_id}:`);
      console.log(`   - engine: ${entry.engine}`);
      console.log(`   - team_code: ${entry.team_code}`);
    });

    console.log('\n✅ Retroactive population completed successfully!');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

updateTestEntries();
