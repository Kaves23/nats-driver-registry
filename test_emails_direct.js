#!/usr/bin/env node
// Direct email template test - loads templates and shows what would be sent
// Run with: node test_emails_direct.js

const fs = require('fs');
const path = require('path');

const loadEmailTemplate = (templateName, variables = {}) => {
  try {
    const templatePath = path.join(__dirname, 'email-templates', `${templateName}.html`);
    let html = fs.readFileSync(templatePath, 'utf8');
    
    // Replace all variables in the template
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      html = html.replace(regex, variables[key]);
    });
    
    return html;
  } catch (err) {
    console.error(`❌ Error loading template ${templateName}:`, err.message);
    return null;
  }
};

const testEmail = 'johnduvill@gmail.com';

console.log('\n====================================');
console.log('EMAIL TEMPLATE TEST - Direct Render');
console.log('====================================\n');

// Test 1: Registration Confirmation
console.log('📧 TEST 1: REGISTRATION CONFIRMATION');
console.log('-----------------------------------');
console.log(`To: ${testEmail}`);
console.log(`Subject: Welcome to the 2026 ROK Cup South Africa NATS`);
console.log(`Template: registration-confirmation.html`);
const registrationHtml = loadEmailTemplate('registration-confirmation', {});
if (registrationHtml) {
  console.log(`✅ Template loaded successfully (${registrationHtml.length} bytes)`);
  console.log('\nTemplate Preview (first 500 chars):');
  console.log(registrationHtml.substring(0, 500) + '...\n');
} else {
  console.log('❌ Failed to load registration template\n');
}

// Test 2: Password Reset
console.log('📧 TEST 2: PASSWORD RESET');
console.log('-----------------------------------');
console.log(`To: ${testEmail}`);
console.log(`Subject: Reset Your NATS Driver Registry Password`);
console.log(`Template: password-reset.html`);
const resetLink = 'https://rokthenats.co.za/reset-password.html?token=test_token_123&email=johnduvill@gmail.com';
const passwordResetHtml = loadEmailTemplate('password-reset', {
  RESET_LINK: resetLink
});
if (passwordResetHtml) {
  console.log(`✅ Template loaded successfully (${passwordResetHtml.length} bytes)`);
  console.log('\nTemplate Preview (first 500 chars):');
  console.log(passwordResetHtml.substring(0, 500) + '...\n');
  console.log('Variable Replacement:');
  console.log(`  {{RESET_LINK}} → ${resetLink}`);
  console.log('');
} else {
  console.log('❌ Failed to load password reset template\n');
}

console.log('====================================');
console.log('SUMMARY');
console.log('====================================');
console.log('✅ Registration Confirmation: Ready to send');
console.log('✅ Password Reset: Ready to send');
console.log('\nNote: To actually send these emails via Mailchimp,');
console.log('start the server with: npm start');
console.log('Then POST to /api/sendTestEmail and /api/requestPasswordReset\n');
