require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: false
});

async function findPayments() {
  console.log('🔍 Searching for Moore and Van Der Molen payments...\n');
  
  try {
    // Search for Moore entries
    console.log('=' .repeat(80));
    console.log('SEARCHING FOR: MOORE');
    console.log('='.repeat(80));
    
    const mooreEntries = await pool.query(`
      SELECT re.*, 
             d.first_name, d.last_name, d.race_number,
             c.email, c.phone_mobile,
             e.event_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      LEFT JOIN events e ON re.event_id = e.event_id
      WHERE LOWER(d.last_name) LIKE '%moore%'
      ORDER BY re.created_at DESC
      LIMIT 5
    `);
    
    if (mooreEntries.rows.length > 0) {
      console.log(`\n✅ Found ${mooreEntries.rows.length} Moore entries:\n`);
      mooreEntries.rows.forEach((entry, i) => {
        console.log(`📋 Entry ${i + 1}:`);
        console.log(`   Driver: ${entry.first_name} ${entry.last_name} #${entry.race_number || '?'}`);
        console.log(`   Email: ${entry.email}`);
        console.log(`   Entry ID: ${entry.entry_id}`);
        console.log(`   Event: ${entry.event_name || entry.event_id}`);
        console.log(`   Payment Reference: ${entry.payment_reference}`);
        console.log(`   Payment Status: ${entry.payment_status}`);
        console.log(`   Entry Status: ${entry.entry_status}`);
        console.log(`   Amount Paid: R${entry.amount_paid}`);
        console.log(`   Race Class: ${entry.race_class}`);
        console.log(`   Created: ${entry.created_at}`);
        console.log(`   Tickets:`);
        console.log(`     - Engine: ${entry.ticket_engine_ref || 'None'}`);
        console.log(`     - Tyres: ${entry.ticket_tyres_ref || 'None'}`);
        console.log(`     - Transponder: ${entry.ticket_transponder_ref || 'None'}`);
        console.log(`     - Fuel: ${entry.ticket_fuel_ref || 'None'}`);
        console.log('');
      });
    } else {
      console.log('❌ No entries found for Moore\n');
    }
    
    // Search for Van Der Molen entries
    console.log('='.repeat(80));
    console.log('SEARCHING FOR: VAN DER MOLEN / VANDERMOLEN');
    console.log('='.repeat(80));
    
    const vanDerMolenEntries = await pool.query(`
      SELECT re.*, 
             d.first_name, d.last_name, d.race_number,
             c.email, c.phone_mobile,
             e.event_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      LEFT JOIN events e ON re.event_id = e.event_id
      WHERE LOWER(d.last_name) LIKE '%van%molen%'
         OR LOWER(d.last_name) LIKE '%vandermolen%'
         OR LOWER(d.last_name) LIKE '%vander%molen%'
      ORDER BY re.created_at DESC
      LIMIT 5
    `);
    
    if (vanDerMolenEntries.rows.length > 0) {
      console.log(`\n✅ Found ${vanDerMolenEntries.rows.length} Van Der Molen entries:\n`);
      vanDerMolenEntries.rows.forEach((entry, i) => {
        console.log(`📋 Entry ${i + 1}:`);
        console.log(`   Driver: ${entry.first_name} ${entry.last_name} #${entry.race_number || '?'}`);
        console.log(`   Email: ${entry.email}`);
        console.log(`   Entry ID: ${entry.entry_id}`);
        console.log(`   Event: ${entry.event_name || entry.event_id}`);
        console.log(`   Payment Reference: ${entry.payment_reference}`);
        console.log(`   Payment Status: ${entry.payment_status}`);
        console.log(`   Entry Status: ${entry.entry_status}`);
        console.log(`   Amount Paid: R${entry.amount_paid}`);
        console.log(`   Race Class: ${entry.race_class}`);
        console.log(`   Created: ${entry.created_at}`);
        console.log(`   Tickets:`);
        console.log(`     - Engine: ${entry.ticket_engine_ref || 'None'}`);
        console.log(`     - Tyres: ${entry.ticket_tyres_ref || 'None'}`);
        console.log(`     - Transponder: ${entry.ticket_transponder_ref || 'None'}`);
        console.log(`     - Fuel: ${entry.ticket_fuel_ref || 'None'}`);
        console.log('');
      });
    } else {
      console.log('❌ No entries found for Van Der Molen\n');
    }
    
    // Check for failed notification logs
    console.log('='.repeat(80));
    console.log('CHECKING FAILED NOTIFICATIONS LOG');
    console.log('='.repeat(80));
    
    const fs = require('fs');
    const path = require('path');
    const failedNotificationsFile = path.join(__dirname, 'logs', 'failed_notifications.json');
    
    if (fs.existsSync(failedNotificationsFile)) {
      const failedData = JSON.parse(fs.readFileSync(failedNotificationsFile, 'utf8'));
      console.log(`\n📋 Found ${failedData.length} failed notifications:\n`);
      
      failedData.slice(-10).forEach((fail, i) => {
        console.log(`Failed Notification ${i + 1}:`);
        console.log(`   Timestamp: ${fail.timestamp}`);
        console.log(`   Payment Reference: ${fail.data.reference || fail.data.m_payment_id}`);
        console.log(`   Error: ${fail.error}`);
        console.log('');
      });
    } else {
      console.log('\n❌ No failed notifications log file found\n');
    }
    
    // Check recent payments table entries
    console.log('='.repeat(80));
    console.log('CHECKING PAYMENTS TABLE (Last 20 entries)');
    console.log('='.repeat(80));
    
    try {
      const paymentsResult = await pool.query(`
        SELECT * FROM payments
        ORDER BY created_at DESC
        LIMIT 20
      `);
      
      if (paymentsResult.rows.length > 0) {
        console.log(`\n✅ Found ${paymentsResult.rows.length} recent payments:\n`);
        paymentsResult.rows.forEach((payment, i) => {
          console.log(`💳 Payment ${i + 1}:`);
          console.log(`   Reference: ${payment.reference}`);
          console.log(`   Driver ID: ${payment.driver_id}`);
          console.log(`   Amount: R${payment.amount}`);
          console.log(`   Status: ${payment.status}`);
          console.log(`   Created: ${payment.created_at || payment.payment_date}`);
          console.log('');
        });
      }
    } catch (err) {
      console.log('⚠️  Payments table might not exist or has different schema');
    }
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

findPayments();
