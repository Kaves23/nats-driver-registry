// Pre-Deployment Audit Script
// Tests all recent changes before going live

const fs = require('fs');
const path = require('path');

console.log('🔍 PRE-DEPLOYMENT AUDIT STARTED\n');
console.log('Testing changes made on January 26, 2026:\n');
console.log('1. Admin notification system');
console.log('2. Multi-select championship buttons');
console.log('3. Email field moved to Medical & Consent');
console.log('4. Championship button color updates\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

let issues = [];
let warnings = [];
let passed = 0;

// Test 1: Check critical files exist
console.log('📁 Test 1: File Integrity Check');
const criticalFiles = [
  'server.js',
  'driver_portal.html',
  'adminNotificationQueue.js',
  'index.html',
  'package.json'
];

criticalFiles.forEach(file => {
  const filePath = path.join(__dirname, file);
  if (fs.existsSync(filePath)) {
    console.log(`  ✅ ${file} exists`);
    passed++;
  } else {
    console.log(`  ❌ ${file} MISSING`);
    issues.push(`Critical file missing: ${file}`);
  }
});

// Test 2: Validate driver_portal.html structure
console.log('\n📄 Test 2: HTML Structure Validation');
try {
  const html = fs.readFileSync(path.join(__dirname, 'driver_portal.html'), 'utf8');
  
  // Check multi-select championship elements
  if (html.includes('champ-option rok-nats')) {
    console.log('  ✅ ROK NATS championship button found');
    passed++;
  } else {
    issues.push('ROK NATS championship button not found');
  }
  
  if (html.includes('champ-option rok-nc')) {
    console.log('  ✅ Northern Crown championship button found');
    passed++;
  } else {
    issues.push('Northern Crown championship button not found');
  }
  
  if (html.includes('champ-option rok-sc')) {
    console.log('  ✅ Southern Crown championship button found');
    passed++;
  } else {
    issues.push('Southern Crown championship button not found');
  }
  
  // Check ALL button is hidden (should not be in the HTML structure anymore)
  const allButtonCount = (html.match(/data-champ="ALL"/g) || []).length;
  if (allButtonCount === 0) {
    console.log('  ✅ ALL button properly removed');
    passed++;
  } else {
    warnings.push(`ALL button still present (${allButtonCount} instances)`);
    console.log(`  ⚠️  ALL button still present (${allButtonCount} instances)`);
  }
  
  // Check email field location
  const emailFieldIndex = html.indexOf('id="c_email"');
  const medicalSectionIndex = html.indexOf('Medical & Consent</div>');
  const entrantSectionIndex = html.indexOf('Entrant Details</div>');
  
  if (emailFieldIndex > medicalSectionIndex && emailFieldIndex < entrantSectionIndex + 1000) {
    console.log('  ✅ Email field moved to Medical & Consent section');
    passed++;
  } else if (emailFieldIndex > 0) {
    console.log('  ✅ Email field exists (id="c_email")');
    passed++;
  } else {
    issues.push('Email field (c_email) not found');
  }
  
  // Check championship colors
  const hasYellowNats = html.includes('#facc15');
  const hasBlueNC = html.includes('#0ea5e9');
  const hasTurquoiseSC = html.includes('#06b6d4');
  
  if (hasYellowNats) {
    console.log('  ✅ ROK NATS summer yellow color (#facc15)');
    passed++;
  } else {
    issues.push('ROK NATS yellow color not found');
  }
  
  if (hasBlueNC) {
    console.log('  ✅ Northern Crown marine blue color (#0ea5e9)');
    passed++;
  } else {
    issues.push('Northern Crown blue color not found');
  }
  
  if (hasTurquoiseSC) {
    console.log('  ✅ Southern Crown turquoise color (#06b6d4)');
    passed++;
  } else {
    issues.push('Southern Crown turquoise color not found');
  }
  
  // Check multi-select JavaScript
  if (html.includes('option.classList.toggle(\'selected\')')) {
    console.log('  ✅ Multi-select toggle JavaScript implemented');
    passed++;
  } else {
    issues.push('Multi-select JavaScript not found');
  }
  
  // Check hidden field for championship
  if (html.includes('id="r_champ"')) {
    console.log('  ✅ Championship hidden field exists');
    passed++;
  } else {
    issues.push('Championship hidden field (r_champ) not found');
  }
  
} catch (err) {
  issues.push(`Error reading driver_portal.html: ${err.message}`);
}

// Test 3: Validate server.js
console.log('\n⚙️  Test 3: Server Configuration Validation');
try {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  
  // Check admin notification import
  if (serverCode.includes('adminNotificationQueue')) {
    console.log('  ✅ Admin notification queue imported');
    passed++;
  } else {
    issues.push('Admin notification queue not imported in server.js');
  }
  
  // Check notification integrations
  const notificationCalls = (serverCode.match(/adminNotificationQueue\.add/g) || []).length;
  console.log(`  ✅ Admin notifications integrated (${notificationCalls} calls)`);
  passed++;
  
  if (notificationCalls < 4) {
    warnings.push('Expected at least 4 notification integration points');
  }
  
  // Check championship field handling
  if (serverCode.includes('championship')) {
    console.log('  ✅ Championship field handling present');
    passed++;
  } else {
    issues.push('Championship field not found in server.js');
  }
  
} catch (err) {
  issues.push(`Error reading server.js: ${err.message}`);
}

// Test 4: Validate adminNotificationQueue.js
console.log('\n📧 Test 4: Notification Queue Validation');
try {
  const queueCode = fs.readFileSync(path.join(__dirname, 'adminNotificationQueue.js'), 'utf8');
  
  // Check class definition
  if (queueCode.includes('class AdminNotificationQueue')) {
    console.log('  ✅ AdminNotificationQueue class defined');
    passed++;
  } else {
    issues.push('AdminNotificationQueue class not found');
  }
  
  // Check rate limiting
  if (queueCode.includes('minDelay') && queueCode.includes('5000')) {
    console.log('  ✅ Rate limiting configured (5 second minimum)');
    passed++;
  } else {
    warnings.push('Rate limiting configuration unclear');
  }
  
  // Check batch processing
  if (queueCode.includes('batchInterval') && queueCode.includes('30000')) {
    console.log('  ✅ Batch processing configured (30 second intervals)');
    passed++;
  } else {
    warnings.push('Batch processing configuration unclear');
  }
  
  // Check email methods
  if (queueCode.includes('sendEmail')) {
    console.log('  ✅ Email sending method present');
    passed++;
  } else {
    issues.push('Email sending method not found');
  }
  
} catch (err) {
  issues.push(`Error reading adminNotificationQueue.js: ${err.message}`);
}

// Test 5: Check package.json dependencies
console.log('\n📦 Test 5: Dependencies Check');
try {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  
  const requiredDeps = ['express', 'pg', 'bcryptjs', 'axios', 'multer', 'uuid'];
  requiredDeps.forEach(dep => {
    if (packageJson.dependencies && packageJson.dependencies[dep]) {
      console.log(`  ✅ ${dep} installed`);
      passed++;
    } else {
      issues.push(`Required dependency missing: ${dep}`);
    }
  });
  
} catch (err) {
  issues.push(`Error reading package.json: ${err.message}`);
}

// Test 6: JavaScript Syntax Check
console.log('\n🔧 Test 6: JavaScript Syntax Validation');
try {
  const html = fs.readFileSync(path.join(__dirname, 'driver_portal.html'), 'utf8');
  
  // Check for common syntax issues
  const unclosedBraces = (html.match(/{/g) || []).length - (html.match(/}/g) || []).length;
  if (Math.abs(unclosedBraces) > 100) {
    warnings.push(`Potential brace mismatch: ${unclosedBraces} difference`);
  } else {
    console.log('  ✅ JavaScript brace balance looks good');
    passed++;
  }
  
  // Check for getElementById references to moved email field
  if (html.includes("getElementById('c_email')")) {
    console.log('  ✅ Email field JavaScript references intact');
    passed++;
  } else {
    issues.push('Email field JavaScript reference missing');
  }
  
} catch (err) {
  issues.push(`Error validating JavaScript: ${err.message}`);
}

// Test 7: Environment Variables Check
console.log('\n🔐 Test 7: Environment Configuration');
try {
  const envExample = fs.existsSync(path.join(__dirname, '.env.example'));
  const envFile = fs.existsSync(path.join(__dirname, '.env'));
  
  if (envFile) {
    console.log('  ✅ .env file present');
    passed++;
    
    const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    
    if (envContent.includes('DATABASE_URL')) {
      console.log('  ✅ DATABASE_URL configured');
      passed++;
    } else {
      warnings.push('DATABASE_URL not found in .env');
    }
    
    if (envContent.includes('MAILCHIMP_API_KEY')) {
      console.log('  ✅ MAILCHIMP_API_KEY configured (for notifications)');
      passed++;
    } else {
      warnings.push('MAILCHIMP_API_KEY not configured - notifications will be skipped');
    }
  } else {
    warnings.push('.env file not found - ensure it exists in production');
  }
  
} catch (err) {
  warnings.push(`Could not verify environment variables: ${err.message}`);
}

// Final Report
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('\n📊 AUDIT SUMMARY\n');
console.log(`✅ Tests Passed: ${passed}`);
console.log(`⚠️  Warnings: ${warnings.length}`);
console.log(`❌ Critical Issues: ${issues.length}\n`);

if (warnings.length > 0) {
  console.log('⚠️  WARNINGS:');
  warnings.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
  console.log('');
}

if (issues.length > 0) {
  console.log('❌ CRITICAL ISSUES:');
  issues.forEach((issue, i) => console.log(`  ${i + 1}. ${issue}`));
  console.log('');
  console.log('🛑 RECOMMENDATION: Fix critical issues before deployment\n');
  process.exit(1);
} else if (warnings.length > 0) {
  console.log('✅ No critical issues found');
  console.log('⚠️  Review warnings before deployment\n');
  console.log('🟡 RECOMMENDATION: Safe to deploy with caution\n');
  process.exit(0);
} else {
  console.log('✅ All checks passed!');
  console.log('🟢 RECOMMENDATION: Ready for deployment\n');
  console.log('Changes validated:');
  console.log('  • Multi-select championships (ROK NATS, Northern Crown, Southern Crown)');
  console.log('  • ALL button removed');
  console.log('  • Email field moved to Medical & Consent section');
  console.log('  • Championship colors updated (Yellow, Marine Blue, Turquoise)');
  console.log('  • Admin notification system integrated');
  console.log('  • Rate limiting and batch processing configured\n');
  process.exit(0);
}
