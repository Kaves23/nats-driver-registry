// Check event registration status via API
const http = require('http');

async function checkEvents() {
  console.log('\n🔍 Checking Events Registration Status via API\n' + '='.repeat(80));
  
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: 'localhost',
      port: 3000,
      path: '/api/getAllEvents',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          
          if (!result.success) {
            console.error('❌ API error:', result.error);
            resolve();
            return;
          }
          
          const events = result.events || [];
          console.log(`\nFound ${events.length} events:\n`);
          
          const now = new Date();
          
          events.forEach((event, idx) => {
            const deadline = event.registration_deadline ? new Date(event.registration_deadline) : null;
            const isOpen = event.registration_open !== false && (!deadline || deadline > now);
            
            let status;
            if (event.registration_open === false) {
              status = '🔴 CLOSED (registration_open = false)';
            } else if (!deadline) {
              status = '🟢 OPEN (no deadline)';
            } else if (deadline > now) {
              const daysUntil = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));
              status = `🟢 OPEN (closes in ${daysUntil} days)`;
            } else {
              status = '🔴 CLOSED (deadline passed)';
            }
            
            console.log(`\n${idx + 1}. ${event.event_name}`);
            console.log(`   Event ID: ${event.event_id}`);
            console.log(`   Location: ${event.location}`);
            console.log(`   Date: ${event.event_date}`);
            console.log(`   Registration Open Flag: ${event.registration_open}`);
            console.log(`   Registration Deadline: ${event.registration_deadline || 'None'}`);
            console.log(`   ⚡ STATUS: ${status}`);
          });
          
          console.log('\n' + '='.repeat(80));
          console.log('\n✅ Check complete!\n');
          resolve();
          
        } catch (err) {
          console.error('❌ Parse error:', err.message);
          reject(err);
        }
      });
    });
    
    req.on('error', (err) => {
      console.error('❌ Request error:', err.message);
      console.log('\nℹ️  Make sure server is running on port 3000');
      reject(err);
    });
    
    req.end();
  });
}

checkEvents();
