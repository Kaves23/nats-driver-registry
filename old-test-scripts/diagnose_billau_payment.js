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

async function comprehensiveBillauDiagnostic() {
  try {
    const billauDriverId = '8cc0750c-c83f-4133-a682-77611e37813d';
    const billauEmail = 'jackybillau@gmail.com';
    
    console.log('='.repeat(80));
    console.log('🔍 COMPREHENSIVE BILLAU PAYMENT DIAGNOSTIC');
    console.log('='.repeat(80));
    console.log('');
    
    // 1. DRIVER INFO
    console.log('1️⃣ DRIVER INFORMATION:');
    console.log('-'.repeat(80));
    const driverInfo = await pool.query(`
      SELECT d.*, c.email, c.full_name, c.phone_mobile 
      FROM drivers d
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      WHERE d.driver_id = $1
    `, [billauDriverId]);
    
    if (driverInfo.rows.length > 0) {
      const driver = driverInfo.rows[0];
      console.log(`✅ Driver Found: ${driver.first_name} ${driver.last_name}`);
      console.log(`   Class: ${driver.class}`);
      console.log(`   Driver ID: ${driver.driver_id}`);
      console.log(`   Contact Email: ${driver.email}`);
      console.log(`   Created: ${driver.created_at}`);
    }
    console.log('');
    
    // 2. RACE ENTRIES (ALL STATUSES)
    console.log('2️⃣ RACE ENTRIES:');
    console.log('-'.repeat(80));
    const entries = await pool.query(`
      SELECT * FROM race_entries 
      WHERE driver_id = $1 
      ORDER BY created_at DESC
    `, [billauDriverId]);
    
    if (entries.rows.length > 0) {
      console.log(`✅ Found ${entries.rows.length} race entry/entries:`);
      entries.rows.forEach(e => {
        console.log(`   Entry: ${e.race_entry_id}`);
        console.log(`     Event: ${e.event_id}`);
        console.log(`     Class: ${e.race_class}`);
        console.log(`     Status: ${e.entry_status}`);
        console.log(`     Payment Status: ${e.payment_status}`);
        console.log(`     Payment Ref: ${e.payment_reference}`);
        console.log(`     Amount: R${e.amount_paid}`);
        console.log(`     Created: ${e.created_at}`);
        console.log('');
      });
    } else {
      console.log(`❌ NO RACE ENTRIES FOUND for driver ${billauDriverId}`);
    }
    console.log('');
    
    // 3. PAYMENTS
    console.log('3️⃣ PAYMENTS:');
    console.log('-'.repeat(80));
    const payments = await pool.query(`
      SELECT * FROM payments 
      WHERE driver_id = $1 
         OR LOWER(email_address) LIKE '%billau%'
         OR LOWER(name_first) LIKE '%billau%'
      ORDER BY created_at DESC
    `, [billauDriverId]);
    
    if (payments.rows.length > 0) {
      console.log(`✅ Found ${payments.rows.length} payment(s):`);
      payments.rows.forEach(p => {
        console.log(`   Payment: ${p.payment_id}`);
        console.log(`     Name: ${p.name_first}`);
        console.log(`     Email: ${p.email_address}`);
        console.log(`     Amount: R${p.amount_gross}`);
        console.log(`     Status: ${p.payment_status}`);
        console.log(`     Item: ${p.item_name}`);
        console.log(`     Custom Fields: ${p.custom_str1}, ${p.custom_str2}, ${p.custom_str3}`);
        console.log(`     Created: ${p.created_at}`);
        console.log('');
      });
    } else {
      console.log(`❌ NO PAYMENTS FOUND in payments table`);
    }
    console.log('');
    
    // 4. CHECK FOR ORPHANED PENDING ENTRIES (entries with no payment notification)
    console.log('4️⃣ ORPHANED PENDING ENTRIES (All Drivers):');
    console.log('-'.repeat(80));
    const orphanedEntries = await pool.query(`
      SELECT re.*, d.first_name, d.last_name, d.class 
      FROM race_entries re
      LEFT JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.payment_status = 'Pending'
        AND re.created_at < NOW() - INTERVAL '1 hour'
      ORDER BY re.created_at DESC
      LIMIT 20
    `);
    
    if (orphanedEntries.rows.length > 0) {
      console.log(`⚠️ Found ${orphanedEntries.rows.length} pending entries older than 1 hour:`);
      orphanedEntries.rows.forEach(e => {
        console.log(`   Driver: ${e.first_name} ${e.last_name} (${e.class})`);
        console.log(`     Entry ID: ${e.race_entry_id}`);
        console.log(`     Event: ${e.event_id}`);
        console.log(`     Payment Ref: ${e.payment_reference}`);
        console.log(`     Amount: R${e.amount_paid}`);
        console.log(`     Created: ${e.created_at}`);
        console.log(`     Age: ${Math.round((Date.now() - new Date(e.created_at).getTime()) / (1000 * 60 * 60))} hours`);
        console.log('');
      });
    } else {
      console.log(`✅ No orphaned pending entries found`);
    }
    console.log('');
    
    // 5. RECOMMENDATIONS
    console.log('='.repeat(80));
    console.log('📋 DIAGNOSTIC SUMMARY:');
    console.log('='.repeat(80));
    console.log('');
    
    const hasEntries = entries.rows.length > 0;
    const hasPayments = payments.rows.length > 0;
    const hasPendingEntries = entries.rows.some(e => e.payment_status === 'Pending');
    const hasCompletedEntries = entries.rows.some(e => e.payment_status === 'Completed');
    
    if (!hasEntries && !hasPayments) {
      console.log('❌ ISSUE: Billau has NO entries and NO payments in system');
      console.log('');
      console.log('🔍 POSSIBLE CAUSES:');
      console.log('   1. Payment was made externally (bank transfer/EFT) - not through PayFast');
      console.log('   2. Payment was made but PayFast notification (ITN) never arrived');
      console.log('   3. Payment initiation failed before reaching PayFast');
      console.log('   4. Wrong email used during payment process');
      console.log('   5. Manual registration was expected but not completed');
      console.log('');
      console.log('✅ RECOMMENDED ACTIONS:');
      console.log('   1. Check PayFast merchant dashboard for transactions from jackybillau@gmail.com');
      console.log('   2. Check bank statements for direct payments');
      console.log('   3. Contact Jacky Billau (jackybillau@gmail.com) to confirm:');
      console.log('      - Which payment method was used');
      console.log('      - Payment reference/transaction ID');
      console.log('      - Amount paid');
      console.log('      - Date of payment');
      console.log('   4. If payment confirmed externally, manually create entry using:');
      console.log('      /api/registerFreeRaceEntry endpoint');
    } else if (hasPendingEntries && !hasPayments) {
      console.log('⚠️ ISSUE: Billau has PENDING entries but NO payments recorded');
      console.log('');
      console.log('🔍 POSSIBLE CAUSES:');
      console.log('   1. Payment initiation started but never completed at PayFast');
      console.log('   2. PayFast ITN (notification) failed to arrive');
      console.log('   3. Payment abandoned at PayFast payment page');
      console.log('');
      console.log('✅ RECOMMENDED ACTIONS:');
      console.log('   1. Check PayFast transaction history');
      console.log('   2. Contact driver to confirm if payment was made');
      console.log('   3. If payment confirmed, manually process using payment reference');
    } else if (hasPayments && !hasCompletedEntries) {
      console.log('⚠️ ISSUE: Billau has PAYMENTS but NO completed entries');
      console.log('');
      console.log('🔍 POSSIBLE CAUSE:');
      console.log('   1. Payment notification processing failed');
      console.log('   2. Database error during entry creation');
      console.log('');
      console.log('✅ RECOMMENDED ACTIONS:');
      console.log('   1. Manually reconcile payment with entry');
      console.log('   2. Update entry status to "Completed"');
    }
    
    console.log('');
    console.log('='.repeat(80));
    console.log('💡 GENERAL SYSTEM RECOMMENDATIONS:');
    console.log('='.repeat(80));
    console.log('   • Enable PayFast ITN logging to file for audit trail');
    console.log('   • Create admin dashboard to view orphaned pending entries');
    console.log('   • Implement automated reconciliation with PayFast API');
    console.log('   • Add manual payment verification endpoint');
    console.log('   • Send alerts for entries pending >24 hours');
    console.log('');
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await pool.end();
  }
}

comprehensiveBillauDiagnostic();
