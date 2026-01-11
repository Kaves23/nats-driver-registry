# REGISTRATION FIELD MAPPING TO DATABASE

## TABLE 1: DRIVER IDENTITY FIELDS

| Registration Form Field | Database Table | Database Column | Status | Notes |
|---|---|---|---|---|
| First name | `drivers` | `first_name` | ✅ WORKING | Required, saved on registration |
| Last name | `drivers` | `last_name` | ✅ WORKING | Required, saved on registration |
| Date of birth | `drivers` | `date_of_birth` | ✅ WORKING | Optional, saved on registration |
| Nationality | `drivers` | `nationality` | ✅ WORKING | Optional, saved on registration |
| ID / Passport | `drivers` | `license_number` | ⚠️ MAPPED | Captured as `r_id`, saved to `license_number` column |
| Gender | `drivers` | `gender` | ✅ WORKING | Optional, saved on registration |

---

## TABLE 2: COMPETITION / KARTING FIELDS

| Registration Form Field | Database Table | Database Column | Status | Notes |
|---|---|---|---|---|
| Championship | `drivers` | `championship` | ✅ WORKING | Required, saved on registration |
| Class | `drivers` | `class` | ✅ WORKING | Required, saved on registration |
| Race number | `drivers` | `race_number` | ✅ WORKING | Optional, saved on registration |
| Team name | `drivers` | `team_name` | ✅ WORKING | Optional, saved on registration |
| Coach name | `drivers` | `coach_name` | ✅ WORKING | Optional, saved on registration |
| Kart brand | `drivers` | `kart_brand` | ✅ WORKING | Optional, saved on registration |
| Transponder number | `drivers` | `transponder_number` | ✅ WORKING | Optional, saved on registration |

---

## TABLE 3: ENTRANT / GUARDIAN CONTACT FIELDS

| Registration Form Field | Database Table | Database Column | Status | Notes |
|---|---|---|---|---|
| Guardian full name | `contacts` | `name` | ❌ NOT SAVED | Field captured but NOT currently saved to database |
| Relationship | `contacts` | `relationship` | ❌ NOT SAVED | Field captured but NOT currently saved to database |
| Email | `contacts` | `email` | ✅ WORKING | Required, saved as primary contact |
| Mobile phone | `contacts` | `phone` | ❌ NOT SAVED | Field captured but NOT currently saved to database |
| Emergency contact flag | `contacts` | `is_emergency` | ❌ NOT SAVED | Field captured but NOT currently saved to database |
| Consent contact flag | `contacts` | `is_consent` | ❌ NOT SAVED | Field captured but NOT currently saved to database |

---

## TABLE 4: MEDICAL & CONSENT FIELDS

| Registration Form Field | Database Table | Database Column | Status | Notes |
|---|---|---|---|---|
| Allergies | `medical_consent` | `allergies` | ✅ WORKING | Optional, saved on registration |
| Medical conditions | `medical_consent` | `medical_conditions` | ✅ WORKING | Optional, saved on registration |
| Medication | `medical_consent` | `medication` | ✅ WORKING | Optional, saved on registration |
| Doctor phone | `medical_consent` | `doctor_phone` | ✅ WORKING | Optional, saved on registration |
| Data processing consent | `medical_consent` | `consent_signed` | ✅ WORKING | Required, saved on registration |
| Media release | `medical_consent` | `media_release_signed` | ❌ NOT SAVED | Field captured but NOT currently saved to database |

---

## TABLE 5: ACCOUNT SECURITY & DOCUMENTS

| Registration Form Field | Database Table | Database Column | Status | Notes |
|---|---|---|---|---|
| Password | `drivers` | `password_hash` | ✅ WORKING | Required, hashed and secured, saved on registration |
| Profile photo | `documents` | `profile_photo` | ⚠️ PARTIAL | File upload field exists but currently hidden (display: none) |
| Driver license file | `documents` | `license_document` | ⚠️ PARTIAL | File upload field exists but currently hidden (display: none) |

---

## SUMMARY

### ✅ FULLY WORKING (Fields being saved correctly)
- **Driver Identity**: First name, Last name, Date of birth, Nationality, Gender
- **Competition**: Championship, Class, Race number, Team name, Coach name, Kart brand, Transponder
- **Contacts**: Email (as primary contact)
- **Medical**: Allergies, Medical conditions, Medication, Doctor phone, Data processing consent
- **Security**: Password (hashed)

### ❌ NOT BEING SAVED (Fields captured but not stored)
- Guardian name (`c_name`)
- Relationship (`c_rel`)
- Mobile phone (`c_phone`)
- Emergency contact flag (`c_emergency`)
- Consent contact flag (`c_consent`)
- Media release (`media_release_signed`)

### ⚠️ PARTIALLY WORKING
- ID/Passport: Captured as `r_id` but saved to `license_number` column (mapping exists but field name mismatch)
- Profile photo & Driver license: Upload fields exist but currently hidden (display: none)

---

## RECOMMENDATION

**Contact fields (phone, relationship, emergency, consent flags) are captured but not saved.** Would you like me to:
1. Add code to save these contact fields to the `contacts` table?
2. Enable the media_release_signed field to be saved to `medical_consent` table?
3. Unhide and enable the file upload fields for profile photo and driver license?
