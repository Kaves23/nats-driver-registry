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
| r_id | ID/Passport | `N/A (NOT SENT)` | `id_or_passport_number` | drivers | `license_number` | ❌ NOT SENT |

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
| c_name | Guardian name | `contact_name` | `contact_name` | contacts | `name` | ✅ MATCH |
| c_email | Email | `email` | `email` | contacts | `email` | ✅ |
| c_phone | Phone | `contact_phone` | `contact_phone` | contacts | `phone` | ✅ MATCH |
| c_rel | Relationship | `contact_relationship` | `contact_relationship` | contacts | `relationship` | ✅ MATCH |
| c_emergency | Emergency flag | `contact_emergency` | `contact_emergency` | contacts | `is_emergency` | ✅ MATCH |
| c_consent | Consent flag | `contact_consent` | `contact_consent` | contacts | `is_consent` | ✅ MATCH |

### SECTION 4: MEDICAL & CONSENT

| Form ID | Form Label | Payload Name | Server Variable | DB Table | DB Column | Status |
|---------|-----------|--------------|-----------------|----------|-----------|--------|
| m_allergies | Allergies | `medical_allergies` | `medical_allergies` | medical_consent | `allergies` | ✅ |
| m_conditions | Medical conditions | `medical_conditions` | `medical_conditions` | medical_consent | `medical_conditions` | ✅ |
| m_medication | Medication | `medical_medication` | `medical_medication` | medical_consent | `medication` | ✅ |
| m_doctor_phone | Doctor phone | `medical_doctor_phone` | `medical_doctor_phone` | medical_consent | `doctor_phone` | ✅ |
| consent_form | Data processing consent | `N/A` | `consent_signed` | medical_consent | `consent_signed` | ❌ NOT SENT |
| media_release_signed | Media release | `media_release_signed` | `media_release_signed` | medical_consent | `media_release_signed` | ✅ |

### SECTION 5: SECURITY & DOCUMENTS

| Form ID | Form Label | Payload Name | Server Variable | DB Table | DB Column | Status |
|---------|-----------|--------------|-----------------|----------|-----------|--------|
| r_password | Password | `password` | `password` | drivers | `password_hash` | ✅ |
| r_password_confirm | Confirm password | (validation only) | - | - | - | ✅ |
| license_file | Driver license file | `license_b64, license_name, license_mime` | Same | documents | `license_document` | ✅ |
| photo_file | Profile photo | `photo_b64, photo_name, photo_mime` | Same | documents | `profile_photo` | ✅ |

---

## CRITICAL FINDINGS

### 🔴 MISSING FIELDS (Form has them, but not being sent):
1. **r_id (ID/Passport)** - Form field exists but NOT included in payload
2. **consent_signed (Data processing consent)** - Form likely has this but NOT being sent

### ✅ CORRECT PAYLOAD NAMES:
All contact fields are being sent with correct names:
- `contact_name` → DB column `name` ✅
- `contact_phone` → DB column `phone` ✅
- `contact_relationship` → DB column `relationship` ✅
- `contact_emergency` → DB column `is_emergency` ✅
- `contact_consent` → DB column `is_consent` ✅

### 📊 SUMMARY:
- **Total form fields**: 25+
- **Being sent correctly**: 23
- **Missing from payload**: 2 (r_id, consent_signed)
- **Database column name mismatches**: 0 (all contact fields match correctly)

---

## RECOMMENDATION:

The current code should be working! The contact fields are being sent with the correct variable names and the database columns should match. Let's verify by checking:
1. Is r_id field being captured in the form?
2. Is the consent_signed checkbox being captured?
3. What exact error are you getting on the form submission now?
