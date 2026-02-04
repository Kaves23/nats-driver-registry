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

async function findBillau() {
  try {
    // Search drivers
    const driversResult = await pool.query(`
      SELECT driver_id, first_name, last_name, class 
      FROM drivers 
      WHERE LOWER(first_name) LIKE '%billau%' 
         OR LOWER(last_name) LIKE '%billau%'
      ORDER BY created_at DESC
    `);
    
    console.log('=== SEARCHING FOR BILLAU ===\n');
    
    if (driversResult.rows.length > 0) {
      console.log('✅ Found Billau in DRIVERS table:');
      driversResult.rows.forEach(d => {
        console.log(`   - ${d.first_name} ${d.last_name} (${d.class}) - ID: ${d.driver_id}`);
      });
      
      // Check race entries for this driver
      for (const driver of driversResult.rows) {
        const entriesResult = await pool.query(`
          SELECT * FROM race_entries 
          WHERE driver_id = $1 
          ORDER BY created_at DESC
        `, [driver.driver_id]);
        
        console.log(`\n   Race entries for ${driver.first_name} ${driver.last_name}:`);
        if (entriesResult.rows.length > 0) {
          entriesResult.rows.forEach(e => {
            console.log(`      - Entry ID: ${e.entry_id}`);
            console.log(`        Event: ${e.event_id}`);
            console.log(`        Status: ${e.entry_status}`);
            console.log(`        Payment Status: ${e.payment_status}`);
            console.log(`        Payment Ref: ${e.payment_reference || 'N/A'}`);
            console.log(`        Created: ${e.created_at}`);
          });
        } else {
          console.log('      No race entries found');
        }
      }
    } else {
      console.log('❌ No driver found with name "Billau"');
    }
    
    // Also check contacts table
    const contactsResult = await pool.query(`
      SELECT * FROM contacts 
      WHERE LOWER(full_name) LIKE '%billau%' 
         OR LOWER(email) LIKE '%billau%'
         OR LOWER(phone_mobile) LIKE '%billau%'
    `);
    
    if (contactsResult.rows.length > 0) {
      console.log('\n✅ Found Billau in CONTACTS table:');
      contactsResult.rows.forEach(c => {
        console.log(`   - ${c.full_name} - Email: ${c.email}`);
        console.log(`     Driver ID: ${c.driver_id}`);
      });
    }
    
    // Check payments table for any Billau references
    const paymentsResult = await pool.query(`
      SELECT * FROM payments 
      WHERE LOWER(name_first) LIKE '%billau%'
         OR LOWER(email_address) LIKE '%billau%'
         OR LOWER(item_name) LIKE '%billau%'
         OR LOWER(item_description) LIKE '%billau%'
    `);
    
    if (paymentsResult.rows.length > 0) {
      console.log('\n✅ Found Billau in PAYMENTS table:');
      paymentsResult.rows.forEach(p => {
        console.log(`   - Payment ID: ${p.payment_id}`);
        console.log(`     Name: ${p.name_first}`);
        console.log(`     Email: ${p.email_address}`);
        console.log(`     Amount: R${p.amount_gross}`);
        console.log(`     Status: ${p.payment_status}`);
        console.log(`     Item: ${p.item_name}`);
        console.log(`     Created: ${p.created_at}`);
        console.log(`     Custom Fields: ${p.custom_str1}, ${p.custom_str2}, ${p.custom_str3}`);
      });
    }
    
    // List ALL drivers to help identify the correct spelling
    console.log('\n\n=== ALL DRIVERS (for reference) ===');
    const allDrivers = await pool.query('SELECT first_name, last_name FROM drivers ORDER BY last_name, first_name');
    allDrivers.rows.forEach(d => {
      console.log(`   ${d.first_name} ${d.last_name}`);
    });
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

findBillau();
