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

async function checkTestPayment() {
  try {
    console.log('🔍 Searching for TEST-1769377745262 payment...\n');
    
    // Check race_entries
    const raceEntries = await pool.query(`
      SELECT 
        re.*,
        d.first_name,
        d.last_name,
        c.email
      FROM race_entries re
      LEFT JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN contacts c ON re.driver_id = c.driver_id
      WHERE re.payment_reference LIKE '%TEST-1769377745262%'
         OR re.payment_reference LIKE '%1769377745262%'
    `);
    
    if (raceEntries.rows.length > 0) {
      console.log('📋 Found in race_entries:');
      raceEntries.rows.forEach(entry => {
        console.log(`   Driver: ${entry.first_name} ${entry.last_name}`);
        console.log(`   Reference: ${entry.payment_reference}`);
        console.log(`   Status: ${entry.payment_status}`);
        console.log(`   Amount: R${entry.amount_paid || 0}`);
        console.log(`   Entry ID: ${entry.entry_id}`);
        console.log(`   Created: ${entry.created_at}`);
        console.log('');
      });
    }
    
    // Check payments table
    const payments = await pool.query(`
      SELECT 
        p.*,
        d.first_name,
        d.last_name
      FROM payments p
      LEFT JOIN drivers d ON p.driver_id = d.driver_id
      WHERE p.payment_id LIKE '%TEST%'
         OR p.merchant_payment_id LIKE '%TEST%'
         OR p.payment_id LIKE '%1769377745262%'
         OR p.merchant_payment_id LIKE '%1769377745262%'
    `);
    
    if (payments.rows.length > 0) {
      console.log('💰 Found in payments table:');
      payments.rows.forEach(p => {
        console.log(`   Driver: ${p.first_name} ${p.last_name}`);
        console.log(`   Payment ID: ${p.payment_id}`);
        console.log(`   Merchant ID: ${p.merchant_payment_id}`);
        console.log(`   Status: ${p.payment_status}`);
        console.log(`   Amount: R${p.amount_gross || 0}`);
        console.log(`   Created: ${p.created_at}`);
        console.log('');
      });
    }
    
    if (raceEntries.rows.length === 0 && payments.rows.length === 0) {
      console.log('❌ No payment found with that reference');
    }
    
    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

checkTestPayment();
