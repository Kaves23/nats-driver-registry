// Test script to verify items parameter encoding/decoding fix

// Simulate what the frontend sends (Klassen's actual order)
const selectedItems = [
  'Engine Rental',
  'Controlled Fuel',
  'Tyres (Optional)'
];

console.log('=== TESTING ITEMS PARAMETER ENCODING/DECODING ===\n');
console.log('📦 Original selectedItems array:', selectedItems);
console.log('');

// Step 1: Frontend encodes
const frontendEncoded = encodeURIComponent(JSON.stringify(selectedItems));
console.log('1️⃣ Frontend encodes with encodeURIComponent(JSON.stringify()):');
console.log('   Result:', frontendEncoded);
console.log('');

// Step 2: Express automatically decodes query parameters
// Simulating what Express does: decodeURIComponent
const expressDecoded = decodeURIComponent(frontendEncoded);
console.log('2️⃣ Express automatically decodes req.query.items:');
console.log('   Result:', expressDecoded);
console.log('');

// Step 3a: OLD BACKEND CODE (BUGGY - double decode)
console.log('❌ OLD CODE: Backend tries to decodeURIComponent() AGAIN:');
try {
  const oldBackendDecoded = decodeURIComponent(expressDecoded);
  console.log('   After double decode:', oldBackendDecoded);
  const oldParsed = JSON.parse(oldBackendDecoded);
  console.log('   ✅ Parsed successfully:', oldParsed);
} catch (err) {
  console.log('   ❌ PARSE FAILED:', err.message);
}
console.log('');

// Step 3b: NEW BACKEND CODE (FIXED - single decode)
console.log('✅ NEW CODE: Backend just parses directly (Express already decoded):');
try {
  const newParsed = JSON.parse(expressDecoded);
  console.log('   ✅ Parsed successfully:', newParsed);
  console.log('');
  
  // Test item detection
  const itemsLower = newParsed.map(i => (i || '').toLowerCase());
  const hasEngine = itemsLower.some(i => i.includes('engine') || i.includes('rental'));
  const hasTyres = itemsLower.some(i => i.includes('tyre'));
  const hasFuel = itemsLower.some(i => i.includes('fuel'));
  const hasTransponder = itemsLower.some(i => i.includes('transponder'));
  
  console.log('   🔍 Item Detection:');
  console.log('      hasEngine:', hasEngine);
  console.log('      hasTyres:', hasTyres);
  console.log('      hasFuel:', hasFuel);
  console.log('      hasTransponder:', hasTransponder);
  
} catch (err) {
  console.log('   ❌ PARSE FAILED:', err.message);
}
console.log('');

// Test with special characters
console.log('=== TESTING WITH SPECIAL CHARACTERS ===\n');
const specialItems = [
  'Tyres (Optional)',
  'Rent & Transport',
  'Item #1'
];

const specialEncoded = encodeURIComponent(JSON.stringify(specialItems));
const specialExpressDecoded = decodeURIComponent(specialEncoded);

console.log('Special items:', specialItems);
console.log('After Express decode:', specialExpressDecoded);

try {
  const parsedSpecial = JSON.parse(specialExpressDecoded);
  console.log('✅ Parsed correctly:', parsedSpecial);
} catch (err) {
  console.log('❌ Parse failed:', err.message);
}
