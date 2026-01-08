# Email Template Integration Guide

## Overview
Email templates have been successfully integrated into the NATS project. The system now loads professional HTML email templates from the `email-templates/` directory instead of using inline HTML strings.

## Active Templates

### 1. **registration-confirmation.html**
**Purpose:** Sent to drivers upon successful registration  
**Subject:** Welcome to the 2026 ROK Cup South Africa NATS  
**Content:**
- 2026 NATS calendar (4 seasonal rounds with venues and dates)
- Format benefits explanation
- Regional championship dates (Northern Region and Western Cape)
- 4-step practical next steps checklist
- Links to Event Hub

**Mailchimp Variables:**
- `*|FNAME|*` - Driver first name (personalization)
- `*|ARCHIVE|*` - View in browser link
- `*|UPDATE_PROFILE|*` - Update preferences link
- `*|UNSUB|*` - Unsubscribe link

---

### 2. **password-reset.html**
**Purpose:** Sent when driver or admin requests password reset  
**Subject:** Reset Your NATS Driver Registry Password  
**Content:**
- Personalized greeting with driver name
- Password reset button (1-hour expiry)
- Fallback copy-paste link
- Security notes and best practices
- Troubleshooting help steps
- Professional, helpful tone matching registration email

**Dynamic Variables:**
- `{{RESET_LINK}}` - Generated reset link with token (replaced at send time)

**Mailchimp Variables:**
- `*|FNAME|*` - Driver first name (personalization)

---

## Architecture

### Template Loading Function
```javascript
const loadEmailTemplate = (templateName, variables = {}) => {
  // Loads template from email-templates/{templateName}.html
  // Replaces {{VARIABLE}} placeholders with provided values
  // Returns rendered HTML string
}
```

### Integration Points

#### 1. Registration Confirmation
**Endpoint:** `POST /api/registerDriver`  
**Code:**
```javascript
const emailHtml = loadEmailTemplate('registration-confirmation', {});
// Sends to: driver's email address
```

#### 2. Password Reset Request
**Endpoint:** `POST /api/requestPasswordReset`  
**Code:**
```javascript
const emailHtml = loadEmailTemplate('password-reset', {
  RESET_LINK: resetLink
});
// Sends to: driver's email address
```

#### 3. Admin-Initiated Password Reset
**Endpoint:** `POST /api/sendPasswordResetEmail`  
**Code:**
```javascript
const emailHtml = loadEmailTemplate('password-reset', {
  RESET_LINK: resetLink
});
// Sends to: target driver's email address
```

#### 4. Test Email
**Endpoint:** `POST /api/sendTestEmail`  
**Code:**
```javascript
const emailHtml = loadEmailTemplate('registration-confirmation', {});
// Sends to: specified email address (for testing)
```

---

## File Structure
```
d:\LIVENATSSITE\
├── server.js                          (updated with template loader)
└── email-templates/
    ├── registration-confirmation.html  (active)
    ├── password-reset.html             (active)
    └── archive/                        (old versions)
        ├── registration-confirmation-professional.html
        ├── password-reset-professional.html
        └── test-email.html
```

---

## Mailchimp Integration

### Email Service
- **API:** Mailchimp Transactional (Mandrill)
- **Endpoint:** `https://mandrillapp.com/api/1.0/messages/send.json`
- **From Email:** `process.env.MAILCHIMP_FROM_EMAIL`
- **API Key:** `process.env.MAILCHIMP_API_KEY`

### Merge Variables
The templates use Mailchimp merge variable syntax:
- `*|FNAME|*` - Recipient first name
- `*|ARCHIVE|*` - View in browser URL
- `*|UPDATE_PROFILE|*` - Update preferences URL
- `*|UNSUB|*` - Unsubscribe URL
- `*|LIST:COMPANY|*` - Organization name
- `*|LIST:ADDRESS|*` - Organization address

These are automatically populated by Mailchimp when emails are sent to Mailchimp-managed contacts.

---

## Template Features

### Design Elements
- **Professional HTML** - Table-based, Mailchimp-compatible structure
- **Mobile Responsive** - Optimized for 640px and smaller screens
- **Inline CSS** - No external stylesheets (email client compatibility)
- **Color Scheme** - Black (#111827), Gray (#6b7280), Gold (#facc15), Green (#22c55e)
- **ROK Branding** - Logo included with direct Dropbox URL

### Content Style
- ✅ Professional tone, friendly and helpful
- ✅ No emoticons or decorative elements
- ✅ Comprehensive, practical information
- ✅ Clear calls-to-action
- ✅ Consistent branding throughout

---

## Customization Guide

### Modifying Templates
1. Edit the HTML file directly in `email-templates/`
2. Maintain the `{{VARIABLE}}` placeholders for dynamic content
3. Keep Mailchimp merge variables (`*|...|*`) intact
4. Test by sending a test email via `/api/sendTestEmail`

### Adding New Templates
1. Create new HTML file in `email-templates/` directory
2. Use same structure as existing templates
3. Call `loadEmailTemplate('template-name', { variables })` in server.js
4. Use Mailchimp merge variables and `{{CUSTOM_VAR}}` format

### Updating Variables
To inject new variables into templates:
```javascript
const emailHtml = loadEmailTemplate('template-name', {
  VARIABLE_NAME: 'value',
  ANOTHER_VAR: 'another value'
});
```

---

## Testing

### Test Endpoints
- **Test Email:** `POST /api/sendTestEmail` with email in body
- **Current Implementation:** Uses registration-confirmation.html

### Verify Integration
1. Check server logs for template loading messages
2. Review email received in test inbox
3. Verify all links and variables are populated correctly
4. Check rendering on mobile devices

---

## Troubleshooting

### Template Not Found
**Error:** `Error loading template {name}: ENOENT`  
**Solution:** Verify file exists in `email-templates/` directory and name matches exactly

### Variables Not Replaced
**Issue:** `{{VARIABLE}}` appears in sent email  
**Solution:** Check variable name matches exactly (case-sensitive) and is passed to loadEmailTemplate()

### Email Not Sending
**Issue:** Email fails silently  
**Solution:** 
- Check Mailchimp API key in .env
- Verify `from_email` is authorized in Mailchimp account
- Check server logs for detailed error messages

---

## Migration Notes

### Previous System
- Email HTML was inline in server.js
- Limited ability to modify designs
- Difficult to maintain across multiple email types

### New System
- Templates stored as separate HTML files
- Easy to edit and version control
- Scalable for adding new email types
- Professional design system maintained

---

## Version History
- **v1.0** (Jan 7, 2026) - Initial template integration
  - registration-confirmation.html implemented
  - password-reset.html implemented
  - Template loader function created
  - Mailchimp integration verified
