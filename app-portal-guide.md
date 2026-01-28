# ROK NATS Mobile App - Driver Portal Implementation Guide

## Overview
This guide provides everything needed to replicate the driver portal experience in a mobile app.

## Architecture Options

### Option A: WebView Wrapper (Recommended)
- Load portal HTML directly in WebView
- Inject authentication credentials
- Zero maintenance - updates to website automatically appear in app

### Option B: Native Implementation
- Replicate UI using native components
- Connect to same API endpoints
- More control but requires ongoing maintenance

---

## Design System

### Colors
```
Backgrounds:
- Primary: #000000 (pure black)
- Panel: #0a0a0a (dark gray)
- Card: #0f0f0f (slightly lighter)

Text:
- Primary: #ffffff (white)
- Secondary: #9ca3af (light gray)
- Muted: #6b7280 (gray)

Borders:
- Soft: rgba(255,255,255,0.08)
- Strong: rgba(255,255,255,0.15)

Seasonal Accents:
- Summer: #facc15 (yellow)
- Autumn: #f97316 (orange)
- Winter: #0ea5e9 (cyan)
- Spring: #4ade80 (green)

Status Colors:
- Success: #22c55e (green)
- Warning: #f59e0b (amber)
- Error: #ef4444 (red)
```

### Typography
```
Font: system-ui, -apple-system, sans-serif

Sizes:
- Heading: 20px
- Body: 14px
- Label: 12px  
- Small: 11px

Weights:
- Regular: 400
- Medium: 600
- Bold: 700

Letter Spacing:
- Tight: -0.02em
- Normal: 0.05em
- Wide: 0.12em (uppercase headers)
```

### Spacing
```
- Border radius: 8px
- Panel padding: 20px
- Card padding: 16px
- Gap between elements: 12-20px
```

---

## Component Specifications

### 1. Tab Bar
- **Height**: 64px
- **Inactive tab**: color #6b7280
- **Active tab**: color #ffffff with 3px colored bottom border (seasonal)
- **Transition**: 0.3s ease-out
- **Layout**: Scrollable horizontal on mobile

### 2. Status Card (Session Info)
```
Background: #000000
Border: 1px solid rgba(255,255,255,0.08)
Padding: 16px
Layout: Flex column

Status Chip:
- Size: 10px text, uppercase, 0.16em letter-spacing
- Padding: 8px 10px
- Border: 1px with seasonal color
- Pulsing glow animation (2s infinite)
- Colors: Green (logged in), Cyan (loading), Red (error)

Info Fields:
- Label: 10px, #6b7280, uppercase
- Value: 12px, #ffffff, 600 weight
```

### 3. Panel Component
```
Background: #0a0a0a
Border: 1px solid rgba(255,255,255,0.08)
Border-radius: 8px
Padding: 20px
Shadow: 0 1px 3px rgba(0,0,0,0.1)

Panel Title:
- Font: 14px, 700 weight
- Letter-spacing: 0.08em
- Uppercase
- Color: #ffffff
- Accent bar: 3px colored left border (seasonal)
```

### 4. Input Fields
```
Background: rgba(255,255,255,0.05)
Border: 1px solid rgba(255,255,255,0.12)
Border-radius: 8px
Padding: 10px
Color: #ffffff
Font-size: 13px

Focus State:
- Border: rgba(255,255,255,0.25)
- Background: rgba(255,255,255,0.08)
```

### 5. Buttons
```
Primary Button:
- Background: #3b82f6
- Color: #ffffff
- Padding: 12px 24px
- Border-radius: 8px
- Font: 13px, 600 weight
- Hover: lift 2px, shadow increase

Secondary Button:
- Background: transparent
- Border: 1px solid rgba(255,255,255,0.15)
- Color: #ffffff
```

---

## Portal Sections

### Section 1: Driver Profile
**Data Fields:**
- Email (readonly)
- First Name
- Last Name
- Class (dropdown)
- Race Number
- License Number
- Transponder Number
- Kart Brand
- Team Name
- Coach Name

**Status Indicators:**
- Season Entry Status (green/red chip)
- Next Race Entry (green/red chip)
- Engine Rental Status (green/red chip)

### Section 2: Entrant Details
**Table with columns:**
- Name
- Email
- Phone
- Relationship

### Section 3: Medical & Consent
**Fields:**
- Allergies (textarea)
- Medical Conditions (textarea)
- Medication (textarea)
- Consent Signed (Yes/No dropdown)
- Consent Date (date picker)

### Section 4: My Events
**Table with columns:**
- Event Name
- Date
- Location
- Status (colored chip: Confirmed/Pending/Cancelled)
- Payment (colored icon + text)
- Class
- Race Number

