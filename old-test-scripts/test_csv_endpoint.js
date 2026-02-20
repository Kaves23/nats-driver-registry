/**
 * Test the /api/exportOfficialsCSV endpoint locally
 */

const fs = require('fs');

async function testEndpoint() {
  try {
    console.log('🧪 Testing /api/exportOfficialsCSV endpoint...\n');
    
    // Note: You'll need to get a real official token from the officials.html login
    // For now, this will test the endpoint structure
    const token = 'test-token-replace-with-real-token';
    
    const response = await fetch('http://localhost:3000/api/exportOfficialsCSV', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ format: 'timing' })
    });
    
    console.log('Response status:', response.status);
    console.log('Response headers:', Object.fromEntries(response.headers.entries()));
    
    if (response.ok) {
      const csvText = await response.text();
      console.log('\n✅ CSV Export successful!');
      console.log(`   Length: ${csvText.length} characters`);
      console.log('\n📋 First 5 lines:');
      console.log('━'.repeat(80));
      csvText.split('\n').slice(0, 5).forEach((line, i) => {
        console.log(`${i + 1}: ${line}`);
      });
      console.log('━'.repeat(80));
      
      // Save to file
      const filename = 'test-timing-export.csv';
      fs.writeFileSync(filename, csvText);
      console.log(`\n💾 Saved to ${filename}`);
      
    } else {
      const errorData = await response.json();
      console.error('\n❌ Request failed:', errorData);
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

testEndpoint();
