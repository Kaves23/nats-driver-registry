// Test getAllDrivers API endpoint
const http = require('http');

const testGetAllDrivers = () => {
  const postData = JSON.stringify({
    email: '',
    name: '',
    status: '',
    paid: ''
  });

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/getAllDrivers',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = http.request(options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      console.log('Response Status:', res.statusCode);
      console.log('Response Headers:', res.headers);
      console.log('\nResponse Body:');
      try {
        const jsonData = JSON.parse(data);
        console.log(JSON.stringify(jsonData, null, 2));
        
        if (jsonData.success) {
          console.log('\n✅ API call successful');
          console.log(`Found ${jsonData.data.drivers.length} drivers`);
          if (jsonData.data.drivers.length > 0) {
            console.log('\nFirst driver sample:');
            console.log(JSON.stringify(jsonData.data.drivers[0], null, 2));
          } else {
            console.log('\n⚠️ No drivers in database');
          }
        } else {
          console.log('\n❌ API call failed:', jsonData.error);
        }
      } catch (e) {
        console.log('Raw response:', data);
        console.log('\n❌ Error parsing JSON:', e.message);
      }
    });
  });

  req.on('error', (e) => {
    console.error('❌ Request error:', e.message);
  });

  req.write(postData);
  req.end();
};

console.log('🧪 Testing getAllDrivers API endpoint...\n');
testGetAllDrivers();
