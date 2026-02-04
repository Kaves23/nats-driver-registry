// Check Klassen's entry data
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function checkKlassenEntry() {
  try {
    const result = await pool.query(`
      SELECT 
        re.entry_id,
        re.driver_id,
        re.race_class,
        re.entry_items,
        re.engine,
        re.ticket_engine_ref,
        re.ticket_tyres_ref,
        re.ticket_transponder_ref,
        re.ticket_fuel_ref,
        re.payment_status,
        re.entry_status,
        d.first_name,
        d.last_name,
        c.email
      FROM race_entries re
      LEFT JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN contacts c ON re.driver_id = c.driver_id
      WHERE c.email ILIKE '%klassen%'
         OR d.first_name ILIKE '%klassen%'
         OR d.last_name ILIKE '%klassen%'
      ORDER BY re.created_at DESC
    `);

    if (result.rows.length === 0) {
      console.log('❌ No entries found for Klassen');
      return;
    }

    console.log(`\n✅ Found ${result.rows.length} entry/entries for Klassen:\n`);
    
    result.rows.forEach((entry, idx) => {
      console.log(`\n--- Entry ${idx + 1} ---`);
      console.log('Entry ID:', entry.entry_id);
      console.log('Driver:', entry.first_name, entry.last_name);
      console.log('Email:', entry.email);
      console.log('Race Class:', entry.race_class);
      console.log('Payment Status:', entry.payment_status);
      console.log('Entry Status:', entry.entry_status);
      console.log('\n🔧 Entry Items:', entry.entry_items);
      console.log('Engine Column:', entry.engine);
      console.log('\n🎫 Ticket References:');
      console.log('  Engine:', entry.ticket_engine_ref || '❌ MISSING');
      console.log('  Tyres:', entry.ticket_tyres_ref || '❌ MISSING');
      console.log('  Transponder:', entry.ticket_transponder_ref || '❌ MISSING');
      console.log('  Fuel:', entry.ticket_fuel_ref || '❌ MISSING');
      
      // Parse entry_items
      if (entry.entry_items) {
        try {
          const items = typeof entry.entry_items === 'string' 
            ? JSON.parse(entry.entry_items) 
            : entry.entry_items;
          console.log('\n📦 Parsed Entry Items:');
          items.forEach(item => console.log('  -', item));
        } catch (e) {
          console.log('❌ Could not parse entry_items');
        }
      }
    });

    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    await pool.end();
  }
}

checkKlassenEntry();
