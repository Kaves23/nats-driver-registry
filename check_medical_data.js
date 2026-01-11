const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function checkMedicalData() {
  try {
    // Check medical_consent table
    const result = await pool.query('SELECT * FROM medical_consent');
    
    console.log('\n=== MEDICAL CONSENT DATA ===');
    console.log(`Total records: ${result.rows.length}\n`);
    
    if (result.rows.length === 0) {
      console.log('❌ No medical data found in database');
    } else {
      result.rows.forEach((row, index) => {
        console.log(`Record ${index + 1}:`);
        console.log(`  Driver ID: ${row.driver_id}`);
        console.log(`  Allergies: ${row.allergies || '(none)'}`);
        console.log(`  Medical Conditions: ${row.medical_conditions || '(none)'}`);
        console.log(`  Medication: ${row.medication || '(none)'}`);
        console.log(`  Doctor Phone: ${row.doctor_phone || '(none)'}`);
        console.log(`  Consent Signed: ${row.consent_signed || '(none)'}`);
        console.log(`  Consent Date: ${row.consent_date || '(none)'}`);
        console.log('');
      });
    }
    
    // Also check total driver count
    const drivers = await pool.query('SELECT COUNT(*) FROM drivers');
    console.log(`Total drivers in system: ${drivers.rows[0].count}`);
    
    await pool.end();
  } catch (err) {
    console.error('❌ Database error:', err.message);
    process.exit(1);
  }
}

checkMedicalData();
