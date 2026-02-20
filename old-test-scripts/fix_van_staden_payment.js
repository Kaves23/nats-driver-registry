require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false  // Local database doesn't use SSL
});

async function fixVanStadenPayment() {
  const entryId = 'race_entry_1770216855999_nwn8vw';
  const paymentRef = 'RACE-event_redstar_001-11c7180c-db04-43b7-9c3e-d89a18367efe-1770216855999';
  
  console.log('🔧 Fixing van Staden payment status...\n');
  
  try {
    // Check current status
    const before = await pool.query(
      'SELECT entry_id, payment_status, entry_status, amount_paid, payment_reference FROM race_entries WHERE entry_id = $1',
      [entryId]
    );
    
    console.log('📋 BEFORE:');
    console.log('  Entry ID:', before.rows[0].entry_id);
    console.log('  Payment Status:', before.rows[0].payment_status);
    console.log('  Entry Status:', before.rows[0].entry_status);
    console.log('  Amount Paid:', before.rows[0].amount_paid);
    console.log('  Payment Reference:', before.rows[0].payment_reference);
    console.log('');
    
    // Update statuses
    const result = await pool.query(
      `UPDATE race_entries 
       SET payment_status = 'Completed',
           entry_status = 'confirmed',
           updated_at = NOW()
       WHERE entry_id = $1
       RETURNING *`,
      [entryId]
    );
    
    console.log('✅ AFTER:');
    console.log('  Entry ID:', result.rows[0].entry_id);
    console.log('  Payment Status:', result.rows[0].payment_status);
    console.log('  Entry Status:', result.rows[0].entry_status);
    console.log('  Amount Paid:', result.rows[0].amount_paid);
    console.log('  Payment Reference:', result.rows[0].payment_reference);
    console.log('');
    
    // Check if PayFast transaction exists
    const pfCheck = await pool.query(
      `SELECT * FROM payfast_transactions WHERE m_payment_id = $1`,
      [paymentRef]
    );
    
    if (pfCheck.rows.length > 0) {
      console.log('✅ PayFast transaction found:');
      console.log('  PF Payment ID:', pfCheck.rows[0].pf_payment_id);
      console.log('  Payment Status:', pfCheck.rows[0].payment_status);
      console.log('  Amount:', pfCheck.rows[0].amount_gross);
    } else {
      console.log('⚠️  No PayFast transaction record found');
      console.log('   This means the webhook never fired or failed');
    }
    
    console.log('\n🎉 Payment status fixed! Van Staden entry is now confirmed.');
    
  } catch (err) {
    console.error('❌ Error:', err);
  } finally {
    await pool.end();
  }
}

fixVanStadenPayment();