**Styling:**
- Black background (#000000)
- White text headers
- Colored left border per row (status glow color)
- Past events: grayed out

### Section 5: Points
**Table with columns:**
- Race
- Date
- Position
- Points
- Total Points

**Summary Banner:**
- Current standings
- Class display with colored border
- Championship name

### Section 6: Entries & Rentals
**"ENTER A RACE" Button:**
- Container: Black background, white border (2px)
- Button: Blue (#3b82f6) with glow
- Full width, 16px padding

**Next Race Info:**
- Title, location, status
- Entry breakdown (entry fee, rentals, totals)
- Register button

### Section 7: MSA License
**Display:**
- License status
- Upload functionality

### Section 8: Notifications
**Notification Cards:**
- Dark background (#0f0f0f)
- Border with glow
- Timestamp (muted text)
- Message content
- Read/unread indicator

### Section 9: Contact Admin
**Form:**
- Subject (input)
- Message (textarea)
- Submit button

---

## API Integration

### Base URL
```
https://rokthenats.co.za/api
```

### Authentication
```javascript
POST /api/loginWithPassword
Request: {
  email: string,
  password: string
}
Response: {
  success: boolean,
  data: {
    driver: { driver_id, first_name, last_name, class, ... },
    contacts: [...],
    medical: { allergies, medical_conditions, ... },
    points: [...]
  }
}
```

### Get Driver Data
```javascript
GET /api/driver-profile/:driverId
GET /api/driver-events/:driverId
GET /api/driver-points/:driverId
GET /api/notification-history/:driverId
```

### Update Data
```javascript
PUT /api/driver-profile
Body: { driver_id, first_name, last_name, ... }

PUT /api/medical-consent
Body: { driver_id, allergies, medical_conditions, ... }

POST /api/contact-request
Body: { driver_id, subject, message }
```

---

## Seasonal Theming Logic

```javascript
// Determine season based on current month
function getCurrentSeason() {
  const month = new Date().getMonth() + 1; // 1-12
  
  if (month >= 12 || month <= 2) return 'summer';  // Dec-Feb
  if (month >= 3 && month <= 5) return 'autumn';   // Mar-May
  if (month >= 6 && month <= 8) return 'winter';   // Jun-Aug
  if (month >= 9 && month <= 11) return 'spring';  // Sep-Nov
}

// Get accent color
const seasonColors = {
  summer: '#facc15',
  autumn: '#f97316',
  winter: '#0ea5e9',
  spring: '#4ade80'
};
```

---

## Animations

### Tab Slide In
```css
@keyframes tabSlideIn {
  from { transform: scaleX(0); }
  to { transform: scaleX(1); }
}
/* Duration: 0.3s ease-out */
```

### Status Pulse
```css
@keyframes statusPulse {
  0%, 100% { box-shadow: 0 0 24px rgba(14,165,233,0.40); }
  50% { box-shadow: 0 0 32px rgba(14,165,233,0.70); }
}
/* Duration: 2s infinite */
```

### Button Hover
```css
/* Lift 2-3px, increase shadow */
transform: translateY(-2px);
box-shadow: 0 8px 20px rgba(15,23,42,0.15);
```

---

## Mobile Specific Considerations

### Responsive Breakpoints
- Mobile: < 768px
- Tablet: 768px - 980px
- Desktop: > 980px

### Mobile Optimizations
1. **Status Card**: Stack vertically, reduce font sizes
2. **Tables**: Horizontal scroll or card layout
3. **Tabs**: Scrollable horizontal layout
4. **Forms**: Full width inputs, larger touch targets
5. **Buttons**: Minimum 44px height for touch

### Touch Interactions
- No hover states (use :active instead)
- Larger tap targets (minimum 44x44px)
- Swipe gestures for tab navigation
- Pull-to-refresh for data updates

---

## Authentication Flow

### App Launch
1. Check for stored credentials (localStorage/secure storage)
2. If exists, auto-login
3. If successful, show portal with loading skeletons
4. Populate data as API calls return

### Manual Login
1. Show login form
2. Call /api/loginWithPassword
3. Store credentials securely
4. Transition to portal (smooth animation)
5. Load all sections

### Logout
1. Clear stored credentials
2. Return to login screen
3. Clear all cached data

---

## Data Caching Strategy

### Cache Durations
- Driver Profile: 1 hour
- Events: 30 minutes
- Points: 1 hour
- Notifications: Real-time (don't cache)

### Offline Mode
- Show cached data with indicator
- Queue updates for when online
- Sync when connection restored

---

## Testing Checklist

- [ ] Login/logout flow
- [ ] Auto-login on app restart
- [ ] All 9 portal sections load correctly
- [ ] Forms submit and save
- [ ] Tables scroll horizontally on mobile
- [ ] Status indicators animate properly
- [ ] Seasonal colors apply correctly
- [ ] Dark theme consistent throughout
- [ ] Touch targets are 44px minimum
- [ ] Pull-to-refresh works
- [ ] Offline mode shows cached data
- [ ] Error states display properly

---

## Files Included
1. driver_portal.html (full reference)
2. CSS extraction (all styles needed)
3. JavaScript functions (all portal logic)
4. API documentation (endpoints and payloads)

## Support
For questions about implementation, refer to the source HTML file or contact the web development team.
