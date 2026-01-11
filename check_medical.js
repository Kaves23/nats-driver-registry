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

async function checkMedical() {
  try {
    // Get medical data
    const medicalResult = await pool.query('SELECT * FROM medical_consent');
    
    console.log('\n=== MEDICAL CONSENT DATA IN DATABASE ===\n');
    console.log(`Total medical records: ${medicalResult.rows.length}\n`);
    
    if (medicalResult.rows.length === 0) {
      console.log('❌ NO MEDICAL DATA FOUND');
      console.log('   Medical information has not been saved from registrations.');
    } else {
      medicalResult.rows.forEach((row, index) => {
        console.log(`Record ${index + 1}:`);
        console.log(`  Driver ID: ${row.driver_id}`);
        console.log(`  Allergies: ${row.allergies || '(empty)'}`);
        console.log(`  Medical Conditions: ${row.medical_conditions || '(empty)'}`);
        console.log(`  Medication: ${row.medication || '(empty)'}`);
        console.log(`  Doctor Phone: ${row.doctor_phone || '(empty)'}`);
        console.log(`  Consent Signed: ${row.consent_signed || '(empty)'}`);
        console.log(`  Consent Date: ${row.consent_date || '(empty)'}`);
        console.log('');
      });
    }
    
    // Get driver count
    const driversResult = await pool.query('SELECT COUNT(*) as count FROM drivers');
    console.log(`Total drivers in system: ${driversResult.rows[0].count}`);
    
    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

checkMedical();
