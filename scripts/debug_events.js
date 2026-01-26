// Debug script to check driver events
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: true }
});

async function debugDriverEvents() {
  try {
    // 1. Find driver by email from contacts table
    console.log('\n=== Looking for driver with email containing: win ===');
    const driverResult = await pool.query(
      `SELECT d.driver_id, d.first_name, d.last_name, c.email 
       FROM drivers d 
       JOIN contacts c ON d.driver_id = c.driver_id 
       WHERE c.email ILIKE '%win%' 
       LIMIT 5`
    );
    
    if (driverResult.rows.length === 0) {
      console.log('❌ No driver found with email containing "win"');
      await pool.end();
      return;
    }
    
    console.log(`✅ Found ${driverResult.rows.length} driver(s):`);
    driverResult.rows.forEach(d => console.log(d));
    
    const driver = driverResult.rows[0];
    console.log('\n=== Using first driver for analysis ===');
    
    // 2. Check race_entries for this driver
    console.log('\n=== Checking race_entries table ===');
    const entriesResult = await pool.query(
      `SELECT * FROM race_entries WHERE driver_id = $1`,
      [driver.driver_id]
    );
    
    console.log(`Found ${entriesResult.rows.length} race entries:`);
    entriesResult.rows.forEach((entry, i) => {
      console.log(`\nEntry ${i + 1}:`, {
        entry_id: entry.entry_id,
        event_id: entry.event_id,
        race_class: entry.race_class,
        payment_status: entry.payment_status,
        entry_status: entry.entry_status,
        amount_paid: entry.amount_paid
      });
    });
    
    // 3. Check events table
    console.log('\n=== Checking events table ===');
    const eventsResult = await pool.query(`SELECT * FROM events ORDER BY event_date DESC`);
    console.log(`Found ${eventsResult.rows.length} events:`);
    eventsResult.rows.forEach((event, i) => {
      console.log(`\nEvent ${i + 1}:`, {
        event_id: event.event_id,
        event_name: event.event_name,
        event_date: event.event_date,
        location: event.location
      });
    });
    
    // 4. Try the JOIN query
    console.log('\n=== Testing JOIN query ===');
    const joinResult = await pool.query(
      `SELECT r.race_entry_id, r.entry_id, r.event_id, e.event_name, e.event_date, e.location,
              r.payment_status, r.entry_status, r.amount_paid, r.payment_reference,
              r.race_class, r.race_number, r.notes, r.created_at
       FROM race_entries r
       JOIN events e ON r.event_id = e.event_id
       WHERE r.driver_id = $1
       ORDER BY e.event_date DESC`,
      [driver.driver_id]
    );
    
    console.log(`\n✅ JOIN query returned ${joinResult.rows.length} results:`);
    joinResult.rows.forEach((row, i) => {
      console.log(`\nResult ${i + 1}:`, row);
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

debugDriverEvents();
