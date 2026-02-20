require('dotenv').config();
const { Pool } = require('pg');

// Production database configuration (using environment variables)
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

async function getFeb14Entries() {
  try {
    console.log('🏁 NORTHERN REGIONS CROWN - 14 FEBRUARY 2026');
    console.log('📍 Red Star Raceway, Mpumalanga\n');
    console.log('='.repeat(80));
    console.log('\n');
    
    // Get all race entries for Feb 14 event with driver details and emails
    const entries = await pool.query(
      `SELECT 
        re.entry_id,
        re.driver_id,
        d.first_name,
        d.last_name,
        c.email,
        re.race_class,
        d.class as driver_class,
        d.transponder_number,
        re.team_code,
        re.payment_status,
        re.entry_status,
        re.entry_items,
        re.amount_paid,
        re.payment_reference,
        re.created_at
       FROM race_entries re
       LEFT JOIN drivers d ON re.driver_id = d.driver_id
       LEFT JOIN contacts c ON d.driver_id = c.driver_id
       WHERE re.event_id = 'event_redstar_001'
       ORDER BY re.race_class, d.last_name, d.first_name`
    );
    
    if (entries.rows.length === 0) {
      console.log('❌ No entries found for this event yet.\n');
    } else {
      console.log(`✅ TOTAL ENTRIES: ${entries.rows.length}\n`);
      console.log('='.repeat(80));
      console.log('\n');
      
      // Group by class
      const byClass = {};
      entries.rows.forEach(entry => {
        const raceClass = entry.race_class || 'NOT SET';
        if (!byClass[raceClass]) {
          byClass[raceClass] = [];
        }
        byClass[raceClass].push(entry);
      });
      
      // Display by class
      Object.keys(byClass).sort().forEach((raceClass, index) => {
        const classEntries = byClass[raceClass];
        console.log(`\n📊 CLASS: ${raceClass} (${classEntries.length} ${classEntries.length === 1 ? 'entry' : 'entries'})`);
        console.log('-'.repeat(80));
        
        classEntries.forEach((entry, idx) => {
          console.log(`\n${idx + 1}. ${entry.first_name} ${entry.last_name}`);
          console.log(`   📧 Email: ${entry.email || 'NO EMAIL'}`);
          console.log(`   🏷️  Driver ID: ${entry.driver_id}`);
          console.log(`   🏁 Entry ID: ${entry.entry_id}`);
          console.log(`   🎯 Race Class: ${entry.race_class || 'NOT SET'}`);
          console.log(`   👤 Driver Class: ${entry.driver_class || 'NOT SET'}`);
          console.log(`   📡 Transponder: ${entry.transponder_number || 'NOT SET'}`);
          console.log(`   🏢 Team Code: ${entry.team_code || 'NOT SET'}`);
          console.log(`   💳 Payment Status: ${entry.payment_status}`);
          console.log(`   ✅ Entry Status: ${entry.entry_status}`);
          console.log(`   💰 Amount Paid: R${entry.amount_paid || 0}`);
          console.log(`   🔖 Payment Ref: ${entry.payment_reference || 'N/A'}`);
          
          // Parse entry items
          if (entry.entry_items) {
            try {
              const items = JSON.parse(entry.entry_items);
              console.log(`   📦 Items: ${items.map(i => i.name).join(', ')}`);
            } catch (e) {
              console.log(`   📦 Items: ${entry.entry_items}`);
            }
          }
          
          console.log(`   📅 Registered: ${new Date(entry.created_at).toLocaleString()}`);
        });
      });
      
      // Summary with email list
      console.log('\n\n' + '='.repeat(80));
      console.log('📧 EMAIL LIST FOR COMMUNICATIONS');
      console.log('='.repeat(80) + '\n');
      
      const emails = entries.rows
        .filter(e => e.email)
        .map(e => `${e.email} (${e.first_name} ${e.last_name})`)
        .sort();
      
      emails.forEach(email => console.log(email));
      
      console.log(`\n💡 Total: ${emails.length} drivers with email addresses`);
      
      // Email addresses only (comma-separated for easy copying)
      const emailAddressesOnly = entries.rows
        .filter(e => e.email)
        .map(e => e.email)
        .sort();
      
      console.log('\n\n' + '='.repeat(80));
      console.log('📋 COMMA-SEPARATED EMAIL LIST (for BCC)');
      console.log('='.repeat(80) + '\n');
      console.log(emailAddressesOnly.join(', '));
      
      // Drivers without emails
      const noEmail = entries.rows.filter(e => !e.email);
      if (noEmail.length > 0) {
        console.log('\n\n' + '='.repeat(80));
        console.log('⚠️  DRIVERS WITHOUT EMAIL ADDRESSES');
        console.log('='.repeat(80) + '\n');
        noEmail.forEach(e => {
          console.log(`${e.first_name} ${e.last_name} (Driver ID: ${e.driver_id})`);
        });
      }
      
      // Payment status summary
      console.log('\n\n' + '='.repeat(80));
      console.log('💳 PAYMENT STATUS SUMMARY');
      console.log('='.repeat(80) + '\n');
      
      const paymentSummary = {};
      entries.rows.forEach(e => {
        const status = e.payment_status || 'unknown';
        paymentSummary[status] = (paymentSummary[status] || 0) + 1;
      });
      
      Object.entries(paymentSummary).forEach(([status, count]) => {
        console.log(`${status.toUpperCase()}: ${count}`);
      });
      
      console.log('\n');
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err);
  } finally {
    await pool.end();
  }
}

getFeb14Entries();
