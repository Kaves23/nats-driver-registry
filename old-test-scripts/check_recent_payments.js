const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkRecentPayments() {
  try {
    console.log('🔍 Searching for Moore and Van Der Molen payments...\n');
    
    // Search race_entries for Moore
    console.log('--- RACE ENTRIES for "Moore" ---');
    const mooreEntries = await pool.query(
      `SELECT entry_id, driver_id, payment_reference, payment_status, entry_status, 
              amount_paid, race_class, created_at
       FROM race_entries 
       WHERE driver_id IN (
         SELECT driver_id FROM drivers WHERE LOWER(last_name) LIKE '%moore%'
       )
       ORDER BY created_at DESC
       LIMIT 10`
    );
    console.log(`Found ${mooreEntries.rows.length} entries`);
    mooreEntries.rows.forEach(entry => {
      console.log(`  Entry ID: ${entry.entry_id}`);
      console.log(`  Driver ID: ${entry.driver_id}`);
      console.log(`  Reference: ${entry.payment_reference}`);
      console.log(`  Payment Status: ${entry.payment_status}`);
      console.log(`  Entry Status: ${entry.entry_status}`);
      console.log(`  Amount: R${entry.amount_paid}`);
      console.log(`  Class: ${entry.race_class}`);
      console.log(`  Created: ${entry.created_at}`);
      console.log('  ---');
    });
    
    // Search race_entries for Van Der Molen
    console.log('\n--- RACE ENTRIES for "Van Der Molen" ---');
    const vandermolenEntries = await pool.query(
      `SELECT entry_id, driver_id, payment_reference, payment_status, entry_status, 
              amount_paid, race_class, created_at
       FROM race_entries 
       WHERE driver_id IN (
         SELECT driver_id FROM drivers WHERE LOWER(last_name) LIKE '%molen%' OR LOWER(last_name) LIKE '%van%der%'
       )
       ORDER BY created_at DESC
       LIMIT 10`
    );
    console.log(`Found ${vandermolenEntries.rows.length} entries`);
    vandermolenEntries.rows.forEach(entry => {
      console.log(`  Entry ID: ${entry.entry_id}`);
      console.log(`  Driver ID: ${entry.driver_id}`);
      console.log(`  Reference: ${entry.payment_reference}`);
      console.log(`  Payment Status: ${entry.payment_status}`);
      console.log(`  Entry Status: ${entry.entry_status}`);
      console.log(`  Amount: R${entry.amount_paid}`);
      console.log(`  Class: ${entry.race_class}`);
      console.log(`  Created: ${entry.created_at}`);
      console.log('  ---');
    });
    
    // Search all pending entries
    console.log('\n--- ALL PENDING ENTRIES (Recent 20) ---');
    const pendingEntries = await pool.query(
      `SELECT entry_id, driver_id, payment_reference, payment_status, entry_status, 
              amount_paid, race_class, created_at
       FROM race_entries 
       WHERE payment_status = 'Pending' OR entry_status = 'pending_payment'
       ORDER BY created_at DESC
       LIMIT 20`
    );
    console.log(`Found ${pendingEntries.rows.length} pending entries`);
    pendingEntries.rows.forEach(entry => {
      console.log(`  Entry ID: ${entry.entry_id}`);
      console.log(`  Reference: ${entry.payment_reference}`);
      console.log(`  Payment Status: ${entry.payment_status}`);
      console.log(`  Entry Status: ${entry.entry_status}`);
      console.log(`  Amount: R${entry.amount_paid}`);
      console.log(`  Created: ${entry.created_at}`);
      console.log('  ---');
    });
    
    // Search payments table
    console.log('\n--- PAYMENTS TABLE (Recent 20) ---');
    const payments = await pool.query(
      `SELECT payment_id, m_payment_id, pf_payment_id, payment_status, item_name, 
              amount_gross, name_first, name_last, email_address, created_at
       FROM payments 
       ORDER BY created_at DESC
       LIMIT 20`
    );
    console.log(`Found ${payments.rows.length} payments`);
    payments.rows.forEach(payment => {
      console.log(`  Payment ID: ${payment.payment_id}`);
      console.log(`  PayFast ID: ${payment.pf_payment_id}`);
      console.log(`  Status: ${payment.payment_status}`);
      console.log(`  Item: ${payment.item_name}`);
      console.log(`  Amount: R${payment.amount_gross}`);
      console.log(`  Name: ${payment.name_first} ${payment.name_last}`);
      console.log(`  Email: ${payment.email_address}`);
      console.log(`  Created: ${payment.created_at}`);
      console.log('  ---');
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await pool.end();
  }
}

checkRecentPayments();
