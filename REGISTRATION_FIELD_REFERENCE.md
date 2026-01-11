# ROK NATS Driver Registration - Complete Field Mapping Reference

**Document Date:** January 9, 2026  
**System:** NATS Driver Portal & Admin Management System  
**Database:** PlanetScale (MySQL)

---

## Overview

This document provides a comprehensive reference for all fields captured during driver registration and how they are stored in the database. It serves as a guide for system maintenance, debugging, and future enhancements.

---

## 1. Registration Form Structure

The driver registration form is organized into 6 main sections:

1. **Driver Identity** - Basic driver information
2. **Competition** - Karting-specific details
3. **Entrant / Guardian Details** - Parent/guardian contact information
4. **Medical & Consent** - Health and legal consent information
5. **Account Security** - Login credentials
6. **Documents** - File uploads (currently hidden)

---

## 2. Complete Field Mapping Table

### Section 1: DRIVER IDENTITY

| Form Field | Form ID | Data Type | Required | Database Table | Database Column | Status |
|---|---|---|---|---|---|---|
| First name | `r_first_name` | Text | ✅ Yes | `drivers` | `first_name` | ✅ WORKING |
| Last name | `r_last_name` | Text | ✅ Yes | `drivers` | `last_name` | ✅ WORKING |
| Date of birth | `r_dob` | Date | ✅ Yes | `drivers` | `date_of_birth` | ✅ WORKING |
| Nationality | `r_nat` | Text | ❌ No | `drivers` | `nationality` | ✅ WORKING |
| ID / Passport | `r_id` | Text | ✅ Yes | `drivers` | `license_number` | ⚠️ MAPPED* |
| Gender | `r_gender` | Text | ❌ No | `drivers` | `gender` | ✅ WORKING |

**Note:* The ID/Passport field is captured as `r_id` but saved to the `license_number` column (field name mismatch but functional)

---

### Section 2: COMPETITION / KARTING

| Form Field | Form ID | Data Type | Required | Database Table | Database Column | Status |
|---|---|---|---|---|---|---|
| Championship | `r_champ` | Select | ✅ Yes | `drivers` | `championship` | ✅ WORKING |
| Class | `r_class` | Select | ✅ Yes | `drivers` | `class` | ✅ WORKING |
| Race number | `r_race` | Text | ❌ No | `drivers` | `race_number` | ✅ WORKING |
| Team name | `r_team` | Text | ❌ No | `drivers` | `team_name` | ✅ WORKING |
| Coach name | `r_coach` | Text | ❌ No | `drivers` | `coach_name` | ✅ WORKING |
| Kart brand | `r_kart` | Text | ❌ No | `drivers` | `kart_brand` | ✅ WORKING |
| Transponder number | `r_transponder` | Text | ❌ No | `drivers` | `transponder_number` | ✅ WORKING |

**Championship Options:** ROK NATS, Northern Crown, Southern Crown, ALL

**Class Options:** CADET, MINI ROK U/10, MINI ROK, OK-J, OK-N, KZ2

---

### Section 3: ENTRANT / GUARDIAN DETAILS

| Form Field | Form ID | Data Type | Required | Database Table | Database Column | Status |
|---|---|---|---|---|---|---|
| Guardian full name | `c_name` | Text | ✅ Yes | `contacts` | `name` | ✅ WORKING** |
| Relationship | `c_rel` | Text | ✅ Yes | `contacts` | `relationship` | ✅ WORKING** |
| Email | `c_email` | Email | ✅ Yes | `contacts` | `email` | ✅ WORKING |
| Mobile phone | `c_phone` | Phone | ✅ Yes | `contacts` | `phone` | ✅ WORKING** |
| Emergency contact? | `c_emergency` | Select | ✅ Yes | `contacts` | `is_emergency` | ✅ WORKING** |
| Consent contact? | `c_consent` | Select | ✅ Yes | `contacts` | `is_consent` | ✅ WORKING** |

**Note:** ** Updated January 9, 2026 (commit 28a572d) - These fields were previously captured but not saved. Now fully functional.

**Helper Feature:** Checkbox "Entrant is same as driver" auto-populates guardian name from driver name.

---

### Section 4: MEDICAL & CONSENT

| Form Field | Form ID | Data Type | Required | Database Table | Database Column | Status |
|---|---|---|---|---|---|---|
| Allergies | `m_allergies` | Text | ❌ No | `medical_consent` | `allergies` | ✅ WORKING |
| Medical conditions | `m_conditions` | Text | ❌ No | `medical_consent` | `medical_conditions` | ✅ WORKING |
| Medication | `m_medication` | Text | ❌ No | `medical_consent` | `medication` | ✅ WORKING |
| Doctor phone | `m_doctor_phone` | Phone | ❌ No | `medical_consent` | `doctor_phone` | ✅ WORKING |
| Data processing consent | `consent_signed` | Select | ✅ Yes | `medical_consent` | `consent_signed` | ✅ WORKING |
| Media release | `media_release_signed` | Select | ❌ No | `medical_consent` | `media_release_signed` | ✅ WORKING** |

