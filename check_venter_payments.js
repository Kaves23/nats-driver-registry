const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function checkVenterPayments() {
  try {
    console.log('=== SEARCHING FOR VENTER ENTRIES ===\n');
    
    // Check race entries
    const entriesResult = await pool.query(`
      SELECT 
        r.*,
        d.first_name,
        d.last_name,
        c.email
      FROM race_entries r
      LEFT JOIN drivers d ON r.driver_id = d.driver_id
      LEFT JOIN contacts c ON r.driver_id = c.driver_id
      WHERE d.last_name ILIKE '%venter%' OR c.email ILIKE '%venter%'
      ORDER BY r.created_at DESC
    `);
    
    console.log(`Found ${entriesResult.rows.length} race entries for Venter\n`);
    
    entriesResult.rows.forEach(row => {
      console.log('---');
      console.log('Entry ID:', row.race_entry_id || row.entry_id);
      console.log('Driver:', row.first_name, row.last_name);
      console.log('Email:', row.email);
      console.log('Event ID:', row.event_id);
      console.log('Payment Ref:', row.payment_reference);
      console.log('Payment Status:', row.payment_status);
      console.log('Entry Status:', row.entry_status);
      console.log('Amount:', row.amount_paid);
      console.log('Created:', row.created_at);
      console.log('');
    });
    
    // Check drivers table
    console.log('\n=== CHECKING DRIVERS TABLE ===\n');
    const driversResult = await pool.query(`
      SELECT d.*, c.email
      FROM drivers d
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      WHERE d.last_name ILIKE '%venter%' OR c.email ILIKE '%venter%'
    `);
    
    console.log(`Found ${driversResult.rows.length} drivers with surname Venter\n`);
    driversResult.rows.forEach(row => {
      console.log('Driver ID:', row.driver_id);
      console.log('Name:', row.first_name, row.last_name);
      console.log('Email:', row.email);
      console.log('Class:', row.class);
      console.log('Status:', row.status);
      console.log('');
    });
    
    // Check for recent payment references with "venter" in description or recent entries
    console.log('\n=== CHECKING ALL RECENT RACE ENTRIES (Last 24 hours) ===\n');
    const recentResult = await pool.query(`
      SELECT 
        r.*,
        d.first_name,
        d.last_name,
        c.email
      FROM race_entries r
      LEFT JOIN drivers d ON r.driver_id = d.driver_id
      LEFT JOIN contacts c ON r.driver_id = c.driver_id
      WHERE r.created_at > NOW() - INTERVAL '24 hours'
      ORDER BY r.created_at DESC
    `);
    
    console.log(`Found ${recentResult.rows.length} entries in last 24 hours\n`);
    recentResult.rows.forEach(row => {
      console.log('---');
      console.log('Time:', row.created_at);
      console.log('Driver:', row.first_name, row.last_name, '(' + row.email + ')');
      console.log('Payment Ref:', row.payment_reference);
      console.log('Payment Status:', row.payment_status);
      console.log('Entry Status:', row.entry_status);
      console.log('');
    });
    
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

checkVenterPayments();
