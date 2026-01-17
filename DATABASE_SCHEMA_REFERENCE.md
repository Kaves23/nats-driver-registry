# NATS Driver Registry - Database Schema Reference

## Quick Summary
- **Total Tables**: 10
- **Total Rows**: 35+ (mostly drivers and payments)
- **Primary Database**: PlanetScale MySQL-compatible PostgreSQL
- **Host**: us-east-3.pg.psdb.cloud:6432

---

## Table: EVENTS
**Purpose**: Race event definitions  
**Primary Key**: event_id (VARCHAR)  
**Row Count**: 2  

| Column Name | Data Type | Nullable | Default | Notes |
|---|---|---|---|---|
| event_id | character varying | NOT NULL | - | Primary Key. Format: event_name_timestamp |
| event_name | character varying | NOT NULL | - | Display name (e.g., "Northern Regions Crown") |
| event_date | date | NOT NULL | - | When the event occurs |
| location | character varying | NULL | - | Event venue |
| registration_deadline | date | NULL | - | When registration closes |
| entry_fee | numeric | NULL | - | Standard entry fee in Rands (R) |
| created_at | timestamp | NULL | CURRENT_TIMESTAMP | When record created |
| updated_at | timestamp | NULL | CURRENT_TIMESTAMP | When record last updated |

---

## Table: RACE_ENTRIES
**Purpose**: Driver entries for specific events (Many-to-Many via Event)  
**Primary Key**: entry_id (VARCHAR)  
**Foreign Keys**: driver_id → drivers.driver_id, event_id → events.event_id  
**Row Count**: 0  

| Column Name | Data Type | Nullable | Default | Notes |
|---|---|---|---|---|
| entry_id | character varying | NOT NULL | - | Primary Key. Format: race_entry_timestamp_random |
| driver_id | character varying | NOT NULL | - | Foreign Key to drivers table |
| event_id | character varying | NULL | - | Foreign Key to events table |
| race_name | character varying | NULL | - | Which race/championship |
| race_class | character varying | NULL | - | Driver's racing class (e.g., MINI ROK, CADET) |
| race_number | character varying | NULL | - | Driver's permanent race number |
| team_name | character varying | NULL | - | Team affiliation |
| class | character varying | NULL | - | Redundant with race_class |
| timestamp | timestamp | NULL | now() | When entry was created |
| status | character varying | NULL | 'Submitted' | Entry approval status |
| payment_status | character varying | NULL | - | 'Completed', 'Pending', etc |
| entry_status | character varying | NULL | 'pending' | 'confirmed', 'cancelled', etc |
| amount_paid | numeric | NULL | 0 | How much driver paid (0 for free entries) |
| payment_reference | character varying | NULL | - | PayFast or manual reference ID |
| entry_items | json | NULL | - | Selected equipment (tyres, engine rental, etc) |
| total_amount | numeric | NULL | - | Total cost (deprecated, use amount_paid) |
| notes | text | NULL | - | Driver notes about entry |
| admin_result | character varying | NULL | - | Admin notes on approval |
| admin_position | character varying | NULL | - | Final race position |
| created_at | timestamp | NULL | CURRENT_TIMESTAMP | Record creation time |
| updated_at | timestamp | NULL | CURRENT_TIMESTAMP | Record update time |

---

## Table: DRIVERS
**Purpose**: Driver profiles and personal information  
**Primary Key**: driver_id (VARCHAR)  
**Row Count**: 19  

