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

async function checkDriverPayments() {
  try {
    console.log('🔍 Checking Crinje and Van Staden...\n');
    
    // Find Van Staden (we found one)
    const vanStaden = await pool.query(`
      SELECT driver_id, first_name, last_name 
      FROM drivers 
      WHERE last_name ILIKE '%van staden%' OR last_name ILIKE '%vanstaden%'
    `);
    
    console.log('Van Staden drivers:', vanStaden.rows.length);
    vanStaden.rows.forEach(d => console.log(`  - ${d.first_name} ${d.last_name} (${d.driver_id})`));
    
    // Find Crinje
    const crinje = await pool.query(`
      SELECT driver_id, first_name, last_name 
      FROM drivers 
      WHERE last_name ILIKE '%crinje%'
    `);
    
    console.log('\nCrinje drivers:', crinje.rows.length);
    crinje.rows.forEach(d => console.log(`  - ${d.first_name} ${d.last_name} (${d.driver_id})`));
    
    const allDrivers = [...vanStaden.rows, ...crinje.rows];
    
    for (const driver of allDrivers) {
      console.log(`\n\n📊 ${driver.first_name} ${driver.last_name}:`);
      console.log(`   Driver ID: ${driver.driver_id}`);
      
      // Check payments
      const payments = await pool.query(`
        SELECT payment_id, amount_gross, payment_status, item_name, created_at
        FROM payments
        WHERE driver_id = $1
        ORDER BY created_at DESC
      `, [driver.driver_id]);
      
      if (payments.rows.length === 0) {
        console.log('   ❌ NO PAYMENTS FOUND');
      } else {
        console.log(`   ✅ ${payments.rows.length} payments found:`);
        payments.rows.forEach(p => {
          console.log(`      - ${p.item_name}: R${p.amount_gross} (${p.payment_status})`);
        });
      }
      
      // Check race entries
      const entries = await pool.query(`
        SELECT entry_id, event_id, race_class, payment_status, amount_paid, entry_status
        FROM race_entries
        WHERE driver_id = $1
      `, [driver.driver_id]);
      
      if (entries.rows.length > 0) {
        console.log(`   🏁 ${entries.rows.length} race entries:`);
        entries.rows.forEach(e => {
          console.log(`      - ${e.race_class}: ${e.entry_status} (Payment: ${e.payment_status}, Amount: R${e.amount_paid})`);
        });
      }
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err);
  } finally {
    await pool.end();
  }
}

checkDriverPayments();
