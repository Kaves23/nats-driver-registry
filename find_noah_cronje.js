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

async function findNoahCronje() {
  try {
    console.log('🔍 Searching for Noah Cronje...\n');
    
    const result = await pool.query(`
      SELECT driver_id, first_name, last_name 
      FROM drivers 
      WHERE last_name ILIKE '%cronje%' OR first_name ILIKE '%noah%'
    `);
    
    console.log(`Found ${result.rows.length} drivers:`);
    result.rows.forEach(d => {
      console.log(`  - ${d.first_name} ${d.last_name} (${d.driver_id})`);
    });
    
    // Check payments for each
    for (const driver of result.rows) {
      console.log(`\n📊 Payments for ${driver.first_name} ${driver.last_name}:`);
      
      const payments = await pool.query(`
        SELECT payment_id, amount_gross, payment_status, item_name, created_at
        FROM payments
        WHERE driver_id = $1
        ORDER BY created_at DESC
      `, [driver.driver_id]);
      
      if (payments.rows.length === 0) {
        console.log('   ❌ NO PAYMENTS FOUND');
      } else {
        console.log(`   ✅ ${payments.rows.length} payments:`);
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
          console.log(`      - ${e.race_class}: ${e.entry_status} (Payment: ${e.payment_status}, R${e.amount_paid})`);
        });
      }
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await pool.end();
  }
}

findNoahCronje();
