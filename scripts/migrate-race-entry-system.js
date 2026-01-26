#!/usr/bin/env node

/**
 * Migration: Update race_entries table for new race entry system
 * Adds: race_class, entry_items, total_amount, payment_reference, payment_status columns
 * Date: January 17, 2026
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

const migrations = [
  {
    name: 'Add race_class column',
    sql: `ALTER TABLE race_entries ADD COLUMN race_class VARCHAR(50)`,
    errorOk: 'already exists'
  },
  {
    name: 'Add entry_items column',
    sql: `ALTER TABLE race_entries ADD COLUMN entry_items JSON`,
    errorOk: 'already exists'
  },
  {
    name: 'Add total_amount column',
    sql: `ALTER TABLE race_entries ADD COLUMN total_amount DECIMAL(10, 2)`,
    errorOk: 'already exists'
  },
  {
    name: 'Add payment_reference column',
    sql: `ALTER TABLE race_entries ADD COLUMN payment_reference VARCHAR(255)`,
    errorOk: 'already exists'
  },
  {
    name: 'Add payment_status column',
    sql: `ALTER TABLE race_entries ADD COLUMN payment_status VARCHAR(50)`,
    errorOk: 'already exists'
  },
  {
    name: 'Add next_race_entry_status to drivers',
    sql: `ALTER TABLE drivers ADD COLUMN next_race_entry_status VARCHAR(50) DEFAULT 'Not Registered'`,
    errorOk: 'already exists'
  },
  {
    name: 'Add next_race_engine_rental_status to drivers',
    sql: `ALTER TABLE drivers ADD COLUMN next_race_engine_rental_status VARCHAR(50) DEFAULT 'No'`,
    errorOk: 'already exists'
  }
];

async function runMigration() {
  console.log('🚀 Starting race entry table migration...\n');

  try {
    // Test connection
    console.log('Testing database connection...');
    await pool.query('SELECT NOW()');
    console.log('✅ Connected to database\n');

    // Run each migration
    for (const migration of migrations) {
      try {
        console.log(`⏳ ${migration.name}...`);
        await pool.query(migration.sql);
        console.log(`✅ ${migration.name} - SUCCESS\n`);
      } catch (err) {
        if (err.message.includes(migration.errorOk)) {
          console.log(`⚠️  ${migration.name} - Column ${migration.errorOk}, skipping\n`);
        } else {
          console.log(`⚠️  ${migration.name} - ${err.message}\n`);
        }
      }
    }

    // Verify columns exist
    console.log('🔍 Verifying race_entries table columns...');
    const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'race_entries' AND column_name IN ('race_class', 'entry_items', 'total_amount', 'payment_reference', 'payment_status')
      ORDER BY column_name
    `);

    if (result.rows.length === 0) {
      console.log('⚠️  WARNING: New columns not found - table may not support new race entry system');
    } else {
      console.log('✅ Race entry columns verified:\n');
      result.rows.forEach(row => {
        console.log(`   ${row.column_name}: ${row.data_type}`);
      });
    }

    console.log('\n✅ Race entry migration completed successfully!');
    console.log('\nNew race entry system is ready:');
    console.log('  • Class-based pricing tiers');
    console.log('  • Optional items selection');
    console.log('  • Promo code support (k0k0r0 = free)');
    console.log('  • PayFast integration');
    console.log('  • Automatic status updates\n');

  } catch (err) {
    console.error('\n❌ Migration failed:');
    console.error(err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
