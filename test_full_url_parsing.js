// More realistic test - simulate full URL with multiple parameters
const url = require('url');

// Simulate what happens in a real HTTP request
const selectedItems = ['Engine Rental', 'Controlled Fuel', 'Tyres (Optional)'];
const itemsParam = encodeURIComponent(JSON.stringify(selectedItems));

// Build the full URL like the frontend does
const fullUrl = `/api/initiateRacePayment?class=${encodeURIComponent('OK-J')}&amount=14900&email=${encodeURIComponent('test@example.com')}&eventId=${encodeURIComponent('event_123')}&driverId=${encodeURIComponent('driver_456')}&items=${itemsParam}`;

console.log('=== FULL URL TEST ===\n');
console.log('📍 Full URL:', fullUrl);
console.log('');

// Parse URL like Express does
const parsedUrl = url.parse(fullUrl, true);
const queryParams = parsedUrl.query;

console.log('🔍 Express parsed query parameters:');
console.log('   class:', queryParams.class);
console.log('   amount:', queryParams.amount);
console.log('   email:', queryParams.email);
console.log('   eventId:', queryParams.eventId);
console.log('   driverId:', queryParams.driverId);
console.log('   items (raw):', queryParams.items);
console.log('');

// Test OLD backend code
console.log('❌ OLD CODE: decodeURIComponent(items) then JSON.parse():');
try {
  const items = queryParams.items;
  const decoded = decodeURIComponent(items);
  console.log('   After decodeURIComponent:', decoded);
  const parsed = JSON.parse(decoded);
  console.log('   ✅ Parsed:', parsed);
} catch (err) {
  console.log('   ❌ ERROR:', err.message);
}
console.log('');

// Test NEW backend code
console.log('✅ NEW CODE: Just JSON.parse(items) directly:');
try {
  const items = queryParams.items;
  console.log('   Direct parse from Express param:', items);
  const parsed = JSON.parse(items);
  console.log('   ✅ Parsed:', parsed);
  
  // Check item detection
  const itemsLower = parsed.map(i => (i || '').toLowerCase());
  console.log('');
  console.log('   Item Detection Results:');
  console.log('   - hasEngine:', itemsLower.some(i => i.includes('engine')));
  console.log('   - hasTyres:', itemsLower.some(i => i.includes('tyre')));
  console.log('   - hasFuel:', itemsLower.some(i => i.includes('fuel')));
  console.log('   - hasTransponder:', itemsLower.some(i => i.includes('transponder')));
  
} catch (err) {
  console.log('   ❌ ERROR:', err.message);
}
console.log('');

// Test what happens if items is empty/undefined
console.log('=== TEST EMPTY/MISSING ITEMS ===\n');
const emptyUrl = '/api/initiateRacePayment?class=OK-J&amount=2950';
const emptyParsed = url.parse(emptyUrl, true);
console.log('Query params when items missing:', emptyParsed.query.items);
console.log('items is undefined?', emptyParsed.query.items === undefined);
