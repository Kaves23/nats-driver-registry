const https = require('https');

const data = JSON.stringify({ email: 'johnduvill@gmail.com' });

const options = {
  hostname: 'rokthenats.co.za',
  path: '/api/test-email',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = https.request(options, (res) => {
  let body = '';
  
  res.on('data', (chunk) => {
    body += chunk;
  });
  
  res.on('end', () => {
    console.log('✅ Test email request completed');
    console.log('Status Code:', res.statusCode);
    console.log('Response:', body);
  });
});

req.on('error', (error) => {
  console.error('❌ Error:', error.message);
});

console.log('📧 Sending test email to johnduvill@gmail.com...');
req.write(data);
req.end();