**Note:** ** Updated January 9, 2026 (commit 28a572d) - Media release field was previously captured but not saved. Now fully functional.

---

### Section 5: ACCOUNT SECURITY

| Form Field | Form ID | Data Type | Required | Database Table | Database Column | Status |
|---|---|---|---|---|---|---|
| Password | `r_password` | Password | ✅ Yes | `drivers` | `password_hash` | ✅ WORKING |
| Confirm password | `r_password_confirm` | Password | ✅ Yes | - | - | Validation Only |

**Security Note:** Passwords are hashed using bcryptjs before storage. Minimum 8 characters required.

---

### Section 6: DOCUMENTS (Currently Hidden)

| Form Field | Form ID | Data Type | Required | Database Table | Database Column | Status |
|---|---|---|---|---|---|---|
| Profile Photo | `r_profilePhoto` | File (Image) | ❌ No | `documents` | `profile_photo` | ⚠️ HIDDEN |
| Driver License | `r_driverLicense` | File (PDF/Image) | ❌ No | `documents` | `license_document` | ⚠️ HIDDEN |

**Status:** Form fields exist but are hidden with CSS (`display: none`). Files are optional and can be uploaded post-registration via admin portal.

---

## 3. Database Schema Reference

### Table: `drivers`
**Purpose:** Core driver profile information

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `driver_id` | UUID | NO | Primary key, auto-generated |
| `first_name` | VARCHAR | NO | Required at registration |
| `last_name` | VARCHAR | NO | Required at registration |
| `date_of_birth` | DATE | YES | Optional at registration |
| `nationality` | VARCHAR | YES | Optional at registration |
| `gender` | VARCHAR | YES | Optional at registration |
| `championship` | VARCHAR | YES | Selected competition |
| `class` | VARCHAR | YES | Racing class |
| `race_number` | VARCHAR | YES | Optional, driver number |
| `team_name` | VARCHAR | YES | Optional |
| `coach_name` | VARCHAR | YES | Optional |
| `kart_brand` | VARCHAR | YES | Optional |
| `transponder_number` | VARCHAR | YES | Optional |
| `license_number` | VARCHAR | YES | Stores ID/Passport number |
| `password_hash` | VARCHAR | NO | Bcrypt hashed password |
| `status` | VARCHAR | YES | Default: 'Pending' |
| `approval_status` | VARCHAR | YES | Admin approval status |

### Table: `contacts`
**Purpose:** Driver and guardian contact information

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `contact_id` | UUID | NO | Primary key, auto-generated |
| `driver_id` | UUID | NO | Foreign key to drivers |
| `name` | VARCHAR | YES | Guardian/entrant name |
| `email` | VARCHAR | NO | Primary email address |
| `phone` | VARCHAR | YES | Phone number |
| `relationship` | VARCHAR | YES | Relationship to driver (Mother, Father, Guardian, etc.) |
| `is_emergency` | BOOLEAN | YES | Emergency contact flag |
| `is_consent` | BOOLEAN | YES | Consent contact flag |

### Table: `medical_consent`
**Purpose:** Medical and legal consent information

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | INT | NO | Primary key, auto-increment |
| `driver_id` | UUID | NO | Foreign key to drivers |
| `allergies` | TEXT | YES | Allergy information |
| `medical_conditions` | TEXT | YES | Medical conditions |
| `medication` | TEXT | YES | Current medications |
| `doctor_phone` | VARCHAR | YES | Doctor contact number |
| `consent_signed` | BOOLEAN | YES | Data processing consent |
| `consent_date` | TIMESTAMP | YES | When consent was given |
| `media_release_signed` | BOOLEAN | YES | Media release permission |

### Table: `documents`
**Purpose:** File uploads (license, photos, etc.)

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `document_id` | UUID | NO | Primary key, auto-generated |
| `driver_id` | UUID | NO | Foreign key to drivers |
| `license_document` | BLOB | YES | Driver license file |
| `profile_photo` | BLOB | YES | Profile photo file |

---

## 4. Data Flow & Validation

### Registration Submission Flow

```
Driver Portal
    ↓
Form Validation (Client-side)
    ├─ Required fields present
    ├─ Password ≥ 8 characters
    ├─ Passwords match
    └─ Consent accepted
    ↓
Backend Validation (server.js)
    ├─ Email format validation
    ├─ Duplicate email check
    ├─ Required field verification
    └─ Business logic validation
    ↓
Database Storage (Transaction)
    ├─ drivers table INSERT
    ├─ contacts table INSERT
    ├─ medical_consent table INSERT
    ├─ documents table INSERT (if files provided)
    └─ COMMIT or ROLLBACK
    ↓
Email Confirmation Sent
    └─ registration-confirmation.html template
    ↓
Success Response to Driver
    └─ Driver ID, login credentials, next steps
```

---

## 5. Admin Portal Field Visibility

### Edit Driver Modal

When an admin clicks on a driver in the admin portal, they see:

