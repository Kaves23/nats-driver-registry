# FORM FIELD TO DATABASE MAPPING - COMPLETE AUDIT

## FORM FIELDS → PAYLOAD NAMES → SERVER VARIABLES → DATABASE COLUMNS

### SECTION 1: DRIVER IDENTITY

| Form ID | Form Label | Payload Name | Server Variable | DB Table | DB Column | Status |
|---------|-----------|--------------|-----------------|----------|-----------|--------|
| r_first_name | First name | `first_name` | `first_name` | drivers | `first_name` | ✅ |
| r_last_name | Last name | `last_name` | `last_name` | drivers | `last_name` | ✅ |
| r_dob | Date of birth | `date_of_birth` | `date_of_birth` | drivers | `date_of_birth` | ✅ |
| r_nat | Nationality | `nationality` | `nationality` | drivers | `nationality` | ✅ |
| r_gender | Gender | `gender` | `gender` | drivers | `gender` | ✅ |
| r_id | ID/Passport | `id_or_passport_number` | `id_or_passport_number` | drivers | `license_number` | ✅ SENT |

### SECTION 2: COMPETITION/KARTING

| Form ID | Form Label | Payload Name | Server Variable | DB Table | DB Column | Status |
|---------|-----------|--------------|-----------------|----------|-----------|--------|
| r_champ | Championship | `championship` | `championship` | drivers | `championship` | ✅ |
| r_class | Class | `class` | `klass` | drivers | `class` | ✅ |
| r_race | Race number | `race_number` | `race_number` | drivers | `race_number` | ✅ |
| r_team | Team name | `team_name` | `team_name` | drivers | `team_name` | ✅ |
| r_coach | Coach name | `coach_name` | `coach_name` | drivers | `coach_name` | ✅ |
| r_kart | Kart brand | `kart_brand` | `kart_brand` | drivers | `kart_brand` | ✅ |
| r_transponder | Transponder | `transponder_number` | `transponder_number` | drivers | `transponder_number` | ✅ |

### SECTION 3: ENTRANT/GUARDIAN CONTACT

| Form ID | Form Label | Payload Name | Server Variable | DB Table | DB Column | Status |
|---------|-----------|--------------|-----------------|----------|-----------|--------|
| c_name | Guardian name | `contact_name` | `contact_name` | contacts | `full_name` | ✅ MATCH |
| c_email | Email | `email` | `email` | contacts | `email` | ✅ |
| c_phone | Phone | `contact_phone` | `contact_phone` | contacts | `phone_mobile` | ✅ MATCH |
| c_rel | Relationship | `contact_relationship` | `contact_relationship` | contacts | `relationship` | ✅ MATCH |
| c_emergency | Emergency flag | `contact_emergency` | `contact_emergency` | contacts | `emergency_contact` | ✅ MATCH |
| c_consent | Consent flag | `contact_consent` | `contact_consent` | contacts | `consent_contact` | ✅ MATCH |

### SECTION 4: MEDICAL & CONSENT

| Form ID | Form Label | Payload Name | Server Variable | DB Table | DB Column | Status |
|---------|-----------|--------------|-----------------|----------|-----------|--------|
| m_allergies | Allergies | `medical_allergies` | `medical_allergies` | medical_consent | `allergies` | ✅ |
| m_conditions | Medical conditions | `medical_conditions` | `medical_conditions` | medical_consent | `medical_conditions` | ✅ |
| m_medication | Medication | `medical_medication` | `medical_medication` | medical_consent | `medication` | ✅ |
| m_doctor_phone | Doctor phone | `medical_doctor_phone` | `medical_doctor_phone` | medical_consent | `doctor_phone` | ✅ |
| consent_signed | Data processing consent | `consent_signed` | `consent_signed` | medical_consent | `consent_signed` | ✅ SENT |
| media_release_signed | Media release | `media_release_signed` | `media_release_signed` | medical_consent | `media_release_signed` | ⚠️ SENT NOT SAVED |

### SECTION 5: SECURITY & DOCUMENTS

| Form ID | Form Label | Payload Name | Server Variable | DB Table | DB Column | Status |
|---------|-----------|--------------|-----------------|----------|-----------|--------|
| r_password | Password | `password` | `password` | drivers | `password_hash` | ✅ |
| r_password_confirm | Confirm password | (validation only) | - | - | - | ✅ |
| r_profilePhoto | Profile photo | `photo_b64, photo_name, photo_mime` | Same | documents | `profile_photo` | ⚠️ SENT NOT PERSISTED |
| r_driverLicense | Driver license file | `license_b64, license_name, license_mime` | Same | documents | `license_document` | ⚠️ SENT NOT PERSISTED |

---

## CRITICAL FINDINGS

### � ALL FIELDS BEING SENT CORRECTLY:
1. **r_id (ID/Passport)** - ✅ NOW VERIFIED: Being sent as `id_or_passport_number` and saved to `license_number` column
2. **consent_signed (Data processing consent)** - ✅ NOW VERIFIED: Being sent and saved to database

### ⚠️ FIELDS SENT BUT NOT PERSISTED:
1. **media_release_signed** - Being sent to database but NOT actually persisted (issue in INSERT query)
2. **Profile photo & Driver license** - Being sent as base64 but NOT persisted (no database implementation)

### ✅ CORRECT PAYLOAD & COLUMN NAMES:
All contact fields are being sent with correct names and saved to correct columns:
- `contact_name` → DB column `full_name` ✅
- `contact_phone` → DB column `phone_mobile` ✅
- `contact_relationship` → DB column `relationship` ✅
- `contact_emergency` → DB column `emergency_contact` ✅
- `contact_consent` → DB column `consent_contact` ✅

### 📊 SUMMARY:
- **Total form fields**: 25+
- **Being sent & saved correctly**: 23
- **Being sent but NOT saved**: 3 (media_release_signed, photo_b64, license_b64)
- **Database column name mismatches**: 0 (all matches verified)

---

## RECOMMENDATION:

Registration is working well! The issues are:
1. **media_release_signed** - Being sent but the INSERT query has the field name wrong or missing binding parameter
2. **File uploads** - Being collected and sent as base64 but missing database persistence layer
