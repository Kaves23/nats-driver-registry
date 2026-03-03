# Entry Pricing Breakdown — NATS 2026

> **Source of truth:** `driver_portal.html` → `getEntryConfig()` / `resolveEntryConfig()`
> Admin can override any of these per-event via **Entry Pricing Config** (⚙ button on Events tab).
> Per-driver package exemptions are set on the driver record (`national_package` field).

---

## 1. Championship / Day Selection

Every entry starts with two choices in **Step A** of the entry modal:

| Choice | Options |
|--------|---------|
| Championship type | National · Regional · Both (National + Regional) |
| Race day(s) | Saturday · Sunday · Both Days |

- **National or Both** → national pricing applies and race tyres become **required**.
- **Regional only** → regional (lower) pricing applies and race tyres are **optional**.
- **Both Days** package is always cheaper than buying two single days separately.

---

## 2. Default Pricing by Class

### CADET (Tillotson · Pool engine programme)

| Item | 1 Day | Both Days | Status |
|------|------:|----------:|--------|
| Race Entry Fee | R 2 950 | R 5 900 | **Mandatory** |
| Transponder Rental | R 250 | R 500 | Optional |
| Practice Tyres (per set) | R 3 520 ea | R 3 520 ea | Optional (qty) |
| Wet Tyres | R 4 400 | R 4 400 | Optional |

> No engine rental line — Cadet uses a pool engine already bundled in the class programme.
> No fuel line — Cadet fuel is managed separately outside the entry portal.

---

### MINI ROK · MINI ROK U/10 (Vortex Mini ROK · Pool engine programme)

| Item | 1 Day (Nat) | Both Days (Nat) | 1 Day (Reg) | Both Days (Reg) | Status |
|------|------------:|----------------:|------------:|----------------:|--------|
| Race Entry Fee | R 3 950 | R 6 500 | R 2 950 | R 5 900 | **Mandatory** |
| Engine Rental | R 3 500 | R 5 800 | R 3 500 | R 5 800 | **Required** |
| Controlled Fuel | R 405 | R 810 | R 405 | R 810 | **Required** |
| Race Tyres (set) | R 3 520 | R 5 800 | R 3 520 | R 5 800 | **Required** (Nat) / Optional (Reg) |
| Transponder Rental | R 250 | R 500 | R 250 | R 500 | Optional |
| Practice Tyres (per set) | R 3 520 ea | R 3 520 ea | R 3 520 ea | R 3 520 ea | Optional (qty) |
| Wet Tyres | R 4 400 | R 4 400 | R 4 400 | R 4 400 | Optional |

**Both-days saving:** R 3 950 × 2 = R 7 900 vs package R 6 500 → **save R 1 400** on entry alone.

---

### OK-J · OK-N · KZ2 (Senior/Open classes)

| Item | 1 Day (Nat) | Both Days (Nat) | 1 Day (Reg) | Both Days (Reg) | Status |
|------|------------:|----------------:|------------:|----------------:|--------|
| Race Entry Fee | R 3 950 | R 6 500 | R 2 950 | R 5 900 | **Mandatory** |
| Engine Rental (OK) | R 6 500 | R 11 000 | R 6 500 | R 11 000 | **Required** |
| Controlled Fuel | R 720 | R 1 440 | R 720 | R 1 440 | **Required** |
| Race Tyres (set) | R 4 730 | R 8 000 | R 4 730 | R 8 000 | **Required** (Nat) / Optional (Reg) |
| Transponder Rental | R 250 | R 500 | R 250 | R 500 | Optional |
| Practice Tyres (per set) | R 4 730 ea | R 4 730 ea | R 4 730 ea | R 4 730 ea | Optional (qty) |
| Wet Tyres | R 5 500 | R 5 500 | R 5 500 | R 5 500 | Optional |

---

## 3. Optional Add-Ons (available to all classes)

| Add-On | Price | Notes |
|--------|------:|-------|
| **Transponder Rental** | R 250 / day (R 500 both days) | If driver does not own one |
| **Practice Tyres** | R 3 520 (Mini/Cadet) · R 4 730 (OK/Senior) per set | Qty stepper — can add multiple sets |
| **Wet Tyres** | R 4 400 (Mini/Cadet) · R 5 500 (OK/Senior) | Flat rate regardless of days |

