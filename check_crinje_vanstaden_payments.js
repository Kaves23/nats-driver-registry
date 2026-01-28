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

async function checkPayments() {
  try {
    console.log('🔍 Checking Crinje and Van Staden payments...\n');
    
    // Find these drivers
    const drivers = await pool.query(`
      SELECT driver_id, first_name, last_name 
      FROM drivers 
      WHERE last_name ILIKE '%Crinje%' OR last_name ILIKE '%Van Staden%' OR last_name ILIKE '%vanstaden%'
    `);
    
    console.log(`Found ${drivers.rows.length} drivers:`);
    drivers.rows.forEach(d => {
      console.log(`  - ${d.first_name} ${d.last_name} (${d.driver_id})`);
    });
    console.log('');
    
    // Check their payments
    for (const driver of drivers.rows) {
      console.log(`\n📊 Payments for ${driver.first_name} ${driver.last_name}:`);
      
      const payments = await pool.query(`
        SELECT payment_id, payment_reference, amount_paid, payment_status, created_at, payment_type
        FROM payments 
        WHERE driver_id = $1
        ORDER BY created_at DESC
      `, [driver.driver_id]);
      
      if (payments.rows.length === 0) {
        console.log('  ❌ NO PAYMENTS FOUND');
      } else {
        payments.rows.forEach(p => {
          console.log(`  - Ref: ${p.payment_reference}`);
          console.log(`    Amount: R${p.amount_paid}`);
          console.log(`    Status: ${p.payment_status}`);
          console.log(`    Type: ${p.payment_type || 'N/A'}`);
          console.log(`    Date: ${p.created_at}`);
          console.log('');
        });
      }
      
      // Check pool engine rentals
      const rentals = await pool.query(`
        SELECT rental_id, payment_reference, payment_status, championship_class, rental_type, created_at
        FROM pool_engine_rentals 
        WHERE driver_id = $1
        ORDER BY created_at DESC
      `, [driver.driver_id]);
      
      if (rentals.rows.length > 0) {
        console.log(`  🏎️ Pool Engine Rentals:`);
        rentals.rows.forEach(r => {
          console.log(`    - Ref: ${r.payment_reference}`);
          console.log(`      Status: ${r.payment_status}`);
          console.log(`      Class: ${r.championship_class}`);
          console.log(`      Type: ${r.rental_type}`);
          console.log('');
        });
      }
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await pool.end();
  }
}

checkPayments();
