# PayFast Integration Status - NATS Driver Registry

**Date:** January 5, 2026  
**Status:** Ready for Payment Button Integration

---

## Current PayFast Configuration

### Merchant Account
- **Merchant ID:** 18906399
- **Account Status:** Live (NOT sandbox)
- **Integration Method:** Form-based payment forms

### Payment URLs (Configured)
```
Success URL: https://rokthenats.co.za/payment-success.html
Cancel URL: https://rokthenats.co.za/payment-cancel.html
Notify URL: https://rokthenats.co.za/api/payfast-itn
```

### API Endpoints Ready
✅ POST /api/storePayment - Record payment in database
✅ POST /api/getPaymentHistory - Retrieve payment history
✅ POST /api/payfast-itn - Handle PayFast webhook notifications

---

## Payment Options by Class

### 1. MINI ROK U/10 Class
**Status:** ✅ Awaiting PayFast payment button code

Payment Options (4 buttons needed):
```
1. Per Race Day       R 3,500
2. Weekend Rental     R 5,800
3. Full Season        R 23,200
4. ALL IN OPTION      R 75,640
```

Return URL: https://rokthenats.co.za/payment-success.html
Cancel URL: https://rokthenats.co.za/payment-cancel.html
Notify URL: https://rokthenats.co.za/api/payfast-itn

---

### 2. MINI ROK Class
**Status:** ✅ Awaiting PayFast payment button code

Payment Options (4 buttons needed):
```
1. Per Race Day       R 3,500
2. Weekend Rental     R 5,800
3. Full Season        R 23,200
4. ALL IN OPTION      R 75,640
```

Return URL: https://rokthenats.co.za/payment-success.html
Cancel URL: https://rokthenats.co.za/payment-cancel.html
Notify URL: https://rokthenats.co.za/api/payfast-itn

---

### 3. OK-J Class
**Status:** ✅ Awaiting PayFast payment button code

Payment Options (4 buttons needed):
```
1. Per Race Day       R 6,500
2. Weekend Rental     R 13,000
3. Full Season        R 44,000
4. ALL IN OPTION      R 107,760
```

Return URL: https://rokthenats.co.za/payment-success.html
Cancel URL: https://rokthenats.co.za/payment-cancel.html
Notify URL: https://rokthenats.co.za/api/payfast-itn

---

### 4. OK-N Class
**Status:** ✅ Awaiting PayFast payment button code

Payment Options (4 buttons needed):
```
1. Per Race Day       R 6,500
2. Weekend Rental     R 13,000
3. Full Season        R 44,000
4. ALL IN OPTION      R 107,760
```

Return URL: https://rokthenats.co.za/payment-success.html
Cancel URL: https://rokthenats.co.za/payment-cancel.html
Notify URL: https://rokthenats.co.za/api/payfast-itn

---

### 5. CADET Class
**Status:** ✅ Complete - Shows "No engine rental available"

No payment buttons needed. Message displays:
```
"Engine rental not available for CADET class"
```

---

### 6. KZ2 Class
**Status:** ⏳ Pending - Payment options not yet defined

---

## Total Payment Buttons Required
- Mini ROK U/10: 4 buttons
- Mini ROK: 4 buttons
- OK-J: 4 buttons
- OK-N: 4 buttons
- **TOTAL: 12 buttons**

---

## How to Integrate PayFast Button Codes

### Step 1: Get Button Code from PayFast

In your PayFast merchant account:
1. Go to "Tools" → "Create a button"
2. Create a button for each payment option
3. Copy the HTML form code

### Step 2: Locate Payment Section in driver_portal.html

Find the section for each class (search for "Mini ROK" or "OK-J" in the file)

### Step 3: Replace Placeholder with PayFast Form

Current placeholder structure in driver_portal.html:
```html
<!-- Mini ROK Per Race Day Payment Form -->
<form method="post" action="https://payment.payfast.io/eng/process">
  <!-- PayFast form code will go here -->
  <button type="submit">Pay R3,500</button>
</form>
```

Replace with PayFast-generated button code (keep same action URL)

### Step 4: Test Each Button
- Verify form loads
- Test payment flow
- Verify return to success page
- Check payment recorded in database

---

## PayFast Form Requirements

Each button should:
1. **POST** to: `https://payment.payfast.io/eng/process`
2. Include **Merchant ID:** 18906399
3. Include **Amount:** (R3,500, R5,800, etc.)
4. Include **Return URL:** https://rokthenats.co.za/payment-success.html
5. Include **Cancel URL:** https://rokthenats.co.za/payment-cancel.html
6. Include **Notify URL:** https://rokthenats.co.za/api/payfast-itn
7. Be **signed** according to PayFast specifications

---

## Payment Flow

```
User selects class → Clicks payment button → 
PayFast payment page → User pays → 
PayFast processes → Webhook notification → 
/api/payfast-itn endpoint → Payment recorded in DB → 
Redirect to success page → User sees confirmation
```

---

## Testing Payment Flow (After Integration)

### Local Testing
```
URL: http://localhost:3000/driver_portal.html#portal
Database: Test database (not production)
```

### Production Testing
```
URL: https://rokthenats.co.za/driver_portal.html#portal
Database: Production PlanetScale
PayFast: Live merchant account
```

---

## Database Schema for Payments

Table: `payments`
```sql
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  driver_id UUID NOT NULL REFERENCES drivers(driver_id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  status VARCHAR(50) DEFAULT 'Pending',
  reference VARCHAR(100) UNIQUE,
  payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## Status Indicators Integration

### Engine Rental Status
Updated when payment completed:
- ❌ None (default)
- ✅ Paid (when payment status = COMPLETED)

### Payment History Display
Shows all completed/pending payments in portal:
- Transaction ID
- Amount
- Status
- Date

---

## Post-Payment Email Notifications

### Triggered by API
When payment status = COMPLETED:
1. Email sent to driver confirmation
2. Email sent to admin notification
3. Payment recorded in database
4. Status indicators updated

**Email Provider:** Mailchimp Transactional API
**From:** john@ftwmotorsport.com
**Template:** Professional with NATS branding

---

## Next Action

**Awaiting:** 12 PayFast payment button form codes from user

Once received:
1. Paste each button code into driver_portal.html
2. Test each button locally
3. Verify payment flow end-to-end
4. Deploy to production
5. Go live

---

## Checklist for Payment Integration

- [ ] Receive 12 PayFast button codes
- [ ] Integrate button code for Mini ROK U/10 (4)
- [ ] Integrate button code for Mini ROK (4)
- [ ] Integrate button code for OK-J (4)
- [ ] Integrate button code for OK-N (4)
- [ ] Test button 1 locally
- [ ] Test button 2 locally
- [ ] Test button 3 locally
- [ ] Test complete payment flow
- [ ] Verify database recording
- [ ] Verify email notifications
- [ ] Test on production domain
- [ ] Verify PayFast webhook
- [ ] Go live

---

**Payment Integration Status: READY FOR BUTTON CODES**

All backend, frontend, and configuration is complete and ready to accept the 12 PayFast payment button form codes.

