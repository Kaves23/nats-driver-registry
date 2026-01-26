#!/usr/bin/env node

/**
 * Migration: Add soft delete columns to drivers table
 * Adds: is_deleted (BOOLEAN), deleted_at (TIMESTAMP), created_at (TIMESTAMP)
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
    name: 'Add is_deleted column',
    sql: `ALTER TABLE drivers ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE`,
    errorOk: 'already exists'
  },
  {
    name: 'Add deleted_at column',
    sql: `ALTER TABLE drivers ADD COLUMN deleted_at TIMESTAMP NULL`,
    errorOk: 'already exists'
  },
  {
    name: 'Add created_at column with default',
    sql: `ALTER TABLE drivers ADD COLUMN created_at TIMESTAMP DEFAULT NOW()`,
    errorOk: 'already exists'
  }
];

async function runMigration() {
  console.log('🚀 Starting database migration...\n');

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
          throw err;
        }
      }
    }

    // Verify columns exist
    console.log('🔍 Verifying columns...');
    const result = await pool.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'drivers' AND column_name IN ('is_deleted', 'deleted_at', 'created_at')
      ORDER BY column_name
    `);

    if (result.rows.length === 0) {
      console.log('⚠️  WARNING: Columns not found in database');
      console.log('This might be a schema or permission issue.');
    } else {
      console.log('✅ Columns verified:\n');
      result.rows.forEach(row => {
        console.log(`   ${row.column_name}: ${row.data_type}${row.column_default ? ` (default: ${row.column_default})` : ''}`);
      });
    }

    console.log('\n✅ Migration completed successfully!');
    console.log('\nThe following features are now ready to use:');
    console.log('  • Soft delete drivers (DELETE button in admin portal)');
    console.log('  • Export drivers to CSV (EXPORT CSV button)');
    console.log('  • Automatic audit logging of deletions\n');

  } catch (err) {
    console.error('\n❌ Migration failed:');
    console.error(err.message);
    console.error('\nPlease check:');
    console.error('  1. Database credentials in .env file');
    console.error('  2. Database connection and permissions');
    console.error('  3. The drivers table exists\n');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
