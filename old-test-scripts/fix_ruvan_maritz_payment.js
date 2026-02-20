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

async function fixRuvanPayment() {
  try {
    console.log('🔧 Fixing Ruvan Maritz payment amounts...\n');
    
    // Find entries with R10.17 (the bugged amount)
    const result = await pool.query(`
      SELECT 
        re.entry_id,
        re.amount_paid,
        re.payment_reference,
        re.race_class,
        d.first_name,
        d.last_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE d.last_name ILIKE '%Maritz%'
        AND re.amount_paid > 10
        AND re.amount_paid < 11
      ORDER BY re.created_at DESC
    `);
    
    if (result.rows.length === 0) {
      console.log('✅ No bugged entries found! (Already fixed or no entries)');
      process.exit(0);
    }
    
    console.log(`⚠️  Found ${result.rows.length} bugged entries:\n`);
    
    for (const entry of result.rows) {
      console.log(`Entry: ${entry.entry_id}`);
      console.log(`  Name: ${entry.first_name} ${entry.last_name}`);
      console.log(`  Current Amount: R${entry.amount_paid}`);
      console.log(`  Class: ${entry.race_class}`);
      console.log(`  Reference: ${entry.payment_reference}`);
      
      // Correct amount should be R10,170.00 (Red Star National entry fee)
      const correctAmount = 10170.00;
      
      console.log(`  ✅ Correcting to: R${correctAmount.toFixed(2)}\n`);
      
      await pool.query(
        'UPDATE race_entries SET amount_paid = $1 WHERE entry_id = $2',
        [correctAmount, entry.entry_id]
      );
    }
    
    console.log('✅ All Ruvan Maritz entries have been corrected!');
    console.log(`\n💡 Important: The PayFast payment was only R10.17, so you may need to:`);
    console.log(`   1. Contact Ruvan to request the remaining R${(10170.00 - 10.17).toFixed(2)}`);
    console.log(`   2. Or manually mark the entry as paid if you want to waive the difference`);
    console.log(`   3. Or cancel this entry and ask Ruvan to re-submit with correct amount\n`);
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

fixRuvanPayment();
