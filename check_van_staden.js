const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://natsdb_9im4_user:w6Expo5n5v7kh36alpXGetQL7reUqVHJ@dpg-cu6trldumphs73f4rb4g-a.oregon-postgres.render.com/natsdb_9im4',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function checkVanStaden() {
  try {
    console.log('🔍 Searching for van Staden entries...\n');
    
    // Search entries
    const entries = await pool.query(`
      SELECT re.entry_id, re.driver_id, re.event_id, re.payment_reference, 
             re.payment_status, re.entry_status, re.amount_paid, re.created_at,
             d.first_name, d.last_name, c.email,
             re.ticket_engine_ref, re.ticket_tyres_ref, re.ticket_transponder_ref, re.ticket_fuel_ref
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      WHERE LOWER(d.last_name) LIKE '%van staden%' 
         OR LOWER(d.last_name) LIKE '%vanstaden%'
      ORDER BY re.created_at DESC
      LIMIT 5
    `);
    
    if (entries.rows.length === 0) {
      console.log('❌ No entries found for van Staden');
      process.exit(0);
    }
    
    console.log(`✅ Found ${entries.rows.length} entries:\n`);
    
    entries.rows.forEach((entry, index) => {
      console.log(`📋 Entry ${index + 1}:`);
      console.log(`   Driver: ${entry.first_name} ${entry.last_name}`);
      console.log(`   Email: ${entry.email}`);
      console.log(`   Entry ID: ${entry.entry_id}`);
      console.log(`   Payment Reference: ${entry.payment_reference}`);
      console.log(`   Payment Status: ${entry.payment_status}`);
      console.log(`   Entry Status: ${entry.entry_status}`);
      console.log(`   Amount Paid: R${entry.amount_paid}`);
      console.log(`   Created: ${entry.created_at}`);
      console.log(`   Tickets Generated:`);
      console.log(`     - Engine: ${entry.ticket_engine_ref || 'None'}`);
      console.log(`     - Tyres: ${entry.ticket_tyres_ref || 'None'}`);
      console.log(`     - Transponder: ${entry.ticket_transponder_ref || 'None'}`);
      console.log(`     - Fuel: ${entry.ticket_fuel_ref || 'None'}`);
      console.log('');
    });
    
    // Check PayFast transactions for this driver
    console.log('\n🔍 Checking PayFast transactions...\n');
    
    const payments = await pool.query(`
      SELECT * FROM payfast_transactions
      WHERE name_last ILIKE '%van staden%'
         OR name_last ILIKE '%vanstaden%'
      ORDER BY created_at DESC
      LIMIT 5
    `);
    
    if (payments.rows.length > 0) {
      console.log(`✅ Found ${payments.rows.length} PayFast transactions:\n`);
      
      payments.rows.forEach((payment, index) => {
        console.log(`💳 Payment ${index + 1}:`);
        console.log(`   PayFast ID: ${payment.pf_payment_id}`);
        console.log(`   Payment Reference: ${payment.m_payment_id}`);
        console.log(`   Amount: R${payment.amount_gross}`);
        console.log(`   Status: ${payment.payment_status}`);
        console.log(`   Item Description: ${payment.item_description}`);
        console.log(`   Created: ${payment.created_at}`);
        console.log('');
      });
    } else {
      console.log('❌ No PayFast transactions found');
    }
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

checkVanStaden();
