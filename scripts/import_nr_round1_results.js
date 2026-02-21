/**
 * Import 2026 Northern Regions Round 1 Results
 * Event: NR Rnd 1 — Red Star (14 Feb 2026)
 *
 * - Clears ALL dummy points data
 * - Adds championship_type column if missing
 * - Imports real results, matching drivers by license_number (fallback: name)
 * - Stores both Regional (Northern Regions) and NATS championship rows where applicable
 */

require('dotenv').config();
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENT METADATA
// ─────────────────────────────────────────────────────────────────────────────
const EVENT_META = {
  name : '2026 NR Rnd 1 - Red Star',
  round: 1,
  season: '2026',
  date : '2026-02-14',
  venue: 'Red Star Raceway, Delmas'
};

// Points per session result — same scale for Regional & NATS
// DSQ / DNS is stored as 0
function pts(v) {
  if (!v || v === 'DSQ' || v === 'DNS' || v === 'DNF') return 0;
  return parseInt(v, 10) || 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// RAW CSV DATA
// Each entry: { rnk, no, lastName, firstName, license, r1, r2, r3, total, team }
// championship_type: 'Northern Regions' = regional only
//                   'ROK NATS'          = counts toward NATS championship
// ─────────────────────────────────────────────────────────────────────────────

const RESULTS = [
  // ── CADET ──────────────────────────────────────────────────────────────────
  { rnk:1, no:88,  firstName:'Yerhu',        lastName:'Malabie',        license:'44523', class:'CADET',        r1:32, r2:35, r3:35, total:102, team:'Bambino Race',          dsq:{} },
  { rnk:2, no:29,  firstName:'Grayson',      lastName:'Venter',         license:'44150', class:'CADET',        r1:35, r2:32, r3:32, total:99,  team:'Expert',                dsq:{} },
  { rnk:3, no:96,  firstName:'Christopher',  lastName:'Grimmick',       license:'44432', class:'CADET',        r1:30, r2:30, r3:30, total:90,  team:'',                      dsq:{} },

  // ── MINI ROK ───────────────────────────────────────────────────────────────
  { rnk:1,  no:17,  firstName:'Kayde',       lastName:'Cornofsky',      license:'27945', class:'MINI ROK',     r1:35, r2:35, r3:32, total:102, team:'Xtreme Racing',         dsq:{} },
  { rnk:2,  no:50,  firstName:'Ronald',      lastName:'Venter',         license:'32140', class:'MINI ROK',     r1:30, r2:27, r3:29, total:86,  team:'Expert',                dsq:{} },
  { rnk:3,  no:24,  firstName:'Noah',        lastName:'Cronje',         license:'28089', class:'MINI ROK',     r1:32, r2:32, r3:21, total:85,  team:'',                      dsq:{} },
  { rnk:4,  no:18,  firstName:'Riley',       lastName:'van Staden',     license:'33521', class:'MINI ROK',     r1:24, r2:30, r3:30, total:84,  team:'N/A',                   dsq:{} },
  { rnk:5,  no:88,  firstName:'Diego',       lastName:'Berardone',      license:'35865', class:'MINI ROK',     r1:29, r2:26, r3:28, total:83,  team:'Kokoro Racing',         dsq:{} },
  { rnk:6,  no:58,  firstName:'Parker',      lastName:'van der Molen',  license:'44345', class:'MINI ROK',     r1:28, r2:28, r3:27, total:83,  team:'NBR',                   dsq:{} },
  { rnk:7,  no:566, firstName:'Diego',       lastName:'Antunes',        license:'32278', class:'MINI ROK',     r1:27, r2:29, r3:24, total:80,  team:'Stretto',               dsq:{} },
  { rnk:8,  no:29,  firstName:'Maddox',      lastName:'Mason',          license:'20875', class:'MINI ROK',     r1:20, r2:24, r3:35, total:79,  team:'RKT',                   dsq:{} },
  { rnk:9,  no:46,  firstName:'Ethan',       lastName:'Tuttelberg',     license:'43664', class:'MINI ROK',     r1:26, r2:25, r3:25, total:76,  team:'NBR TMG',               dsq:{} },
  { rnk:10, no:12,  firstName:'Hunter',      lastName:'North',          license:'35901', class:'MINI ROK',     r1:25, r2:23, r3:23, total:71,  team:'RKT',                   dsq:{} },
  { rnk:11, no:20,  firstName:'Nicholas',    lastName:'Fleming',        license:'45645', class:'MINI ROK',     r1:23, r2:22, r3:22, total:67,  team:'NBR',                   dsq:{} },
  { rnk:12, no:55,  firstName:'Zac',         lastName:'Boshoff',        license:'31242', class:'MINI ROK',     r1:22, r2:16, r3:26, total:64,  team:'Kokoro Racing',         dsq:{} },
  { rnk:13, no:44,  firstName:'Omolemo Aqhamile', lastName:'Mfana',     license:'32118', class:'MINI ROK',     r1:21, r2:21, r3:16, total:58,  team:'Kokoro Racing Academy', dsq:{} },

  // ── MINI ROK U/10 ──────────────────────────────────────────────────────────
  { rnk:1, no:50,  firstName:'Ronald',       lastName:'Venter',         license:'32140', class:'MINI ROK U/10',r1:35, r2:35, r3:35, total:105, team:'Expert',               dsq:{} },
  { rnk:2, no:20,  firstName:'Nicholas',     lastName:'Fleming',        license:'45645', class:'MINI ROK U/10',r1:32, r2:32, r3:32, total:96,  team:'NBR',                  dsq:{} },

  // ── OK-J ───────────────────────────────────────────────────────────────────
  { rnk:1,  no:28,  firstName:'Mattao',      lastName:'Mason',          license:'19794', class:'OK-J',         r1:35, r2:35, r3:35,  total:105, team:'RKT',                  dsq:{} },
  { rnk:2,  no:15,  firstName:'Aleksandar',  lastName:'Praizovic',      license:'37414', class:'OK-J',         r1:28, r2:32, r3:32,  total:92,  team:'KRA',                  dsq:{} },
  { rnk:3,  no:33,  firstName:'Max',         lastName:'Boshoff',        license:'44265', class:'OK-J',         r1:29, r2:30, r3:29,  total:88,  team:'Kokoro Racing',        dsq:{} },
  { rnk:4,  no:78,  firstName:'Retlotleng',  lastName:'Thekiso',        license:'40654', class:'OK-J',         r1:27, r2:27, r3:30,  total:84,  team:'WRA / RKT',            dsq:{} },
  { rnk:5,  no:88,  firstName:'Ruvan',       lastName:'Maritz',         license:'27587', class:'OK-J',         r1:25, r2:26, r3:27,  total:78,  team:'RKT',                  dsq:{} },
  { rnk:6,  no:12,  firstName:'Matthew',     lastName:'Shuttleworth',   license:'20828', class:'OK-J',         r1:24, r2:25, r3:26,  total:75,  team:'Stretto Racing',       dsq:{} },
  { rnk:7,  no:26,  firstName:'Ashaan',      lastName:'Reddi',          license:'37470', class:'OK-J',         r1:26, r2:20, r3:28,  total:74,  team:'NKA Karting',          dsq:{} },
  { rnk:8,  no:13,  firstName:'Kiyaan',      lastName:'Reddi',          license:'57445', class:'OK-J',         r1:19, r2:20, r3:25,  total:64,  team:'Kokoro',               dsq:{} },
  { rnk:9,  no:22,  firstName:'Jordan',      lastName:'Klaasen',        license:'40378', class:'OK-J',         r1:32, r2:28, r3:'DSQ', total:60, team:'Stanley Hatem Motor Sport', dsq:{r3:true} },
  { rnk:10, no:68,  firstName:'Logan',       lastName:'Billau',         license:'27816', class:'OK-J',         r1:30, r2:29, r3:'DSQ', total:59, team:'Kokoro Racing Academy', dsq:{r3:true} },

  // ── OK-N ───────────────────────────────────────────────────────────────────
  { rnk:1, no:11,  firstName:'Chase',        lastName:'Haskins',        license:'45218', class:'OK-N',         r1:35, r2:35, r3:32,  total:102, team:'Kokoro Racing Academy', dsq:{} },
  { rnk:2, no:31,  firstName:'Jack',         lastName:'Moore',          license:'17650', class:'OK-N',         r1:32, r2:32, r3:35,  total:99,  team:'Kokoro / Puma / Fleet Dynamics', dsq:{} },
  { rnk:3, no:221, firstName:'Aidan',        lastName:'Calitz',         license:'46452', class:'OK-N',         r1:30, r2:30, r3:29,  total:89,  team:'Full Blast Racing',    dsq:{} },
  { rnk:4, no:112, firstName:'Brooke',       lastName:'Loreti',         license:'36142', class:'OK-N',         r1:'DSQ', r2:29, r3:30, total:59, team:'kokoro',             dsq:{r1:true} },
];

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   NR Round 1 Results Import');
  console.log('   ' + EVENT_META.name);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1. Add championship_type column if it doesn't exist
  console.log('Step 1 — Ensuring championship_type column exists...');
  await pool.query(`
    ALTER TABLE points
    ADD COLUMN IF NOT EXISTS championship_type VARCHAR(30) DEFAULT 'Northern Regions'
  `);
  console.log('  ✅ championship_type column ready\n');

  // 2. Clear ALL existing dummy/test points records
  console.log('Step 2 — Clearing all existing points records...');
  const deleted = await pool.query('DELETE FROM points RETURNING points_id');
  console.log(`  ✅ Deleted ${deleted.rowCount} existing record(s)\n`);

  // 3. Build driver lookup maps (license_number → driver_id, and name → driver_id)
  console.log('Step 3 — Building driver lookup map...');
  const allDrivers = await pool.query(
    `SELECT driver_id, first_name, last_name, license_number, class, championship
     FROM drivers WHERE is_deleted = false OR is_deleted IS NULL`
  );
  const byLicense = {};
  const byName    = {};
  for (const d of allDrivers.rows) {
    if (d.license_number) byLicense[d.license_number.trim()] = d;
    const key = `${(d.first_name || '').trim().toLowerCase()} ${(d.last_name || '').trim().toLowerCase()}`;
    byName[key] = d;
  }
  console.log(`  ✅ Loaded ${allDrivers.rows.length} drivers\n`);

  // 4. Insert real results
  console.log('Step 4 — Importing race results...\n');

  let inserted = 0;
  let skipped  = 0;
  const unmatched = [];
  const inserted_records = [];

  for (const row of RESULTS) {
    const licKey  = String(row.license).trim();
    let   driver  = byLicense[licKey];

    if (!driver) {
      // Fallback: try name match (firstName + lastName)
      const nameKey1 = `${row.firstName.trim().toLowerCase()} ${row.lastName.trim().toLowerCase()}`;
      const nameKey2 = `${row.lastName.trim().toLowerCase()} ${row.firstName.trim().toLowerCase()}`;
      driver = byName[nameKey1] || byName[nameKey2];
    }

    const r1Pts    = pts(row.r1);
    const r2Pts    = pts(row.r2);
    const r3Pts    = pts(row.r3);
    const totalPts = r1Pts + r2Pts + r3Pts;
    const hasDsq   = row.dsq && (row.dsq.r1 || row.dsq.r2 || row.dsq.r3);
    const dsqNotes = hasDsq
      ? 'DSQ in ' + [row.dsq.r1 && 'R1', row.dsq.r2 && 'R2', row.dsq.r3 && 'R3'].filter(Boolean).join(', ')
      : null;
    const position = row.rnk + (row.rnk === 1 ? 'st' : row.rnk === 2 ? 'nd' : row.rnk === 3 ? 'rd' : 'th');

    if (!driver) {
      unmatched.push(`${row.firstName} ${row.lastName} (lic:${row.license}, ${row.class})`);
      skipped++;
      continue;
    }

    // Determine championship types to record
    // Northern Regions is always regional.
    // ROK NATS drivers also get a 'ROK NATS' scoring row (same points, different table).
    const champTypes = ['Northern Regions'];
    if (driver.championship && driver.championship.toUpperCase().includes('NATS')) {
      champTypes.push('ROK NATS');
    }

    for (const champType of champTypes) {
      const pointsId = uuidv4();
      await pool.query(
        `INSERT INTO points
          (points_id, driver_id, season, event, round, class,
           qualifying_points, heat1_points, heat2_points, final_points,
           penalties_points, total_points, position, notes, championship_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10, $11,$12,$13,$14,$15,$16)`,
        [
          pointsId,
          driver.driver_id,
          EVENT_META.season,
          EVENT_META.name,
          EVENT_META.round,
          row.class,
          0,          // qualifying_points (not in CSV)
          r1Pts,      // heat1_points → Race 1
          r2Pts,      // heat2_points → Race 2
          r3Pts,      // final_points  → Race 3
          0,          // penalties_points
          totalPts,
          position,
          dsqNotes,
          champType,
          'NR_R1_Import'
        ]
      );
      inserted_records.push({
        driver: `${driver.first_name} ${driver.last_name}`,
        class: row.class,
        champType,
        pos: position,
        pts: totalPts
      });
    }
    inserted++;
  }

  // 5. Summary
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✅ Inserted: ${inserted_records.length} records (${inserted} drivers)`);
  console.log(`  ⚠️  Unmatched in DB: ${skipped}\n`);

  if (inserted_records.length > 0) {
    console.log('Inserted records:');
    for (const r of inserted_records) {
      console.log(`  [${r.champType.padEnd(20)}] ${r.driver.padEnd(25)} ${r.class.padEnd(15)} ${r.pos.padStart(4)} — ${r.pts} pts`);
    }
  }

  if (unmatched.length > 0) {
    console.log('\n⚠️  These drivers are in the CSV but NOT registered in the system:');
    for (const u of unmatched) console.log('  -', u);
    console.log('  → They will appear in standings once they register.');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Import complete!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  process.exit(0);
}

main().catch(e => {
  console.error('❌ Fatal error:', e.message);
  process.exit(1);
});