| Column Name | Data Type | Nullable | Default | Notes |
|---|---|---|---|---|
| driver_id | character varying | NOT NULL | - | Primary Key. UUID format |
| first_name | character varying | NULL | - | Given name |
| last_name | character varying | NULL | - | Family name |
| preferred_name | character varying | NULL | - | Preferred display name |
| date_of_birth | date | NULL | - | DOB for age verification |
| gender | character varying | NULL | - | 'M', 'F', 'Other' |
| nationality | character varying | NULL | - | Country code |
| championship | character varying | NULL | - | Which championship (2026, etc) |
| class | character varying | NULL | - | Racing class (CADET, MINI ROK, etc) |
| race_number | character varying | NULL | - | Official race number |
| team_name | character varying | NULL | - | Team name |
| coach_name | character varying | NULL | - | Coach/guardian name |
| kart_brand | character varying | NULL | - | Kart manufacturer |
| engine_type | character varying | NULL | - | Engine model |
| tyre_class | character varying | NULL | - | Tyre specification |
| license_number | character varying | NULL | - | Racing license ID |
| license_expiry_date | date | NULL | - | When license expires |
| transponder_number | character varying | NULL | - | Timing transponder ID |
| status | character varying | NULL | 'Pending' | 'Active', 'Pending', 'Suspended', 'Inactive' |
| password_hash | character varying | NULL | - | bcrypt hashed password |
| password_salt | character varying | NULL | - | Password salt (if applicable) |
| reset_token | character varying | NULL | - | Password reset token |
| reset_token_expiry | timestamp | NULL | - | When reset token expires |
| address_line1 | character varying | NULL | - | Street address |
| suburb | character varying | NULL | - | Suburb/locality |
| city | character varying | NULL | - | City |
| province | character varying | NULL | - | State/Province |
| postal_code | character varying | NULL | - | ZIP/Postal code |
| country | character varying | NULL | - | Country |
| id_or_passport_masked | character varying | NULL | - | Last 4 digits of ID/Passport |
| profile_photo_drive_file_id | character varying | NULL | - | Google Drive file ID |
| profile_photo_filename | character varying | NULL | - | Photo filename |
| rookie_flag | character varying | NULL | - | 'Y'/'N' if first-time racer |
| academy_driver | character varying | NULL | - | 'Y'/'N' if academy participant |
| medical_flag | character varying | NULL | - | 'Y'/'N' if special medical needs |
| season_engine_rental | character varying | NULL | 'N' | 'Y'/'N' for engine rental opt-in |
| next_race_entry_status | character varying | NULL | 'Not Registered' | Entry status for next race |
| next_race_engine_rental_status | character varying | NULL | 'No' | Engine rental preference |
| notes_internal | text | NULL | - | Internal admin notes |
| created_at | timestamp | NULL | now() | When profile created |
| updated_at | timestamp | NULL | now() | When profile last updated |
| created_by | character varying | NULL | - | Admin who created record |
| last_verified_at | timestamp | NULL | - | When account was verified |
| verification_method | character varying | NULL | - | How account was verified |
| is_deleted | boolean | NULL | false | Soft delete flag |
| deleted_at | timestamp | NULL | - | When record was deleted |

---

## Table: CONTACTS
**Purpose**: Email addresses and contact info linked to drivers  
**Primary Key**: contact_id (VARCHAR)  
**Foreign Key**: driver_id → drivers.driver_id  
**Row Count**: 19  

| Column Name | Data Type | Nullable | Default | Notes |
|---|---|---|---|---|
| contact_id | character varying | NOT NULL | - | Primary Key |
| driver_id | character varying | NOT NULL | - | Foreign Key to drivers |
| email | character varying | NOT NULL | - | Email address (used for login) |
| contact_type | character varying | NULL | - | 'Primary', 'Secondary', 'Guardian', etc |
| first_name | character varying | NULL | - | Contact's first name |
| last_name | character varying | NULL | - | Contact's last name |
| relationship | character varying | NULL | - | 'Self', 'Parent', 'Guardian', etc |
| phone_number | character varying | NULL | - | Contact phone |
| cell_number | character varying | NULL | - | Mobile phone |
| fax_number | character varying | NULL | - | Fax if applicable |
| address_line1 | character varying | NULL | - | Street address |
| suburb | character varying | NULL | - | Suburb/locality |
| city | character varying | NULL | - | City |
| province | character varying | NULL | - | State/Province |
| postal_code | character varying | NULL | - | ZIP/Postal code |
| country | character varying | NULL | - | Country |
| preferred_contact | character varying | NULL | - | 'Email', 'Phone', 'SMS' |
| medical_contact | boolean | NULL | - | Is this person medical contact? |
| emergency_contact | boolean | NULL | - | Is this emergency contact? |
| billing_contact | character varying | NULL | - | Is this billing contact? |
| created_at | timestamp | NULL | now() | When created |
| updated_at | timestamp | NULL | now() | When updated |

---

## Table: MEDICAL_CONSENT
**Purpose**: Medical information and consent forms  
**Primary Key**: driver_id (VARCHAR)  
**Foreign Key**: driver_id → drivers.driver_id  
**Row Count**: 6  

| Column Name | Data Type | Nullable | Default | Notes |
|---|---|---|---|---|
| driver_id | character varying | NOT NULL | - | Primary Key |
| blood_type | character varying | NULL | - | Blood type (O+, A+, etc) |
| allergies | text | NULL | - | Known allergies and reactions |
| medical_conditions | text | NULL | - | Chronic conditions, disabilities |
| medication | text | NULL | - | Current medications |
| doctor_name | character varying | NULL | - | Primary care physician name |
| doctor_phone | character varying | NULL | - | Doctor's phone number |
| medical_aid_provider | character varying | NULL | - | Medical insurance provider |
| medical_aid_number | character varying | NULL | - | Insurance policy number |
| consent_signed | character varying | NULL | - | 'Y'/'N' medical consent signed |
| consent_date | date | NULL | - | When signed |
| indemnity_signed | character varying | NULL | - | 'Y'/'N' waiver signed |
| indemnity_date | date | NULL | - | When signed |
| media_release_signed | character varying | NULL | - | 'Y'/'N' media rights signed |
| media_release_date | date | NULL | - | When signed |