#### Basic Information
- Email
- First Name
- Last Name
- Class
- Race Number
- License Number
- Transponder Number
- Team Name
- Coach Name
- Kart Brand
- Engine Rental Status (paid/not paid)
- Race Entry Status (registered/not registered)
- Engine Rental Status for Next Race
- Overall Status (Pending/Approved)
- Paid Status (Paid/Unpaid)

#### Guardian / Entrant Contact
- Guardian Name
- Relationship
- Contact Phone
- Emergency Contact? (Yes/No)
- Consent Contact? (Yes/No)

#### Medical & Consent
- Allergies
- Medical Conditions
- Medication
- Doctor Phone
- Data Processing Consent
- Media Release

#### Driver Documents
- Driver License (view/download button)
- Profile Photo (view/download button)

---

## 6. Recent Updates (January 9, 2026)

### Commit: 28a572d

**Changes Made:**
1. ✅ Contact fields now saved to database
   - Guardian name → `contacts.name`
   - Relationship → `contacts.relationship`
   - Phone → `contacts.phone`
   - Emergency contact flag → `contacts.is_emergency`
   - Consent contact flag → `contacts.is_consent`

2. ✅ Medical release field now saved
   - Media release → `medical_consent.media_release_signed`

3. ✅ Admin portal updated to display all contact and consent information

4. ✅ API endpoint `/api/getAllDrivers` updated to retrieve all fields

**Files Modified:**
- `driver_portal.html` - Form payload updated
- `server.js` - Backend logic to save all fields
- `admin.html` - Display fields in admin modal

---

## 7. Quick Reference: What Gets Saved

### ✅ FULLY WORKING (21 fields)
**Driver Information (6):** First name, Last name, DOB, Nationality, Gender, ID/Passport  
**Competition (7):** Championship, Class, Race number, Team, Coach, Kart brand, Transponder  
**Contact (6):** Name, Relationship, Email, Phone, Emergency flag, Consent flag  
**Medical (4):** Allergies, Conditions, Medication, Doctor phone, Consent, Media release  
**Security (1):** Password (hashed)

### ❌ NOT SAVED (0 fields)
All registration fields are now being saved as of January 9, 2026.

### ⚠️ PARTIALLY WORKING (2 items)
- **File uploads:** Form fields exist but hidden; can be uploaded via admin portal
- **ID/Passport field naming:** Saved to `license_number` column (functional but misnamed)

---

## 8. API Endpoints

### Registration Endpoint
```
POST /api/registerDriver

Payload includes:
- Driver identity (first_name, last_name, date_of_birth, nationality, gender)
- Competition (championship, class, race_number, team_name, coach_name, kart_brand, transponder_number)
- Contact (contact_name, contact_phone, contact_relationship, contact_emergency, contact_consent)
- Medical (medical_allergies, medical_conditions, medical_medication, medical_doctor_phone)
- Security (password, consent_signed, media_release_signed)
- Files (license_b64, photo_b64)

Response:
{
  "success": true,
  "data": {
    "driver_id": "uuid",
    "message": "Registration successful"
  }
}
```

### Get All Drivers (Admin)
```
POST /api/getAllDrivers

Returns all driver records with all fields listed above, 
including contact and medical information.
```

---

## 9. Troubleshooting Reference

| Issue | Cause | Solution |
|---|---|---|
| Contact info not visible in admin | API not returning contact data | Check `/api/getAllDrivers` includes contact query |
| Medical data empty in admin | Medical consent not being saved | Verify `medical_consent` table INSERT in server.js |
| Guardian name shows as blank | Contact info not captured in form payload | Check form payload includes `contact_name` |
| Password not working at login | Password not hashed before storage | Verify bcryptjs is being used |
| Duplicate email error | Email already exists in contacts table | Check for duplicate prevention logic |
| Registration fails silently | Transaction rollback | Check server logs for specific error |

---

## 10. Future Enhancement Opportunities

1. **Enable file uploads** - Unhide document upload section
2. **Fix ID/Passport field naming** - Rename column or create separate column
3. **Add additional contacts** - Allow multiple guardian contacts per driver
4. **Driver photo display** - Show profile photo in driver portal and admin
5. **Medical alert system** - Display medical flags prominently in admin portal
6. **Contact preference settings** - Allow drivers to manage contact preferences
7. **Bulk medical data import** - Admin tool to import medical data in bulk
8. **Export capabilities** - Export driver data for records/reports

---

## 11. Related Documents

- `FIELD_MAPPING_REPORT.md` - Initial field mapping analysis
- `AUTHENTICATION_GUIDE.md` - Login and password reset procedures
- `AUTHENTICATION_IMPLEMENTATION.md` - Technical implementation details

---

## Document History

| Date | Version | Changes | Author |
|---|---|---|---|
| 2026-01-09 | 1.0 | Initial comprehensive reference document | System Documentation |
| 2026-01-09 | 1.0 | Added all field mappings, database schema, and recent updates | System Documentation |

---

**Last Updated:** January 9, 2026  
**System Status:** ✅ All registration fields now being captured and saved
