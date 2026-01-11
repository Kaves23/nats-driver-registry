const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/getAllDrivers',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

const req = http.request(options, (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      
      if (response.success && response.data.drivers) {
        const drivers = response.data.drivers;
        
        console.log('\n=== MEDICAL DATA CHECK ===');
        console.log(`Total drivers retrieved: ${drivers.length}\n`);
        
        let hasmedical = false;
        
        drivers.forEach((driver, index) => {
          if (driver.medical_allergies || driver.medical_conditions || driver.medical_medication || driver.medical_doctor_phone) {
            hasmedical = true;
            console.log(`Driver ${index + 1}: ${driver.first_name} ${driver.last_name}`);
            console.log(`  Email: ${driver.driver_email}`);
            console.log(`  Allergies: ${driver.medical_allergies || '(none)'}`);
            console.log(`  Conditions: ${driver.medical_conditions || '(none)'}`);
            console.log(`  Medication: ${driver.medical_medication || '(none)'}`);
            console.log(`  Doctor Phone: ${driver.medical_doctor_phone || '(none)'}`);
            console.log(`  Consent: ${driver.medical_consent_signed || '(none)'}`);
            console.log('');
          }
        });
        
        if (!hasmedical) {
          console.log('❌ No medical data found - drivers may not have completed medical form');
          console.log('   Or no drivers are registered yet');
        } else {
          console.log('✅ Medical data found in database');
        }
      } else {
        console.log('Error response:', response);
      }
    } catch (e) {
      console.error('Parse error:', e.message);
    }
    process.exit(0);
  });
});

req.on('error', (e) => {
  console.error('Connection error:', e.message);
  process.exit(1);
});

req.write(JSON.stringify({}));
req.end();
