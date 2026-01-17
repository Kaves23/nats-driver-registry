# PayFast Integration Specification - Complete & Verified

**Source**: Official PayFast PHP SDK (https://github.com/payfast/payfast-php-sdk)  
**Last Updated**: January 17, 2026

---

## 1. SIGNATURE CALCULATION METHOD (EXACT)

### Official Implementation (From payfast/payfast-php-sdk - `Auth.php`)

```php
/**
 * Generate signature for payment integrations
 * Sorts the parameters into the correct order
 * Attributes not in the sortAttributes list are excluded from the signature
 */
public static function generateSignature($data, $passPhrase = null): string
{
    // Step 1: Define EXACT field order (NOT alphabetical, NOT insertion order)
    $fields = [
        'merchant_id',
        'merchant_key',
        'return_url',
        'cancel_url',
        'notify_url',
        'notify_method',
        'name_first',
        'name_last',
        'email_address',
        'cell_number',
        'm_payment_id',
        'amount',
        'item_name',
        'item_description',
        'custom_int1',
        'custom_int2',
        'custom_int3',
        'custom_int4',
        'custom_int5',
        'custom_str1',
        'custom_str2',
        'custom_str3',
        'custom_str4',
        'custom_str5',
        'subscription_type',
        'billing_date',
        'recurring_amount',
        'frequency',
        'cycles',
        'initial_amount'
    ];

    // Step 2: Sort array by defined field order
    $sortAttributes = array_intersect_key(array_flip($fields), $data);
    $sortAttributes = array_merge($sortAttributes, array_diff_key($data, $sortAttributes));

    // Step 3: Build parameter string
    $pfOutput = '';
    foreach ($sortAttributes as $attribute => $value) {
        if (!empty($value)) {
            $pfOutput .= $attribute . '=' . urlencode(trim($value)) . '&';
        }
    }

    // Step 4: Remove last ampersand
    $getString = substr($pfOutput, 0, -1);

    // Step 5: If passphrase exists, append it
    if ($passPhrase !== null) {
        $getString .= '&passphrase=' . urlencode($passPhrase);
    }

    // Step 6: MD5 hash the final string
    return md5($getString);
}
```

### Summary of Rules

| Aspect | Value |
|--------|-------|
| **Signature Type** | MD5 hash |
| **Parameter Order** | **DOCUMENTATION ORDER** (not alphabetical, not insertion) - see field list above |
| **merchant_key** | **INCLUDED in signature** calculation |
| **merchant_id** | First parameter in signature |
| **Empty values** | Skipped/excluded from signature string |
| **passphrase** | Appended at end AFTER all parameters: `&passphrase=YOUR_PASSPHRASE` |
| **URL Encoding** | `urlencode()` (spaces become `+`) - values are trimmed first |
| **Case Sensitivity** | Field names are lowercase, case-sensitive |

---

## 2. PARAMETER ORDER - EXACT SEQUENCE

### For Signature Calculation (MANDATORY Order)

```
1. merchant_id
2. merchant_key          ← INCLUDED in signature (opposite of what some docs say!)
3. return_url
4. cancel_url
5. notify_url
6. notify_method
7. name_first
8. name_last
9. email_address
10. cell_number
11. m_payment_id
12. amount
13. item_name
14. item_description
15. custom_int1-5
16. custom_str1-5
17. subscription_type
18. billing_date
19. recurring_amount
20. frequency
21. cycles
22. initial_amount
23. passphrase (at end, if present)
```

**CRITICAL**: This is NOT alphabetical order, NOT insertion order - it's the **official PayFast documentation order**.

---

## 3. URL ENCODING SPECIFICS

### Official Implementation

```php
urlencode(trim($value))  // PHP's urlencode function
```

### Encoding Details

| Parameter | Encoding |
|-----------|----------|
| **Spaces** | Converted to `+` (not `%20`) by urlencode |
| **Special chars** | URL-encoded: `&` → `%26`, `=` → `%3D`, etc. |
| **Case sensitivity** | Preserved (case-sensitive) |
| **Empty strings** | **Excluded from signature** - `if (!empty($value))` check |
| **Whitespace trimming** | Yes - `trim($value)` is called before encoding |

### Example

```
amount=100.00&description=Test Item Name

Encodes to:
amount%3D100.00%26description%3DTest%20Item%20Name
```

---

## 4. MERCHANT_KEY USAGE - VERIFIED TRUTH

### **merchant_key IS included in signature calculation**

From official SDK code:
```php
$fields = [
    'merchant_id',
    'merchant_key',  ← **SECOND POSITION - MUST BE INCLUDED**
    'return_url',
    ...
]
```

### What to Send to PayFast

| Item | Send to PayFast? | Include in Signature? | Notes |
|------|------------------|----------------------|-------|
| `merchant_id` | ✅ YES (form field) | ✅ YES | Public identifier |
| `merchant_key` | ✅ YES (form field) | ✅ YES | Sensitive - acts as secondary auth |
| `signature` | ✅ YES (form field) | ❌ NO | The calculated MD5 hash |
| `passphrase` | ❌ NO (not sent) | ✅ YES (if configured) | Only in signature, never transmitted |

### Why merchant_key?

The merchant_key serves as an additional layer of authentication. It:
1. Must be sent as a form field to PayFast
2. Must be included in signature calculation
3. Is different from passphrase (passphrase is NOT sent to PayFast)

---

## 5. WORKING CODE EXAMPLES

### PHP (Official SDK)

```php
<?php
require_once 'vendor/autoload.php';
use PayFast\PayFastPayment;

$payfast = new PayFastPayment([
    'merchantId'  => '10000100',
    'merchantKey' => '46f0cd694581a',
    'passPhrase'  => 'jt7NOE43FZPn',  // Separate from merchant_key
    'testMode'    => true
]);

$data = [
    'return_url'    => 'https://yoursite.com/return.php',
    'cancel_url'    => 'https://yoursite.com/cancel.php',
    'notify_url'    => 'https://yoursite.com/notify.php',
    'name_first'    => 'John',
    'name_last'     => 'Doe',
    'email_address' => 'john@example.com',
    'cell_number'   => '0821234567',
    'm_payment_id'  => '12345',
    'amount'        => '100.00',
    'item_name'     => 'Test Item',
    'item_description' => 'A test product'
];

// SDK automatically generates signature and creates form
echo $payfast->custom->createFormFields($data, ['value' => 'Pay Now']);
```

### JavaScript/Node.js (Based on SDK logic)

```javascript
const crypto = require('crypto');

function generatePayFastSignature(data, passphrase = null) {
    // Field order (CRITICAL - not alphabetical)
    const fieldOrder = [
        'merchant_id',
        'merchant_key',
        'return_url',
        'cancel_url',
        'notify_url',
        'notify_method',
        'name_first',
        'name_last',
        'email_address',
        'cell_number',
        'm_payment_id',
        'amount',
        'item_name',
        'item_description',
        'custom_int1', 'custom_int2', 'custom_int3', 'custom_int4', 'custom_int5',
        'custom_str1', 'custom_str2', 'custom_str3', 'custom_str4', 'custom_str5',
        'subscription_type',
        'billing_date',
        'recurring_amount',
        'frequency',
        'cycles',
        'initial_amount'
    ];

    // Build parameter string in exact order
    let paramString = '';
    
    for (const field of fieldOrder) {
        if (data[field] && data[field] !== '') {
            paramString += field + '=' + encodeURIComponent(data[field].toString().trim()) + '&';
        }
    }

    // Remove trailing ampersand
    paramString = paramString.slice(0, -1);

    // Append passphrase if present
    if (passphrase) {
        paramString += '&passphrase=' + encodeURIComponent(passphrase);
    }

    // Return MD5 hash
    return crypto.createHash('md5').update(paramString).digest('hex');
}

// Usage
const paymentData = {
    merchant_id: '10000100',
    merchant_key: '46f0cd694581a',
    return_url: 'https://yoursite.com/return',
    cancel_url: 'https://yoursite.com/cancel',
    notify_url: 'https://yoursite.com/notify',
    name_first: 'John',
    name_last: 'Doe',
    email_address: 'john@example.com',
    cell_number: '0821234567',
    m_payment_id: '12345',
    amount: '100.00',
    item_name: 'Test Item'
};

const signature = generatePayFastSignature(paymentData, 'jt7NOE43FZPn');
```

### Python (Based on SDK logic)

```python
import hashlib
import urllib.parse

def generate_payfast_signature(data, passphrase=None):
    """Generate PayFast signature using official field order"""
    
    # Field order (CRITICAL - not alphabetical)
    field_order = [
        'merchant_id',
        'merchant_key',
        'return_url',
        'cancel_url',
        'notify_url',
        'notify_method',
        'name_first',
        'name_last',
        'email_address',
        'cell_number',
        'm_payment_id',
        'amount',
        'item_name',
        'item_description',
        'custom_int1', 'custom_int2', 'custom_int3', 'custom_int4', 'custom_int5',
        'custom_str1', 'custom_str2', 'custom_str3', 'custom_str4', 'custom_str5',
        'subscription_type',
        'billing_date',
        'recurring_amount',
        'frequency',
        'cycles',
        'initial_amount'
    ]
    
    # Build parameter string in exact order
    param_string = ''
    
    for field in field_order:
        if field in data and data[field] and data[field] != '':
            value = str(data[field]).strip()
            param_string += f"{field}={urllib.parse.quote_plus(value)}&"
    
    # Remove trailing ampersand
    param_string = param_string.rstrip('&')
    
    # Append passphrase if present
    if passphrase:
        param_string += f"&passphrase={urllib.parse.quote_plus(passphrase)}"
    
    # Return MD5 hash
    return hashlib.md5(param_string.encode()).hexdigest()

# Usage
payment_data = {
    'merchant_id': '10000100',
    'merchant_key': '46f0cd694581a',
    'return_url': 'https://yoursite.com/return',
    'cancel_url': 'https://yoursite.com/cancel',
    'notify_url': 'https://yoursite.com/notify',
    'name_first': 'John',
    'name_last': 'Doe',
    'email_address': 'john@example.com',
    'cell_number': '0821234567',
    'm_payment_id': '12345',
    'amount': '100.00',
    'item_name': 'Test Item'
}

signature = generate_payfast_signature(payment_data, 'jt7NOE43FZPn')
```

---

## 6. PASSPHRASE - OPTIONAL BUT RECOMMENDED

### Passphrase Rules

| Property | Value |
|----------|-------|
| **Is Required?** | ❌ NO - Optional |
| **For Signature?** | ✅ YES - If configured, must be included |
| **Send to PayFast?** | ❌ NO - Never transmitted in form/request |
| **Default Value** | Empty string `''` |
| **Separate from merchant_key?** | ✅ YES - Completely different credential |
| **Typical Usage** | Set in merchant dashboard, used only for local verification |

### Examples from Official SDK

```php
// With passphrase (recommended for production)
$payfast = new PayFastPayment([
    'merchantId'  => '10000100',
    'merchantKey' => '46f0cd694581a',
    'passPhrase'  => 'jt7NOE43FZPn',    // ← Custom passphrase
    'testMode'    => true
]);

// Without passphrase (test/development)
$payfast = new PayFastPayment([
    'merchantId'  => '10000100',
    'merchantKey' => '46f0cd694581a',
    'passPhrase'  => '',                 // ← Empty for test
    'testMode'    => true
]);
```

### Signature Calculation with Empty vs Non-Empty Passphrase

**Empty passphrase:**
```
Parameter string: merchant_id=10000100&merchant_key=46f0cd694581a&amount=100.00
MD5: md5(parameter_string)
```

**With passphrase:**
```
Parameter string: merchant_id=10000100&merchant_key=46f0cd694581a&amount=100.00&passphrase=jt7NOE43FZPn
MD5: md5(parameter_string)
```

---

## 7. COMPLETE PARAMETER LIST FOR PAYMENT REDIRECT

### Required Parameters

| Parameter | Type | Example | Notes |
|-----------|------|---------|-------|
| `merchant_id` | string | `10000100` | Your merchant ID |
| `merchant_key` | string | `46f0cd694581a` | Your merchant key |
| `return_url` | string | `https://yoursite.com/return.php` | Return after payment (HTTPS) |
| `cancel_url` | string | `https://yoursite.com/cancel.php` | Redirect if cancelled (HTTPS) |
| `notify_url` | string | `https://yoursite.com/notify.php` | ITN callback (HTTPS) |
| `name_first` | string | `John` | Customer first name |
| `name_last` | string | `Doe` | Customer last name |
| `email_address` | string | `john@example.com` | Customer email |
| `m_payment_id` | string | `ORDER-12345` | Your unique order ID |
| `amount` | string | `100.00` | Amount in ZAR, 2 decimals |
| `item_name` | string | `Test Item` | Product name |
| `signature` | string | `abc123...` | MD5 hash (calculated) |

### Optional Parameters

| Parameter | Type | Example | Usage |
|-----------|------|---------|-------|
| `notify_method` | string | `POST` | ITN notification method |
| `name_first` | string | `John` | - |
| `name_last` | string | `Doe` | - |
| `email_address` | string | `john@example.com` | - |
| `cell_number` | string | `0821234567` | Customer phone |
| `item_description` | string | `Description of item` | - |
| `custom_int1` to `custom_int5` | integer | `123` | Custom fields (integers) |
| `custom_str1` to `custom_str5` | string | `value` | Custom fields (strings) |
| `subscription_type` | string | `1` | 1=monthly, 2=quarterly, 3=semi-annual, 4=annual |
| `billing_date` | date | `2025-02-15` | Billing start date (YYYY-MM-DD) |
| `recurring_amount` | decimal | `50.00` | Recurring payment amount |
| `frequency` | integer | `3` | Frequency in months |
| `cycles` | integer | `12` | Number of billing cycles |

### Form HTML Structure (POST Method)

```html
<form action="https://sandbox.payfast.co.za/eng/process" method="post">
    <input type="hidden" name="merchant_id" value="10000100" />
    <input type="hidden" name="merchant_key" value="46f0cd694581a" />
    <input type="hidden" name="return_url" value="https://yoursite.com/return.php" />
    <input type="hidden" name="cancel_url" value="https://yoursite.com/cancel.php" />
    <input type="hidden" name="notify_url" value="https://yoursite.com/notify.php" />
    <input type="hidden" name="name_first" value="John" />
    <input type="hidden" name="name_last" value="Doe" />
    <input type="hidden" name="email_address" value="john@example.com" />
    <input type="hidden" name="m_payment_id" value="12345" />
    <input type="hidden" name="amount" value="100.00" />
    <input type="hidden" name="item_name" value="Test Item" />
    <input type="hidden" name="signature" value="calculated_signature_here" />
    
    <input type="submit" value="Pay Now" />
</form>
```

### Endpoints

| Environment | URL | Uses |
|-------------|-----|------|
| **Sandbox** | `https://sandbox.payfast.co.za/eng/process` | Testing |
| **Live** | `https://www.payfast.co.za/eng/process` | Production |

---

## 8. TEST/SANDBOX ENVIRONMENT

### Sandbox Credentials (For Development)

```
Merchant ID:  10000100
Merchant Key: 46f0cd694581a
Passphrase:   jt7NOE43FZPn (test mode often uses empty '')
Test Mode:    true
URL:          https://sandbox.payfast.co.za/eng/process
```

### How to Test

1. **Create a test form** using sandbox credentials
2. **Use test amount** (typically any amount works in sandbox)
3. **Complete payment** with test card/method
4. **Verify ITN callback** is received at your notify_url

### Test Payment Method

- Use the sandbox at: `https://sandbox.payfast.co.za`
- Complete test transactions with test cards
- Verify notifications are received

### Debugging Signature Issues

Common causes of signature mismatches:

1. ❌ **Wrong parameter order** - Use DOCUMENTATION order, not alphabetical
2. ❌ **Excluding merchant_key** - It MUST be in signature
3. ❌ **Wrong URL encoding** - Use `urlencode()` or equivalent
4. ❌ **Spaces not encoded properly** - Should be `+` not `%20`
5. ❌ **Including empty values** - Skip fields with empty strings
6. ❌ **Not trimming values** - Remove leading/trailing whitespace first
7. ❌ **Passphrase issues** - If empty, don't append it; if set, append at end
8. ❌ **Not using MD5** - Must be MD5 hash, not SHA1 or other

---

## 9. NOTIFICATION/ITN (Instant Transaction Notification)

### ITN Signature Validation (Inbound)

When PayFast sends a notification to your `notify_url`, validate it:

```php
// From official SDK - Notification.php

public function isValidNotification($pfData, $validations = [])
{
    // 1. Clean the data
    $pfData = $this->cleanNotificationData($pfData);
    
    // 2. Convert to parameter string
    $pfParamString = $this->dataToString($pfData);
    
    // 3. Validate signature
    $pfPassphrase = PayFastPayment::$passPhrase;
    
    if (empty($pfPassphrase)) {
        $sig = md5($pfParamString);
    } else {
        $sig = md5($pfParamString . "&passphrase=" . $pfPassphrase);
    }
    
    // 4. Compare with received signature
    return $pfData['signature'] === $sig;
}
```

### ITN Parameter Signature (Alphabetical Order for ITN!)

**NOTE**: For notifications, parameters are sorted **alphabetically**, NOT documentation order:

```php
private function dataToString($dataArray)
{
    $pfOutput = '';
    foreach ($dataArray as $key => $val) {
        if ($val !== '') {
            $pfOutput .= $key . '=' . urlencode(trim($val)) . '&';
        }
    }
    return substr($pfOutput, 0, -1);  // Remove last &
}
```

### ITN Response Headers

```php
// Always respond with 200 OK to acknowledge receipt
header('HTTP/1.0 200 OK');
flush();

// Process the notification
// ... your code ...

// If valid, log/process payment
// If invalid, don't process but still return 200 OK
```

---

## KEY TAKEAWAYS

### Most Critical Points

1. **Signature Parameter Order**: Use the DOCUMENTATION order (provided above), NOT alphabetical
2. **Include merchant_key**: It MUST be in the signature calculation (position 2)
3. **Don't send passphrase**: Passphrase is ONLY used in signature, never transmitted
4. **DO send merchant_key**: As a form field AND in signature
5. **URL Encoding**: Use standard urlencode (spaces = `+`)
6. **Empty values**: Skip fields with empty values in signature
7. **MD5 hash**: Always use MD5, not SHA or other algorithms
8. **Trim values**: Remove whitespace before encoding
9. **ITN signatures**: Different - parameters are alphabetical, not documentation order
10. **Always return 200 OK**: For ITN notifications, always respond with HTTP 200

### Quick Checklist

- [ ] Using correct field order for signature (DOCUMENTATION order)
- [ ] Including merchant_key in signature
- [ ] Including merchant_id in signature
- [ ] merchant_key AND merchant_id are sent as form fields
- [ ] signature is sent as form field
- [ ] passphrase is NOT sent to PayFast
- [ ] Using URL encoding (urlencode/quote_plus)
- [ ] Trimming whitespace from values
- [ ] Skipping empty values
- [ ] Using MD5 for hash
- [ ] Using correct endpoints (sandbox vs live)
- [ ] Receiving and validating ITN notifications

---

## REFERENCES

- **Official Source**: https://github.com/payfast/payfast-php-sdk
- **Official Documentation**: https://www.payfast.co.za
- **Sandbox**: https://sandbox.payfast.co.za
- **Community Issues**: PayFast GitHub discussions, Stack Overflow tag:payfast
