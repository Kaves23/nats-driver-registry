/**
 * Test the document endpoint
 */

async function testDocs() {
  try {
    const response = await fetch('http://localhost:3000/api/events/event_redstar_001/docs');
    const data = await response.json();
    
    console.log('API Response:');
    console.log(JSON.stringify(data, null, 2));
    
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testDocs();
