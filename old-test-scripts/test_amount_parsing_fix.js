/**
 * Test script to validate amount parsing fix
 * Tests various input formats to ensure correct parsing
 */

// Simulate the FIXED parsing logic from server.js
function parseAmountFixed(amount) {
  let cleanAmount = String(amount)
    .replace(/R/g, '')
    .replace(/\s/g, '')
    .trim();
  
  // Smart comma/period handling
  if (cleanAmount.includes(',') && cleanAmount.includes('.')) {
    // Both present: comma is thousand separator (international: 10,170.00)
    cleanAmount = cleanAmount.replace(/,/g, '');
  } else if (cleanAmount.includes(',')) {
    // Only comma: it's decimal separator (SA: 10170,00)
    cleanAmount = cleanAmount.replace(',', '.');
  }
  
  return parseFloat(cleanAmount);
}

// Simulate the OLD BUGGED logic
function parseAmountBugged(amount) {
  let cleanAmount = String(amount)
    .replace(/R/g, '')
    .replace(/\s/g, '')
    .replace(/,/g, '.')  // ❌ BUG: Replaces ALL commas blindly
    .trim();
  
  return parseFloat(cleanAmount);
}

// Test cases
const testCases = [
  { input: 'R10 170,00', expected: 10170.00, description: 'SA format with space thousand separator' },
  { input: 'R10,170.00', expected: 10170.00, description: 'International format with comma thousand separator' },
  { input: 'R10170.00', expected: 10170.00, description: 'Plain format with period decimal' },
  { input: 'R10170,00', expected: 10170.00, description: 'SA format without thousand separator' },
  { input: 'R2 950,00', expected: 2950.00, description: 'Standard SA entry fee' },
  { input: 'R2,950.00', expected: 2950.00, description: 'Standard international entry fee' },
  { input: 'R1 234 567,89', expected: 1234567.89, description: 'Large SA amount' },
  { input: 'R1,234,567.89', expected: 1234567.89, description: 'Large international amount' },
  { input: 'R0.00', expected: 0.00, description: 'Zero amount' },
  { input: 'R100', expected: 100.00, description: 'Whole number' }
];

console.log('🧪 Testing Amount Parsing Fix\n');
console.log('='.repeat(80));

let allPassed = true;

testCases.forEach((test, i) => {
  const fixedResult = parseAmountFixed(test.input);
  const buggedResult = parseAmountBugged(test.input);
  const fixedPass = Math.abs(fixedResult - test.expected) < 0.01;
  const buggedPass = Math.abs(buggedResult - test.expected) < 0.01;
  
  console.log(`\nTest ${i + 1}: ${test.description}`);
  console.log(`  Input:       "${test.input}"`);
  console.log(`  Expected:    R${test.expected.toFixed(2)}`);
  console.log(`  OLD (bugged): R${buggedResult.toFixed(2)} ${buggedPass ? '✅' : '❌ FAIL'}`);
  console.log(`  NEW (fixed):  R${fixedResult.toFixed(2)} ${fixedPass ? '✅' : '❌ FAIL'}`);
  
  if (!fixedPass) {
    allPassed = false;
    console.log(`  ⚠️  FAILED: Expected ${test.expected} but got ${fixedResult}`);
  }
});

console.log('\n' + '='.repeat(80));

if (allPassed) {
  console.log('\n✅ ALL TESTS PASSED! The fix correctly handles all formats.');
} else {
  console.log('\n❌ SOME TESTS FAILED! Please review the logic.');
}

console.log('\n📊 Summary of the fix:');
console.log('  • If both comma AND period exist → comma is thousand separator (remove it)');
console.log('  • If only comma exists → comma is decimal separator (convert to period)');
console.log('  • If only period exists → period is decimal separator (keep it)');
console.log('  • Spaces are always thousand separators (remove them)\n');