---

## 4. Exemptions — Who Pays What

Exemptions are stored on the **driver record** as the `national_package` column. Admin sets this on the Drivers tab. There are two levels:

### `national_package = 'engine'`
- Engine rental **removed** from their entry checkout — they already have an engine as part of their season deal.
- Everything else (entry fee, fuel, tyres, transponder) is still charged normally.

### `national_package = 'full'`
- Engine rental **removed** (included in package).
- **Entry fee set to R 0** (both single-day and both-days).
- Entry name shown as *"… (Season Package — included)"*.
- **Fuel removed** from their checkout.
- **Race tyres removed** from their checkout.
- Only optional items (transponder, practice tyres, wet tyres) may still be added at their own cost.

> These exemptions **only apply to National events** (`champ !== 'Regional'`). Regional entries are always charged the full regional rate regardless of package status.

---

## 5. Admin Event-Level Overrides

Via the **⚙ Entry Pricing Config** button on any event, admins can override the defaults above on a per-class, per-event basis. Overrideable fields:

| Field | Applies to |
|-------|-----------|
| `natP1` / `natPB` | National 1-day / both-days entry fee |
| `regP1` / `regPB` | Regional 1-day / both-days entry fee |
| `engP1` / `engPB` | Engine rental 1-day / both-days |
| `fuelP1` / `fuelPB` | Fuel 1-day / both-days |
| `tyrP1` / `tyrPB` | Race tyres 1-day / both-days |
| `transP1` / `transPB` | Transponder 1-day / both-days |
| `pracUnit` | Practice tyres unit price |
| `wetPrice` | Wet tyres price (flat) |
| `hasEngine` / `hasTyres` / `hasFuel` | Set `false` to make that item optional for this event |

These overrides are stored in the `event_class_pricing` table and are fetched when a driver opens the entry modal (`/api/getEventPricing/:eventId`).

---

## 6. Priority Override Order

When calculating what a driver is charged, the system applies in this order (later steps win):

```
1. Base prices from getEntryConfig() (class + champ defaults)
       ↓
2. national_package exemption (per-driver — removes/zeros items)
       ↓
3. event_class_pricing admin override (per-event — adjusts prices / toggles items)
       ↓
4. Final total shown to driver before PayFast checkout
```

---

## 7. Both-Days Package Savings Summary

| Class | 2 × Single Day | Both-Days Package | Saving |
|-------|---------------:|------------------:|-------:|
| CADET (National) | R 5 900 | R 5 900 | — |
| MINI ROK (National, entry only) | R 7 900 | R 6 500 | **R 1 400** |
| MINI ROK (National, entry + engine + fuel + tyres) | R 15 750 | R 12 910 | **R 2 840** |
| OK-J/OK-N (National, entry only) | R 7 900 | R 6 500 | **R 1 400** |
| OK-J/OK-N (National, entry + engine + fuel + tyres) | R 30 800 | R 26 940 | **R 3 860** |

---

## 8. Quick Reference — What Each Class Pays at a National (Both Days)

| Class | Entry | Engine | Fuel | Tyres | **Min Total** |
|-------|------:|-------:|-----:|------:|----------:|
| CADET | R 5 900 | — | — | — | **R 5 900** |
| MINI ROK | R 6 500 | R 5 800 | R 810 | R 5 800 | **R 18 910** |
| MINI ROK U/10 | R 6 500 | R 5 800 | R 810 | R 5 800 | **R 18 910** |
| OK-J | R 6 500 | R 11 000 | R 1 440 | R 8 000 | **R 26 940** |
| OK-N | R 6 500 | R 11 000 | R 1 440 | R 8 000 | **R 26 940** |
| KZ2 | R 6 500 | R 11 000 | R 1 440 | R 8 000 | **R 26 940** |

*Min Total = mandatory items only, National, Both Days. Transponder, practice tyres and wet tyres are extra.*

---

*Last updated: March 2026 — based on `driver_portal.html` `getEntryConfig()` defaults.*
