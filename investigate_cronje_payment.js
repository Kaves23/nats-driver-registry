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

async function investigateCronjePayment() {
  try {
    console.log('🔍 INVESTIGATING NOAH CRONJE PAYMENT (R23,200)\n');
    
    // Get the full payment record
    const payment = await pool.query(`
      SELECT *
      FROM payments
      WHERE payment_id = 'PAYFAST-CRONJE-21JAN2026'
    `);
    
    if (payment.rows.length === 0) {
      console.log('❌ Payment not found!');
      await pool.end();
      return;
    }
    
    const p = payment.rows[0];
    
    console.log('📋 FULL PAYMENT RECORD:');
    console.log('='.repeat(80));
    console.log(`Payment ID: ${p.payment_id}`);
    console.log(`Driver ID: ${p.driver_id}`);
    console.log(`Merchant Payment ID: ${p.merchant_payment_id || 'NULL'}`);
    console.log(`PayFast Payment ID: ${p.pf_payment_id || 'NULL'}`);
    console.log(`Item Name: ${p.item_name}`);
    console.log(`Item Description: ${p.item_description || 'NULL'}`);
    console.log(`Amount Gross: R${parseFloat(p.amount_gross || 0).toFixed(2)}`);
    console.log(`Amount Fee: R${parseFloat(p.amount_fee || 0).toFixed(2)}`);
    console.log(`Amount Net: R${parseFloat(p.amount_net || 0).toFixed(2)}`);
    console.log(`Payment Status: ${p.payment_status}`);
    console.log(`Payment Method: ${p.payment_method || 'NULL'}`);
    console.log(`Name First: ${p.name_first || 'NULL'}`);
    console.log(`Email Address: ${p.email_address || 'NULL'}`);
    console.log(`Created At: ${p.created_at}`);
    console.log(`Completed At: ${p.completed_at || 'NULL'}`);
    console.log(`ITN Received At: ${p.itn_received_at || 'NULL'}`);
    console.log(`Custom Str1: ${p.custom_str1 || 'NULL'}`);
    console.log(`Custom Str2: ${p.custom_str2 || 'NULL'}`);
    console.log(`Custom Str3: ${p.custom_str3 || 'NULL'}`);
    console.log(`\nRaw Response: ${p.raw_response || 'NULL'}`);
    console.log('='.repeat(80));
    
    // Check audit log for who created this
    console.log('\n📊 CHECKING AUDIT LOG:\n');
    const audit = await pool.query(`
      SELECT *
      FROM audit_log
      WHERE table_name = 'payments' 
        AND record_id = 'PAYFAST-CRONJE-21JAN2026'
      ORDER BY timestamp DESC
    `);
    
    if (audit.rows.length > 0) {
      console.log(`Found ${audit.rows.length} audit entries:`);
      audit.rows.forEach((a, i) => {
        console.log(`\n${i+1}. ${a.action} - ${a.timestamp}`);
        console.log(`   User: ${a.user_id || 'SYSTEM'}`);
        console.log(`   Changes: ${JSON.stringify(a.changes, null, 2)}`);
      });
    } else {
      console.log('⚠️ No audit log entries found for this payment!');
      console.log('This suggests the payment was inserted directly without triggering audit logs.');
    }
    
    // Check if this was from a PayFast webhook or manual insert
    console.log('\n\n🔎 ANALYSIS:');
    console.log('='.repeat(80));
    if (!p.pf_payment_id && !p.merchant_payment_id) {
      console.log('⚠️ WARNING: No PayFast payment ID or merchant ID present!');
      console.log('This payment was likely inserted MANUALLY, not from PayFast.');
    }
    if (!p.itn_received_at && !p.completed_at) {
      console.log('⚠️ WARNING: No ITN received timestamp or completion timestamp!');
      console.log('This payment was never confirmed by PayFast webhook.');
    }
    if (p.payment_status === 'COMPLETE' && !p.completed_at) {
      console.log('⚠️ WARNING: Status is COMPLETE but no completed_at timestamp!');
      console.log('This was manually marked as complete without actual payment confirmation.');
    }
    if (!p.raw_response) {
      console.log('⚠️ WARNING: No raw_response from PayFast!');
      console.log('This payment did not come through the PayFast integration.');
    }
    
    console.log('\n💡 CONCLUSION:');
    if (!p.pf_payment_id && !p.raw_response && !p.itn_received_at) {
      console.log('❌ This payment appears to be a MANUAL DATABASE INSERT.');
      console.log('   It was NOT processed through PayFast.');
      console.log('   No actual money was received for this payment.');
      console.log('   Created date: ' + p.created_at);
      console.log('   \n   RECOMMENDATION: DELETE this payment record or mark as "Test/Invalid"');
    }
    console.log('='.repeat(80));
    
    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

investigateCronjePayment();
