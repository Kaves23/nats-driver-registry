const { Pool } = require('pg');

// Production database configuration (Internal connection from Render)
const pool = new Pool({
  host: 'dpg-ctap62pu0jms738m3l50-a',
  port: 5432,
  database: 'nats_db',
  user: 'nats_db_user',
  password: '5dCHkJtV4x5wd0UrsGmfEiWMqIy0tSMS'
});

async function checkVenterEntries() {
  try {
    console.log('🔍 Checking for Venter drivers in production...\n');
    
    // Find all Venter drivers
    const drivers = await pool.query(
      `SELECT driver_id, first_name, last_name, email, class, status, 
              transponder_number, season_payment_status
       FROM drivers 
       WHERE last_name ILIKE '%venter%'
       ORDER BY last_name, first_name`
    );
    
    console.log(`Found ${drivers.rows.length} Venter driver(s):\n`);
    drivers.rows.forEach(d => {
      console.log(`  📍 ${d.first_name} ${d.last_name}`);
      console.log(`     Driver ID: ${d.driver_id}`);
      console.log(`     Email: ${d.email}`);
      console.log(`     Class: ${d.class}`);
      console.log(`     Status: ${d.status}`);
      console.log(`     Transponder: ${d.transponder_number || 'N/A'}`);
      console.log(`     Season Payment: ${d.season_payment_status || 'N/A'}\n`);
    });
    
    // Check race entries for event_redstar_001
    console.log('\n🏁 Checking race entries for Feb 14 Red Star event (event_redstar_001)...\n');
    
    const entries = await pool.query(
      `SELECT re.*, d.first_name, d.last_name, d.class as driver_class
       FROM race_entries re
       LEFT JOIN drivers d ON re.driver_id = d.driver_id
       WHERE re.event_id = 'event_redstar_001'
         AND d.last_name ILIKE '%venter%'
       ORDER BY re.created_at DESC`
    );
    
    if (entries.rows.length === 0) {
      console.log('❌ No Venter entries found for this event.');
    } else {
      console.log(`Found ${entries.rows.length} Venter entry/entries:\n`);
      entries.rows.forEach(e => {
        console.log(`  🎫 ${e.first_name} ${e.last_name}`);
        console.log(`     Entry ID: ${e.race_entry_id}`);
        console.log(`     Race Class: ${e.race_class || 'NOT SET'}`);
        console.log(`     Driver Class: ${e.driver_class}`);
        console.log(`     Payment Status: ${e.payment_status}`);
        console.log(`     Entry Status: ${e.entry_status}`);
        console.log(`     Payment Ref: ${e.payment_reference || 'N/A'}`);
        console.log(`     Amount: R${e.amount_paid || 0}`);
        console.log(`     Entry Items: ${e.entry_items ? JSON.stringify(e.entry_items) : '[]'}`);
        console.log(`     Created: ${e.created_at}\n`);
      });
    }
    
    // Check all race entries for these drivers (any event)
    console.log('\n📋 All race entries for Venter drivers (all events):\n');
    
    const allEntries = await pool.query(
      `SELECT re.*, d.first_name, d.last_name
       FROM race_entries re
       LEFT JOIN drivers d ON re.driver_id = d.driver_id
       WHERE d.last_name ILIKE '%venter%'
       ORDER BY re.created_at DESC`
    );
    
    if (allEntries.rows.length === 0) {
      console.log('❌ No race entries found for Venter drivers.');
    } else {
      console.log(`Found ${allEntries.rows.length} total entry/entries:\n`);
      allEntries.rows.forEach(e => {
        console.log(`  • ${e.first_name} ${e.last_name} - Event: ${e.event_id}`);
        console.log(`    Class: ${e.race_class || 'NOT SET'} | Status: ${e.payment_status} | Ref: ${e.payment_reference || 'N/A'}`);
      });
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await pool.end();
  }
}

checkVenterEntries();
