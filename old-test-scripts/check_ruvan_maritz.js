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

async function checkRuvan() {
  try {
    // Find Ruvan Maritz
    const result = await pool.query(`
      SELECT 
        re.entry_id,
        re.amount_paid,
        re.payment_status,
        re.entry_status,
        re.payment_reference,
        re.created_at,
        d.first_name,
        d.last_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE d.last_name ILIKE '%Maritz%'
      ORDER BY re.created_at DESC
      LIMIT 10
    `);
    
    console.log('🔍 Found', result.rows.length, 'entries for Maritz:\n');
    
    result.rows.forEach((entry, i) => {
      console.log(`Entry ${i+1}:`);
      console.log(`  Name: ${entry.first_name} ${entry.last_name}`);
      console.log(`  Amount Paid: R${entry.amount_paid}`);
      console.log(`  Payment Status: ${entry.payment_status}`);
      console.log(`  Entry Status: ${entry.entry_status}`);
      console.log(`  Reference: ${entry.payment_reference}`);
      console.log(`  Created: ${entry.created_at}`);
      console.log('');
    });
    
    // Check for the R10.17 amount
    const buggedEntry = result.rows.find(r => parseFloat(r.amount_paid) > 10 && parseFloat(r.amount_paid) < 11);
    if (buggedEntry) {
      console.log('⚠️  FOUND THE BUG!');
      console.log(`   Entry ${buggedEntry.entry_id} has amount: R${buggedEntry.amount_paid}`);
      console.log(`   This should probably be R10170.00 (or R10,170.00)`);
      console.log(`   Payment reference: ${buggedEntry.payment_reference}`);
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

checkRuvan();