---

## Table: PAYMENTS
**Purpose**: Payment transaction records (PayFast)  
**Primary Key**: payment_id (VARCHAR)  
**Foreign Key**: driver_id → drivers.driver_id  
**Row Count**: 8  

| Column Name | Data Type | Nullable | Default | Notes |
|---|---|---|---|---|
| payment_id | character varying | NOT NULL | - | Primary Key (internal ID) |
| driver_id | character varying | NOT NULL | - | Foreign Key to drivers |
| merchant_payment_id | character varying | NULL | - | Our custom reference |
| pf_payment_id | character varying | NULL | - | PayFast transaction ID |
| item_name | character varying | NULL | - | What was paid for |
| item_description | text | NULL | - | Detailed item description |
| amount_gross | numeric | NULL | - | Total amount in Rands |
| amount_fee | numeric | NULL | - | PayFast fee |
| amount_net | numeric | NULL | - | Amount we received |
| payment_status | character varying | NULL | 'Pending' | 'Completed', 'Failed', 'Pending' |
| payment_method | character varying | NULL | - | 'PayFast', 'EFT', 'Cash' |
| name_first | character varying | NULL | - | Payer first name |
| email_address | character varying | NULL | - | Payer email |
| created_at | timestamp | NULL | now() | Payment initiated time |
| completed_at | timestamp | NULL | - | When payment confirmed |
| itn_received_at | timestamp | NULL | - | When IPN webhook received |
| custom_str1 | character varying | NULL | - | Custom field 1 |
| custom_str2 | character varying | NULL | - | Custom field 2 |
| custom_str3 | character varying | NULL | - | Custom field 3 |
| raw_response | text | NULL | - | Full PayFast response (for debugging) |

---

## Table: POINTS
**Purpose**: Race results and championship points  
**Primary Key**: points_id (VARCHAR)  
**Foreign Key**: driver_id → drivers.driver_id  
**Row Count**: 0  

| Column Name | Data Type | Nullable | Default | Notes |
|---|---|---|---|---|
| points_id | character varying | NOT NULL | - | Primary Key |
| driver_id | character varying | NOT NULL | - | Foreign Key to drivers |
| season | character varying | NULL | - | Championship year (2026, etc) |
| event | character varying | NULL | - | Event name |
| round | character varying | NULL | - | Round number |
| class | character varying | NULL | - | Racing class |
| qualifying_points | integer | NULL | - | Qualifying session points |
| heat1_points | integer | NULL | - | Heat 1 points |
| heat2_points | integer | NULL | - | Heat 2 points |
| final_points | integer | NULL | - | Final race points |
| penalties_points | integer | NULL | - | Penalty deductions |
| total_points | integer | NULL | - | Total for event |
| position | character varying | NULL | - | Final position ('1st', '2nd', etc) |
| notes | text | NULL | - | Admin notes on race |
| created_at | timestamp | NULL | now() | When entered |
| created_by | character varying | NULL | - | Admin who entered |

---

## Table: PASSWORD_RESETS
**Purpose**: Password reset token tracking  
**Primary Key**: reset_id (VARCHAR)  
**Foreign Key**: driver_id → drivers.driver_id  
**Row Count**: 0  

| Column Name | Data Type | Nullable | Default | Notes |
|---|---|---|---|---|
| reset_id | character varying | NOT NULL | - | Primary Key |
| driver_id | character varying | NOT NULL | - | Foreign Key to drivers |
| token | character varying | NULL | - | Plain text token (for sending) |
| token_hash | character varying | NULL | - | Hashed token (for storage) |
| created_at | timestamp | NULL | now() | When token generated |
| expires_at | timestamp | NULL | - | When token expires (24 hrs) |
| used_at | timestamp | NULL | - | When token was used |
| used_by | character varying | NULL | - | IP or user who used it |

---

## Entity Relationship Diagram (Text)

```
DRIVERS (1) ─────────────────────── (M) RACE_ENTRIES
  ├─ driver_id (PK)                    ├─ entry_id (PK)
  └─ [all personal info]               ├─ driver_id (FK) ──┐
                                       ├─ event_id (FK) ───┼──> EVENTS (1)
DRIVERS (1) ─────────────────────── (1) CONTACTS              └─ event_id (PK)
  ├─ driver_id (PK)                    ├─ contact_id (PK)       └─ [event info]
  └─ [all personal info]               ├─ driver_id (FK) ◄────┘

DRIVERS (1) ─────────────────────── (1) MEDICAL_CONSENT
  ├─ driver_id (PK)                    ├─ driver_id (PK)
  └─ [all personal info]               └─ [medical info]

DRIVERS (1) ─────────────────────── (M) PAYMENTS
  ├─ driver_id (PK)                    ├─ payment_id (PK)
  └─ [all personal info]               ├─ driver_id (FK) ◄─────┘

DRIVERS (1) ─────────────────────── (M) POINTS
  ├─ driver_id (PK)                    ├─ points_id (PK)
  └─ [all personal info]               ├─ driver_id (FK) ◄─────┘

DRIVERS (1) ─────────────────────── (M) PASSWORD_RESETS
  ├─ driver_id (PK)                    ├─ reset_id (PK)
  └─ [all personal info]               ├─ driver_id (FK) ◄─────┘
```

