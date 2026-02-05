# PayFast Webhook Debugging Checklist

## Issue
Moore and Van Der Molen payments were received by PayFast but race entries not updated from Pending to Completed.

## Immediate Actions Required

### 1. Check PayFast Dashboard
Login to PayFast merchant dashboard (https://www.payfast.co.za/merchant/dashboard)

**What to check:**
- [ ] Go to Settings → Integration → Instant Transaction Notifications (ITN)
- [ ] Verify Notify URL is set to: `https://www.rokthenats.co.za/api/paymentNotify`
- [ ] Check "View ITN History" to see recent webhook delivery attempts
- [ ] Look for Moore and Van Der Molen transactions - check webhook status:
  - ✅ Success (200 response)
  - ⚠️ Retry (server timeout or error)
  - ❌ Failed (server returned error)

### 2. Check Render Server Logs
Go to Render dashboard → Your service → Logs tab

**Search for:**
```
PAYFAST WEBHOOK RECEIVED
Moore
Molen
payment_reference
Error
500
404
```

**What to look for:**
- Are webhooks arriving at all? (Should see "🔔 PAYFAST WEBHOOK RECEIVED")
- Any errors during processing?
- Payment references being logged?
- Database query results?

### 3. Check Database Directly
Run these queries in Render database shell or pgAdmin:

```sql
-- Find pending entries
SELECT entry_id, driver_id, payment_reference, payment_status, 
       entry_status, amount_paid, created_at
FROM race_entries 
WHERE payment_status = 'Pending' 
ORDER BY created_at DESC 
LIMIT 20;

-- Find recent payments in payments table
SELECT payment_id, pf_payment_id, payment_status, 
       name_first, name_last, amount_gross, created_at
FROM payments 
ORDER BY created_at DESC 
LIMIT 20;
```

### 4. Verify Payment Reference Format
When users initiated payment, a PENDING entry should have been created with format:
`RACE-{eventId}-{driverId}-{timestamp}`

Check if:
- [ ] Pending entries exist with this reference format
- [ ] PayFast is sending back the SAME reference in webhook
- [ ] Reference is being parsed correctly (eventId and driverId extracted)

## Common Issues & Solutions

### Issue: Webhook Not Reaching Server
**Symptoms:**
- No logs showing "PAYFAST WEBHOOK RECEIVED"
- PayFast ITN History shows failed deliveries

**Solutions:**
- Check Render service is running (not crashed)
- Verify URL in PayFast dashboard is correct
- Check firewall/security settings

### Issue: Webhook Failing During Processing
**Symptoms:**
- Logs show webhook received but error occurs
- PayFast receives 500 error response

**Solutions:**
- Check error logs for stack trace
- Verify database connection is working
- Check MD5 signature verification

### Issue: Payment Reference Mismatch
**Symptoms:**
- Webhook succeeds but no entry updated
- Logs show "No pending entry found, creating new entry"

**Solutions:**
- Compare payment_reference in pending entry vs webhook data
- Check for case sensitivity issues
- Verify reference format hasn't changed

### Issue: Database Query Not Finding Entry
**Symptoms:**
- Pending entry EXISTS in database
- Webhook logs show 0 entries found

**Solutions:**
- Check exact payment_reference value in both places
- Look for extra spaces or characters
- Verify database column type (text vs varchar)

## Enhanced Logging Added

The following comprehensive logging has been added to `/api/paymentNotify`:

1. **Entry Point** - Full webhook body, timestamp, key fields
2. **Database Lookup** - Query executed, results count, entry details if found
3. **Update/Insert** - Which operation ran, rows affected
4. **Success** - Final confirmation with all ticket references

**Next webhook will show complete diagnostic trail.**

## Manual Recovery Process

Once issue identified, manually update affected entries:

```sql
-- Find the pending entry
SELECT * FROM race_entries 
WHERE payment_reference = 'RACE-XXX-XXX-XXX';

-- Update to completed
UPDATE race_entries 
SET payment_status = 'Completed',
    entry_status = 'confirmed'
WHERE payment_reference = 'RACE-XXX-XXX-XXX';
```

## Next Steps

1. [ ] Check PayFast ITN History for these specific payments
2. [ ] Check Render logs for webhook activity around payment time
3. [ ] Query database for pending entries
4. [ ] Deploy enhanced logging and monitor next payment
5. [ ] If webhooks are failing, check PayFast passphrase and signature verification
