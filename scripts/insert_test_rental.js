require('dotenv').config();
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

async function insertTestRental() {
  try {
    const rental_id = uuidv4();
    const driver_id = '596ebaa1-06cd-4324-bdde-3716ef0b9c28'; // win@rokthenats.co.za
    const championship_class = 'MINI ROK';
    const rental_type = 'Nationals';
    const amount_paid = 23200.00;
    const payment_status = 'Completed';
    const payment_reference = 'TEST-' + Date.now();
    const season_year = 2026;

    const result = await pool.query(
      `INSERT INTO pool_engine_rentals 
       (rental_id, driver_id, championship_class, rental_type, amount_paid, payment_status, payment_reference, season_year, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [rental_id, driver_id, championship_class, rental_type, amount_paid, payment_status, payment_reference, season_year]
    );

    console.log('✅ Test rental inserted successfully:');
    console.log(result.rows[0]);
    console.log('\n📋 Details:');
    console.log(`   Rental ID: ${rental_id}`);
    console.log(`   Driver ID: ${driver_id}`);
    console.log(`   Class: ${championship_class}`);
    console.log(`   Type: ${rental_type}`);
    console.log(`   Amount: R${amount_paid}`);
    console.log(`   Status: ${payment_status}`);
    console.log(`   Reference: ${payment_reference}`);
    
    await pool.end();
  } catch (error) {
    console.error('❌ Error inserting test rental:', error.message);
    await pool.end();
    process.exit(1);
  }
}

insertTestRental();
