/**
 * Check entry statuses to see why some entries might be excluded
 */

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

async function checkEntryStatus() {
  try {
    console.log('🔍 Checking entry statuses for next event...\n');
    
    // Get next event
    const eventResult = await pool.query(
      `SELECT event_id, event_name, event_date 
       FROM events 
       WHERE event_date >= CURRENT_DATE
       ORDER BY event_date ASC
       LIMIT 1`
    );

    if (eventResult.rows.length === 0) {
      console.log('❌ No upcoming races found');
      return;
    }

    const event = eventResult.rows[0];
    console.log(`Event: ${event.event_name} (${event.event_id})\n`);

    // Get ALL entries for this event (no status filter)
    const allEntriesResult = await pool.query(`
      SELECT 
        re.entry_id,
        re.entry_status,
        re.payment_status,
        d.first_name,
        d.last_name,
        d.transponder_number,
        re.race_class
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.event_id = $1
      ORDER BY re.entry_status, d.last_name, d.first_name
    `, [event.event_id]);

    console.log(`📊 Total entries in database: ${allEntriesResult.rows.length}\n`);

    // Group by status
    const byStatus = {};
    allEntriesResult.rows.forEach(entry => {
      const status = entry.entry_status || 'null';
      if (!byStatus[status]) byStatus[status] = [];
      byStatus[status].push(entry);
    });

    console.log('Entry Status Breakdown:');
    console.log('━'.repeat(80));
    for (const [status, entries] of Object.entries(byStatus)) {
      console.log(`\n${status.toUpperCase()} (${entries.length} entries):`);
      entries.forEach(e => {
        const transponder = e.transponder_number || '⚠️ MISSING';
        console.log(`  - ${e.first_name} ${e.last_name} (${e.race_class || 'no class'}) - TX: ${transponder} - Payment: ${e.payment_status || 'none'}`);
      });
    }

    console.log('\n━'.repeat(80));
    console.log(`\nCurrent Query Filter: entry_status IN ('confirmed', 'pending')`);
    const currentFilter = allEntriesResult.rows.filter(e => 
      ['confirmed', 'pending'].includes(e.entry_status)
    );
    console.log(`This returns: ${currentFilter.length} entries`);
    
    console.log(`\n⚠️  Missing ${allEntriesResult.rows.length - currentFilter.length} entries due to status filter!`);
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

checkEntryStatus();
