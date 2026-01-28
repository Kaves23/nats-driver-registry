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

async function checkJohnPayments() {
  try {
    console.log('🔍 Checking all John Duvill payments...\n');
    
    // Find John's driver_id first
    const driver = await pool.query(`
      SELECT driver_id, first_name, last_name
      FROM drivers
      WHERE first_name ILIKE '%john%' AND last_name ILIKE '%duvill%'
    `);
    
    if (driver.rows.length === 0) {
      console.log('❌ John Duvill not found');
      await pool.end();
      return;
    }
    
    const driverId = driver.rows[0].driver_id;
    console.log(`✅ Found John Duvill: ${driverId}\n`);
    
    // Check race_entries
    console.log('📋 Race Entries:');
    const raceEntries = await pool.query(`
      SELECT 
        entry_id,
        payment_reference,
        payment_status,
        amount_paid,
        created_at,
        event_id
      FROM race_entries
      WHERE driver_id = $1
      ORDER BY created_at DESC
    `, [driverId]);
    
    raceEntries.rows.forEach(entry => {
      console.log(`   ${entry.payment_reference || 'NO REF'}`);
      console.log(`      Status: ${entry.payment_status}`);
      console.log(`      Amount: R${entry.amount_paid || 0}`);
      console.log(`      Event: ${entry.event_id || 'N/A'}`);
      console.log(`      Created: ${entry.created_at}`);
      console.log('');
    });
    
    // Check payments table
    console.log('💰 Direct Payments:');
    const payments = await pool.query(`
      SELECT 
        payment_id,
        merchant_payment_id,
        payment_status,
        amount_gross,
        item_name,
        created_at
      FROM payments
      WHERE driver_id = $1
      ORDER BY created_at DESC
    `, [driverId]);
    
    payments.rows.forEach(p => {
      console.log(`   ${p.payment_id}`);
      console.log(`      Merchant: ${p.merchant_payment_id || 'N/A'}`);
      console.log(`      Status: ${p.payment_status}`);
      console.log(`      Amount: R${p.amount_gross || 0}`);
      console.log(`      Item: ${p.item_name}`);
      console.log(`      Created: ${p.created_at}`);
      console.log('');
    });
    
    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

checkJohnPayments();
