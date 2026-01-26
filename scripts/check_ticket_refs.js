require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function checkTicketRefs() {
  try {
    // Check recent entries
    console.log('🔍 Checking recent race entries...\n');
    
    const result = await pool.query(`
      SELECT 
        entry_id,
        driver_id,
        event_id,
        race_class,
        entry_items,
        ticket_engine_ref,
        ticket_tyres_ref,
        ticket_transponder_ref,
        ticket_fuel_ref,
        created_at
      FROM race_entries 
      ORDER BY created_at DESC 
      LIMIT 5
    `);
    
    if (result.rows.length === 0) {
      console.log('❌ No race entries found');
      await pool.end();
      return;
    }
    
    console.log(`✅ Found ${result.rows.length} recent entries:\n`);
    
    result.rows.forEach((entry, index) => {
      console.log(`Entry ${index + 1}:`);
      console.log(`  Entry ID: ${entry.entry_id}`);
      console.log(`  Driver ID: ${entry.driver_id}`);
      console.log(`  Event ID: ${entry.event_id}`);
      console.log(`  Race Class: ${entry.race_class}`);
      console.log(`  Entry Items: ${entry.entry_items}`);
      console.log(`  Engine Ticket: ${entry.ticket_engine_ref || 'NULL'}`);
      console.log(`  Tyres Ticket: ${entry.ticket_tyres_ref || 'NULL'}`);
      console.log(`  Transponder Ticket: ${entry.ticket_transponder_ref || 'NULL'}`);
      console.log(`  Fuel Ticket: ${entry.ticket_fuel_ref || 'NULL'}`);
      console.log(`  Created: ${entry.created_at}`);
      console.log('');
    });
    
    // Check if columns exist
    console.log('🔍 Checking if ticket columns exist in table...\n');
    const columnsResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'race_entries' 
      AND column_name LIKE 'ticket_%'
      ORDER BY column_name
    `);
    
    if (columnsResult.rows.length === 0) {
      console.log('❌ Ticket columns do NOT exist in race_entries table!');
    } else {
      console.log('✅ Ticket columns found:');
      columnsResult.rows.forEach(col => {
        console.log(`  - ${col.column_name} (${col.data_type})`);
      });
    }
    
    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    await pool.end();
    process.exit(1);
  }
}

checkTicketRefs();
