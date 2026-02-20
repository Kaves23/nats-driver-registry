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

async function checkBillauPayment() {
  try {
    const result = await pool.query(`
      SELECT * FROM payments 
      WHERE LOWER(email_address) LIKE '%billau%' 
         OR LOWER(name_first) LIKE '%billau%'
         OR payment_id LIKE '%billau%' 
         OR driver_id = '8cc0750c-c83f-4133-a682-77611e37813d'
    `);
    
    console.log('=== PAYMENTS FOR BILLAU ===\n');
    if (result.rows.length > 0) {
      console.log(`✅ Found ${result.rows.length} payment(s):\n`);
      result.rows.forEach(p => {
        console.log(JSON.stringify(p, null, 2));
        console.log('\n---\n');
      });
    } else {
      console.log('❌ NO PAYMENTS FOUND for Billau');
      console.log('   Driver ID: 8cc0750c-c83f-4133-a682-77611e37813d');
      console.log('   Contact Email: jackybillau@gmail.com');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

checkBillauPayment();