---

## Most Important Column Names (For Developers)

### Driver Identification
- `drivers.driver_id` - Unique driver UUID
- `drivers.email` - Login email (via contacts table)
- `drivers.first_name`, `drivers.last_name` - Display names

### Race Entry
- `race_entries.entry_id` - **PRIMARY KEY** (NOT race_entry_id!)
- `race_entries.driver_id` - Link to driver
- `race_entries.event_id` - Link to event
- `race_entries.race_class` - Driver's class (CADET, MINI ROK, etc)
- `race_entries.entry_items` - JSON list of selected equipment

### Event Management
- `events.event_id` - Unique event identifier
- `events.event_name` - Display name
- `events.event_date` - Race date
- `events.entry_fee` - Standard fee in Rands

### Payments
- `payments.payment_id` - Internal payment ID
- `payments.driver_id` - Which driver paid
- `payments.pf_payment_id` - PayFast transaction ID
- `payments.created_at` - **Use for queries** (NOT payment_date!)
- `payments.payment_status` - 'Completed', 'Pending', 'Failed'

---

## Common Query Patterns

### Get driver entries for a specific event
```sql
SELECT 
  re.entry_id, 
  d.first_name, 
  d.last_name, 
  re.race_class,
  re.entry_status,
  e.event_name
FROM race_entries re
JOIN drivers d ON re.driver_id = d.driver_id
JOIN events e ON re.event_id = e.event_id
WHERE re.event_id = 'event_redstar_001'
ORDER BY d.last_name, d.first_name;
```

### Get all events with registration counts
```sql
SELECT 
  e.event_id,
  e.event_name,
  e.event_date,
  COUNT(re.entry_id) as registration_count
FROM events e
LEFT JOIN race_entries re ON e.event_id = re.event_id
GROUP BY e.event_id, e.event_name, e.event_date
ORDER BY e.event_date DESC;
```

### Get driver's payment history
```sql
SELECT 
  payment_id,
  item_name,
  amount_gross,
  payment_status,
  created_at
FROM payments
WHERE driver_id = '596ebaa1-06cd-4324-bdde-3716ef0b9c28'
ORDER BY created_at DESC;
```

### Get driver's race entries
```sql
SELECT 
  re.entry_id,
  e.event_name,
  re.race_class,
  re.entry_status,
  re.amount_paid,
  re.created_at
FROM race_entries re
JOIN events e ON re.event_id = e.event_id
WHERE re.driver_id = '596ebaa1-06cd-4324-bdde-3716ef0b9c28'
ORDER BY re.created_at DESC;
```

---

## Data Validation Rules

### DRIVERS table
- `driver_id`: UUID format, never NULL
- `email`: Unique, must match contact record
- `status`: One of 'Pending', 'Active', 'Suspended', 'Inactive'
- `class`: One of 'CADET', 'MINI ROK', 'JUNIOR MAX', 'SENIOR MAX'
- `password_hash`: Required for login capability

### RACE_ENTRIES table
- `entry_id`: Must be unique, never NULL
- `driver_id`: Foreign key to drivers, never NULL
- `event_id`: Foreign key to events (can be NULL for legacy entries)
- `race_class`: Should match driver.class at time of entry
- `entry_status`: One of 'pending', 'confirmed', 'cancelled', 'completed'
- `amount_paid`: 0 for free entries, > 0 for paid entries
- `payment_status`: NULL for free entries, 'Completed' for paid

### EVENTS table
- `event_id`: Unique, never NULL
- `event_name`: Required, never NULL
- `event_date`: Required, never NULL
- `entry_fee`: In Rands, e.g., 2950.00

---

## Known Issues Fixed

1. ✅ **race_entry_id column doesn't exist**
   - Solution: Use `entry_id` instead (actual primary key)
   - Affected: registerFreeRaceEntry endpoint

2. ✅ **payment_date column doesn't exist**
   - Solution: Use `created_at` instead
   - Affected: getPaymentHistory endpoint

3. ✅ **window.currentDriverId undefined**
   - Solution: Set window.currentDriverId in login handler (not just currentDriverId)
   - Affected: Free entry registration flow
