#!/usr/bin/env node
/**
 * Migration Script: Populate engine and team_code columns retroactively
 * This script updates existing race entries based on their entry_items JSON
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

async function migrateEngineColumn() {
  try {
    console.log('🔄 Starting migration: Populate engine and team_code columns...\n');

    // Get all race entries
    const result = await pool.query('SELECT entry_id, entry_items, engine, team_code FROM race_entries ORDER BY created_at DESC');
    const entries = result.rows;

    console.log(`📊 Found ${entries.length} race entries to process\n`);

    let engineUpdated = 0;
    let teamCodeUpdated = 0;

    for (const entry of entries) {
      let engineValue = entry.engine;
      let teamCodeValue = entry.team_code;
      let needsUpdate = false;

      // Parse entry_items JSON to check for engine rental
      if (entry.entry_items) {
        try {
          const itemsArray = typeof entry.entry_items === 'string' 
            ? JSON.parse(entry.entry_items) 
            : entry.entry_items;
          
          if (Array.isArray(itemsArray)) {
            const hasEngine = itemsArray.some(item => 
              item.name && (item.name.toLowerCase().includes('engine') || item.name.toLowerCase().includes('rental'))
            );
            
            if (hasEngine && engineValue !== 1) {
              engineValue = 1;
              needsUpdate = true;
              engineUpdated++;
            }
          }
        } catch (e) {
          console.error(`⚠️  Error parsing entry_items for ${entry.entry_id}:`, e.message);
        }
      }

      // Update if needed
      if (needsUpdate) {
        await pool.query(
          'UPDATE race_entries SET engine = $1 WHERE entry_id = $2',
          [engineValue, entry.entry_id]
        );
        console.log(`✅ Entry ${entry.entry_id}: engine set to 1`);
      }
    }

    console.log(`\n📈 Migration Summary:`);
    console.log(`   - Engine column updated: ${engineUpdated} entries`);
    console.log(`   - Total entries processed: ${entries.length}`);

    // Now ask about team_code for the specific driver
    console.log(`\n📝 Team Code Population:`);
    console.log(`   The entries from Jan 17 that used k0k0r0 code should be updated manually.`);
    console.log(`   You can identify them by looking for entries with:`);
    console.log(`   - Driver email: win@rokthenats.co.za`);
    console.log(`   - Created date: 2026-01-17`);
    console.log(`\n   To update them, run:`);
    console.log(`   UPDATE race_entries SET team_code = 'k0k0r0' WHERE driver_id = 'DRIVER_ID_HERE' AND DATE(created_at) = '2026-01-17'`);

    console.log('\n✅ Migration completed successfully!');
    
  } catch (err) {
    console.error('❌ Migration error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run migration
migrateEngineColumn();
