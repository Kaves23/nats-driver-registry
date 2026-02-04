const {Pool} = require('pg');
require('dotenv').config();

const pool = new Pool({connectionString: process.env.DATABASE_URL});

async function checkDiscount() {
  try {
    const result = await pool.query(
      `SELECT code, description, discount_type, discount_value, is_active 
       FROM discount_codes 
       WHERE UPPER(code) LIKE '%JOHNTEST%'`
    );
    
    console.log('=== JOHNTEST DISCOUNT CODE ===\n');
    if (result.rows.length > 0) {
      result.rows.forEach(row => {
        console.log(JSON.stringify(row, null, 2));
      });
    } else {
      console.log('No discount code found with "johntest"');
      console.log('\n=== ALL DISCOUNT CODES ===');
      const all = await pool.query('SELECT * FROM discount_codes ORDER BY created_at DESC LIMIT 5');
      all.rows.forEach(row => {
        console.log(JSON.stringify(row, null, 2));
      });
    }
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

checkDiscount();
