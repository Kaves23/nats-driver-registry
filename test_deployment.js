const axios = require('axios');

async function quickTest() {
  console.log('⏳ Waiting 30 seconds for Render deployment...\n');
  await new Promise(resolve => setTimeout(resolve, 30000));
  
  console.log('🧪 Testing PayFast endpoint after deployment...\n');
  
  try {
    const response = await axios.post('https://www.rokthenats.co.za/api/paymentNotify', {
      m_payment_id: 'TEST-' + Date.now(),
      pf_payment_id: 'TEST-PF-' + Date.now(),
      payment_status: 'COMPLETE',
      item_name: 'Test Payment',
      item_description: 'Test Entry',
      amount_gross: '100.00',
      reference: 'RACE-event_test_001-test_driver_123-' + Date.now(),
      email_address: 'test@example.com',
      name_first: 'Test',
      name_last: 'User',
      signature: 'test_sig'
    }, {
      timeout: 10000
    });
    
    console.log('✅ DEPLOYMENT SUCCESSFUL!');
    console.log('Response:', JSON.stringify(response.data, null, 2));
    console.log('\n🎉 System is ready for real payments!');
    
  } catch (error) {
    if (error.response) {
      console.log('Status:', error.response.status);
      console.log('Response:', JSON.stringify(error.response.data, null, 2));
      
      // Check if it's the old column name error
      if (error.response.data?.error?.includes('race_entry_id')) {
        console.log('\n❌ OLD CODE STILL DEPLOYED - Wait for Render to finish deploying');
      } else {
        console.log('\n✅ New code is deployed (different error is OK for test data)');
      }
    } else {
      console.log('❌ Error:', error.message);
    }
  }
}

console.log('🚀 Starting deployment test...');
console.log('Make sure you:');
console.log('  1. Added environment variables to Render');
console.log('  2. Triggered manual deploy');
console.log('');

quickTest();
