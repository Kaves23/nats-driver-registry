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

async function checkPaymentsTable() {
  try {
    console.log('🔍 Checking payments table structure and data...\n');
    
    // Get table schema
    const schema = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'payments'
      ORDER BY ordinal_position
    `);
    
    console.log('📋 Payments table columns:');
    schema.rows.forEach(col => {
      console.log(`   - ${col.column_name} (${col.data_type})`);
    });
    
    // Get all payments
    const payments = await pool.query(`
      SELECT 
        p.*,
        d.first_name,
        d.last_name,
        c.email
      FROM payments p
      LEFT JOIN drivers d ON p.driver_id = d.driver_id
      LEFT JOIN contacts c ON p.driver_id = c.driver_id
      ORDER BY p.created_at DESC
      LIMIT 20
    `);
    
    console.log(`\n💰 Found ${payments.rows.length} payments in payments table:\n`);
    payments.rows.forEach(p => {
      console.log(`   ${p.first_name} ${p.last_name}: R${parseFloat(p.amount_gross || p.amount_net || 0).toFixed(2)}`);
      console.log(`      Payment ID: ${p.payment_id}`);
      console.log(`      Merchant Ref: ${p.merchant_payment_id || 'N/A'}`);
      console.log(`      Status: ${p.payment_status}`);
      console.log(`      Item: ${p.item_name || 'N/A'}`);
      console.log(`      Description: ${p.item_description || 'N/A'}`);
      console.log(`      Created: ${p.created_at}`);
      console.log('');
    });
    
    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

checkPaymentsTable();
