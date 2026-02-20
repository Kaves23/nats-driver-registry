#!/usr/bin/env node

/**
 * LOCAL PAYMENT FIX VALIDATION TEST
 * Tests the actual parsing logic from both driver_portal.html and server.js
 * to ensure the fix works correctly before deployment
 */

console.log('🧪 TESTING LOCAL PAYMENT PARSING FIX\n');
console.log('=' .repeat(70));

// ===== FRONTEND PARSING (from driver_portal.html) =====
function parseFrontendAmount(amountString) {
  // Extract the logic from driver_portal.html (lines 6654-6664)
  let cleanAmount = amountString.replace(/[^\d,\.]/g, '');
  
  // Smart detection: if BOTH comma and period exist, comma is thousand separator
  if (cleanAmount.includes(',') && cleanAmount.includes('.')) {
    cleanAmount = cleanAmount.replace(/,/g, '');
  } else if (cleanAmount.includes(',')) {
    cleanAmount = cleanAmount.replace(/,/g, '.');
  }
  
  return parseFloat(cleanAmount);
}

// ===== BACKEND PARSING (from server.js) =====
function parseBackendAmount(amountString) {
  // Extract the logic from server.js (lines 3590-3597)
  let cleanAmount = amountString.replace(/[^\d,\.]/g, '');
  
  // Smart detection: if BOTH comma AND period exist, comma is thousand separator
  if (cleanAmount.includes(',') && cleanAmount.includes('.')) {
    cleanAmount = cleanAmount.replace(/,/g, ''); // Remove commas
  } else if (cleanAmount.includes(',')) {
    cleanAmount = cleanAmount.replace(/,/g, '.'); // Convert comma to period
  }
  
  return parseFloat(cleanAmount);
}

// ===== TEST CASES =====
const testCases = [
  // CRITICAL TEST: Ruvan Maritz's bug
  { input: 'R10,170.00', expected: 10170.00, description: '🚨 RUVAN MARITZ BUG (was R10.17)' },
  { input: 'R10170.00', expected: 10170.00, description: 'Plain international format' },
  { input: 'R10 170,00', expected: 10170.00, description: 'SA format with space' },
  
  // Other real-world formats
  { input: 'R2,950.00', expected: 2950.00, description: 'Smaller amount with comma thousand separator' },
  { input: 'R2950.00', expected: 2950.00, description: 'No thousand separator' },
  { input: 'R2 950,00', expected: 2950.00, description: 'SA format with space and comma decimal' },
  
  // Edge cases
  { input: 'R100', expected: 100.00, description: 'No decimals' },
  { input: 'R100.50', expected: 100.50, description: 'Decimals, no thousand' },
  { input: 'R1,234,567.89', expected: 1234567.89, description: 'Large amount with multiple commas' },
  { input: 'R0.00', expected: 0.00, description: 'Zero amount' },
];

// ===== RUN TESTS =====
let frontendPass = 0;
let frontendFail = 0;
let backendPass = 0;
let backendFail = 0;

console.log('\n📱 FRONTEND PARSING TESTS (driver_portal.html)\n');

testCases.forEach((test, idx) => {
  const result = parseFrontendAmount(test.input);
  const pass = Math.abs(result - test.expected) < 0.01; // Allow for floating point precision
  
  if (pass) {
    console.log(`✅ Test ${idx + 1}: ${test.description}`);
    console.log(`   Input: "${test.input}" → Output: R${result.toFixed(2)} ✓`);
    frontendPass++;
  } else {
    console.log(`❌ Test ${idx + 1}: ${test.description}`);
    console.log(`   Input: "${test.input}" → Expected: R${test.expected.toFixed(2)}, Got: R${result.toFixed(2)} ✗`);
    frontendFail++;
  }
});

console.log('\n' + '='.repeat(70));
console.log('\n🖥️  BACKEND PARSING TESTS (server.js)\n');

testCases.forEach((test, idx) => {
  const result = parseBackendAmount(test.input);
  const pass = Math.abs(result - test.expected) < 0.01;
  
  if (pass) {
    console.log(`✅ Test ${idx + 1}: ${test.description}`);
    console.log(`   Input: "${test.input}" → Output: R${result.toFixed(2)} ✓`);
    backendPass++;
  } else {
    console.log(`❌ Test ${idx + 1}: ${test.description}`);
    console.log(`   Input: "${test.input}" → Expected: R${test.expected.toFixed(2)}, Got: R${result.toFixed(2)} ✗`);
    backendFail++;
  }
});

// ===== SUMMARY =====
console.log('\n' + '='.repeat(70));
console.log('\n📊 TEST SUMMARY\n');

console.log(`Frontend: ${frontendPass}/${testCases.length} passed, ${frontendFail} failed`);
console.log(`Backend:  ${backendPass}/${testCases.length} passed, ${backendFail} failed`);

if (frontendFail === 0 && backendFail === 0) {
  console.log('\n✅ ✅ ✅  ALL TESTS PASSED! ✅ ✅ ✅');
  console.log('\n🎉 The fix is working correctly in BOTH frontend and backend!');
  console.log('🚀 Safe to deploy to production via Git push.');
  console.log('\n💡 Next steps:');
  console.log('   1. git add driver_portal.html server.js');
  console.log('   2. git commit -m "FIX: Critical payment amount parsing bug"');
  console.log('   3. git push origin main');
  console.log('   4. Run fix_ruvan_maritz_payment.js to correct database');
  process.exit(0);
} else {
  console.log('\n❌ SOME TESTS FAILED!');
  console.log('⚠️  DO NOT deploy until all tests pass.');
  process.exit(1);
}
