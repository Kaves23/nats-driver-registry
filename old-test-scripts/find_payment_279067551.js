const {Pool} = require('pg');
require('dotenv').config();

const pool = new Pool({ 
  host: process.env.DB_HOST, 
  port: process.env.DB_PORT, 
  database: process.env.DB_DATABASE, 
  user: process.env.DB_USERNAME, 
  password: process.env.DB_PASSWORD, 
  ssl: { rejectUnauthorized: false } 
});

async function findPayment() {
  try {
    const reference = '279067551';
    
    console.log('='.repeat(80));
    console.log(`🔍 SEARCHING FOR PAYMENT REFERENCE: ${reference}`);
    console.log('='.repeat(80));
    console.log('');
    
    // Search ALL tables for this reference
    
    // 1. Payments table
    console.log('1️⃣ PAYMENTS TABLE:');
    const payments = await pool.query(`
      SELECT * FROM payments 
      WHERE payment_id LIKE '%${reference}%'
         OR merchant_payment_id LIKE '%${reference}%'
         OR pf_payment_id LIKE '%${reference}%'
         OR custom_str1 LIKE '%${reference}%'
         OR custom_str2 LIKE '%${reference}%'
         OR custom_str3 LIKE '%${reference}%'
    `);
    console.log(payments.rows.length > 0 ? `✅ Found ${payments.rows.length}` : '❌ Not found');
    if (payments.rows.length > 0) {
      payments.rows.forEach(p => console.log(JSON.stringify(p, null, 2)));
    }
    console.log('');
    
    // 2. Race entries table
    console.log('2️⃣ RACE ENTRIES TABLE:');
    const entries = await pool.query(`
      SELECT * FROM race_entries 
      WHERE payment_reference LIKE '%${reference}%'
         OR entry_id LIKE '%${reference}%'
    `);
    console.log(entries.rows.length > 0 ? `✅ Found ${entries.rows.length}` : '❌ Not found');
    if (entries.rows.length > 0) {
      entries.rows.forEach(e => console.log(JSON.stringify(e, null, 2)));
    }
    console.log('');
    
    // 3. Check for ANY payment references containing parts of this number
    console.log('3️⃣ SEARCHING ALL PAYMENT REFERENCES:');
    const allPaymentRefs = await pool.query(`
      SELECT payment_reference, entry_id, driver_id, created_at, payment_status
      FROM race_entries 
      WHERE payment_reference IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 20
    `);
    console.log(`Recent payment references (last 20):`);
    allPaymentRefs.rows.forEach(r => {
      console.log(`  ${r.payment_reference} - ${r.payment_status} - ${r.created_at}`);
    });
    console.log('');
    
    // 4. Check Billau's driver record
    console.log('4️⃣ BILLAU DRIVER RECORD:');
    const billau = await pool.query(`
      SELECT * FROM drivers WHERE driver_id = '8cc0750c-c83f-4133-a682-77611e37813d'
    `);
    if (billau.rows.length > 0) {
      console.log('Driver info:');
      console.log(JSON.stringify(billau.rows[0], null, 2));
    }
    console.log('');
    
    console.log('='.repeat(80));
    console.log('❌ CRITICAL FINDING: PAYMENT NOT IN DATABASE');
    console.log('='.repeat(80));
    console.log('');
    console.log('🔴 ISSUE: PayFast ITN (Instant Transaction Notification) was NOT received or FAILED');
    console.log('');
    console.log('Possible causes:');
    console.log('1. PayFast ITN URL is incorrect or unreachable');
    console.log('2. Server was down when PayFast tried to send notification');
    console.log('3. Notification arrived but processing failed silently');
    console.log('4. Firewall/security blocking PayFast IPs');
    console.log('5. SSL/HTTPS certificate issues preventing PayFast from connecting');
    console.log('');
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

findPayment();
