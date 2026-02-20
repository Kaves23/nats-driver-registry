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

async function getFeb14ActiveEntries() {
  try {
    console.log('\n🏁 NORTHERN REGIONS CROWN - 14 FEBRUARY 2026');
    console.log('📍 Red Star Raceway, Mpumalanga\n');
    console.log('='.repeat(100));
    console.log('ACTIVE ENTRIES ONLY (Excluding Test Accounts & Cancelled Entries)');
    console.log('='.repeat(100) + '\n');
    
    // Get all race entries for Feb 14 event with driver details and emails
    // Filter out test accounts and cancelled entries
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
         AND re.entry_status NOT IN ('cancelled')
         AND c.email NOT LIKE '%johnduvill%'
         AND c.email NOT LIKE '%test%'
         AND c.email != 'win@rokthenats.co.za'
         AND c.email != 'john@sectcapital.com'
       ORDER BY re.race_class, d.last_name, d.first_name`
    );
    
    if (entries.rows.length === 0) {
      console.log('❌ No active entries found for this event.\n');
    } else {
      console.log(`✅ TOTAL ACTIVE ENTRIES: ${entries.rows.length}\n`);
      console.log('='.repeat(100) + '\n');
      
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
      let entryCounter = 1;
      Object.keys(byClass).sort().forEach((raceClass) => {
        const classEntries = byClass[raceClass];
        console.log(`\n📊 CLASS: ${raceClass} (${classEntries.length} ${classEntries.length === 1 ? 'entry' : 'entries'})`);
        console.log('-'.repeat(100));
        
        classEntries.forEach((entry) => {
          console.log(`\n${entryCounter}. ${entry.first_name} ${entry.last_name}`);
          console.log(`   📧 Email: ${entry.email || 'NO EMAIL'}`);
          console.log(`   🎯 Race Class: ${entry.race_class || 'NOT SET'}`);
          console.log(`   📡 Transponder: ${entry.transponder_number || 'NOT SET'}`);
          console.log(`   🏢 Team Code: ${entry.team_code || 'NONE'}`);
          console.log(`   💳 Payment: ${entry.payment_status} | Entry: ${entry.entry_status}`);
          console.log(`   💰 Amount: R${entry.amount_paid || 0}`);
          
          // Parse entry items
          if (entry.entry_items) {
            try {
              const items = JSON.parse(entry.entry_items);
              const itemNames = items.map(i => i.name).join(', ');
              console.log(`   📦 Items: ${itemNames}`);
            } catch (e) {
              // Ignore parse errors
            }
          }
          
          entryCounter++;
        });
      });
      
      // Get unique drivers only (some may have multiple entries)
      const uniqueDrivers = new Map();
      entries.rows.forEach(e => {
        if (e.email && !uniqueDrivers.has(e.email)) {
          uniqueDrivers.set(e.email, {
            name: `${e.first_name} ${e.last_name}`,
            email: e.email,
            class: e.race_class
          });
        }
      });
      
      // Summary with unique email list
      console.log('\n\n' + '='.repeat(100));
      console.log('📧 UNIQUE DRIVER EMAIL LIST (One email per driver for communications)');
      console.log('='.repeat(100) + '\n');
      
      const sortedDrivers = Array.from(uniqueDrivers.values()).sort((a, b) => 
        a.name.localeCompare(b.name)
      );
      
      sortedDrivers.forEach(driver => {
        console.log(`${driver.email.padEnd(40)} - ${driver.name} (${driver.class})`);
      });
      
      console.log(`\n💡 Total: ${uniqueDrivers.size} unique drivers with email addresses`);
      
      // Email addresses only (comma-separated for easy copying)
      const emailAddressesOnly = sortedDrivers.map(d => d.email);
      
      console.log('\n\n' + '='.repeat(100));
      console.log('📋 COMMA-SEPARATED EMAIL LIST (for BCC)');
      console.log('='.repeat(100) + '\n');
      console.log(emailAddressesOnly.join(', '));
      
      // Class breakdown
      console.log('\n\n' + '='.repeat(100));
      console.log('📊 DRIVERS BY CLASS');
      console.log('='.repeat(100) + '\n');
      
      const driversByClass = {};
      sortedDrivers.forEach(d => {
        const cls = d.class || 'NOT SET';
        if (!driversByClass[cls]) driversByClass[cls] = [];
        driversByClass[cls].push(d);
      });
      
      Object.keys(driversByClass).sort().forEach(cls => {
        console.log(`\n${cls}: ${driversByClass[cls].length} drivers`);
        driversByClass[cls].forEach(d => {
          console.log(`  • ${d.name}`);
        });
      });
      
      // Payment status summary
      console.log('\n\n' + '='.repeat(100));
      console.log('💳 PAYMENT STATUS SUMMARY');
      console.log('='.repeat(100) + '\n');
      
      const paymentSummary = {};
      entries.rows.forEach(e => {
        const status = e.payment_status || 'unknown';
        paymentSummary[status] = (paymentSummary[status] || 0) + 1;
      });
      
      Object.entries(paymentSummary).sort().forEach(([status, count]) => {
        console.log(`${status.toUpperCase().padEnd(20)}: ${count}`);
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

getFeb14ActiveEntries();
