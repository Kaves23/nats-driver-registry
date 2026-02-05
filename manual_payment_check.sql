-- Script to manually check for Moore and Van Der Molen payments
-- Run this in your database console (pgAdmin, psql, or Render database shell)

-- 1. Find drivers named Moore
SELECT driver_id, first_name, last_name, email 
FROM drivers 
WHERE LOWER(last_name) LIKE '%moore%';

-- 2. Find drivers named Van Der Molen
SELECT driver_id, first_name, last_name, email 
FROM drivers 
WHERE LOWER(last_name) LIKE '%molen%' OR LOWER(last_name) LIKE '%van%der%';

-- 3. Check race entries for these drivers (replace DRIVER_ID_HERE with actual IDs from above)
SELECT entry_id, driver_id, payment_reference, payment_status, entry_status, 
       amount_paid, race_class, created_at
FROM race_entries 
WHERE driver_id IN (/* PUT DRIVER IDs HERE FROM STEP 1 & 2 */)
ORDER BY created_at DESC;

-- 4. Check recent pending entries (last 30 days)
SELECT entry_id, driver_id, payment_reference, payment_status, entry_status, 
       amount_paid, race_class, created_at
FROM race_entries 
WHERE (payment_status = 'Pending' OR entry_status = 'pending_payment')
  AND created_at > NOW() - INTERVAL '30 days'
ORDER BY created_at DESC;

-- 5. Check recent payments in payments table
SELECT payment_id, pf_payment_id, payment_status, item_name, 
       amount_gross, name_first, name_last, email_address, created_at
FROM payments 
WHERE (LOWER(name_last) LIKE '%moore%' OR LOWER(name_last) LIKE '%molen%')
  AND created_at > NOW() - INTERVAL '30 days'
ORDER BY created_at DESC;

-- 6. Check ALL recent completed payments (to see if they made it to payments table)
SELECT payment_id, pf_payment_id, payment_status, item_name, 
       amount_gross, name_first, name_last, email_address, created_at
FROM payments 
WHERE payment_status = 'COMPLETE'
  AND created_at > NOW() - INTERVAL '7 days'
ORDER BY created_at DESC;
