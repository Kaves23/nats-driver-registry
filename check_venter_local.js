const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function checkVenterDetails() {
  try {
    console.log('=== CHECKING FOR VENTER IN DATABASE ===\n');
    
    // Check drivers
    const drivers = await pool.query(`
      SELECT d.*, c.email 
      FROM drivers d
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      WHERE d.last_name ILIKE '%venter%'
    `);
    
    console.log(`Found ${drivers.rows.length} Venter drivers:\n`);
    drivers.rows.forEach(d => {
      console.log(`Name: ${d.first_name} ${d.last_name}`);
      console.log(`Class: ${d.class}`);
      console.log(`Email: ${d.email}`);
      console.log(`Driver ID: ${d.driver_id}`);
      console.log(`Status: ${d.status}\n`);
    });
    
    // Check race entries for Feb 14
    const entries = await pool.query(`
      SELECT r.*, d.first_name, d.last_name, d.class as driver_class
      FROM race_entries r
      LEFT JOIN drivers d ON r.driver_id = d.driver_id
      WHERE r.event_id = 'event_redstar_001'
      AND d.last_name ILIKE '%venter%'
    `);
    
    console.log(`\n=== VENTER ENTRIES FOR FEB 14 RACE ===`);
    console.log(`Found ${entries.rows.length} entries\n`);
    
    entries.rows.forEach(e => {
      console.log('---');
      console.log(`Driver: ${e.first_name} ${e.last_name}`);
      console.log(`Class: ${e.driver_class} / ${e.race_class}`);
      console.log(`Payment Status: ${e.payment_status}`);
      console.log(`Entry Status: ${e.entry_status}`);
      console.log(`Amount: R${e.amount_paid}`);
      console.log(`Reference: ${e.payment_reference}`);
      console.log(`Created: ${e.created_at}\n`);
    });
    
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

checkVenterDetails();
