/**
 * Insert 2026 SA National Rounds 3 & 4 — Autumn Nats (VKC)
 * Round 3: VKC 09-May-2026  →  event = 'SA Nat - VKC 09 May 2026'
 * Round 4: VKC 10-May-2026  →  event = 'SA Nat - VKC 10 May 2026'
 *
 * championship_type = 'ROK NATS'
 * Safe to re-run — DELETE + re-insert these two events only.
 *
 * ⚠ NEW DRIVERS (first appeared at Autumn Nats — driver_ids need to be confirmed):
 *   - Tiyani Malabie     CADET     MSA 44534  race#29
 *   - Declan Jurgens     OK-J      MSA 30986  race#63
 *   - Durelle Goodman    OK-J      MSA 57543  race#47
 *   - Jason Coetzee      OK-N      MSA 1445   race#77
 *   - Troy Snyman        OK-N      MSA 3011   race#21
 *
 * Run this first to check:  node scripts/insert_sa_nationals_rounds3_4.js --check
 * Then run without flag to insert.
 */

require('dotenv').config();
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user:     process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl:      { rejectUnauthorized: false }
});

const SEASON     = '2026';
const CHAMP_TYPE = 'ROK NATS';
const NOTE_STD   = 'SA National Championship';
const DRY_RUN    = process.argv.includes('--check');

// ─────────────────────────────────────────────────────────────────────────────
// NEW DRIVER MSA LICENCE NUMBERS — looked up at runtime
// ─────────────────────────────────────────────────────────────────────────────
const NEW_DRIVER_LOOKUPS = [
  { key: 'TIYANI_MALABIE',   msa: '44534', race_number: '29', class: 'CADET',   name: 'Tiyani Malabie'  },
  { key: 'DECLAN_JURGENS',   msa: '30986', race_number: '63', class: 'OK-J',    name: 'Declan Jurgens'  },
  { key: 'DURELLE_GOODMAN',  msa: '57543', race_number: '47', class: 'OK-J',    name: 'Durelle Goodman' },
  { key: 'JASON_COETZEE',    msa: '1445',  race_number: '77', class: 'OK-N',    name: 'Jason Coetzee'   },
  { key: 'TROY_SNYMAN',      msa: '3011',  race_number: '21', class: 'OK-N',    name: 'Troy Snyman'     },
];

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN DRIVER IDs (from Rounds 1 & 2 — already verified)
// ─────────────────────────────────────────────────────────────────────────────
const D = {
  // CADET
  GRAYSON_VENTER:       'c35dcca7-67f8-4825-ba6c-549a6fdf7107',
  // MINI ROK
  KAYDE_CORNOFSKY:      '957ea25a-fc3c-4797-b31e-d971b67d7abb',
  MADDOX_MASON:         'b5e52d27-c8c0-4374-84ca-17a435377426',
  RILEY_VAN_STADEN:     '11c7180c-db04-43b7-9c3e-d89a18367efe',
  ZAC_BOSHOFF:          'fc640e8e-2e07-4008-91fa-52670d888f3e',
  RONALD_VENTER:        'b5dfa8b1-43e2-40c9-ab5e-c052cd4a6220',
  PARKER_VAN_DER_MOLEN: '8b3bc844-5a37-42de-bebd-cf16b17b5700',
  HUNTER_NORTH:         'eaa8a06e-4898-4f42-8735-eb137b45f31e',
  OMOLEMO_MFANA:        '4ae3ad0b-6f30-490c-8c1e-f8e2364dd8ab',
  DIEGO_BERARDONE:      'c4613c7a-b4bd-4c84-9985-7bbc891e4b90',
  // OKJ
  MATTAO_MASON:         '74cfc3d6-96b5-42ef-8200-0a6e69fd1e87',
  THEKISO_RETLOTLENG:   '0bf30fd9-cee1-4cf2-b549-6c99d16a0c12',
  LOGAN_BILLAU:         '8cc0750c-c83f-4133-a682-77611e37813d',
  ALEKSANDAR_PRAIZOVIC: 'b88efc5f-e328-4f3c-9706-84c0f9689d71',
  KIYAAN_REDDI:         'cdfafa88-92c5-420c-a591-a51764c127f6',
  MAX_BOSHOFF:          '44c5f498-77d5-4802-bd69-5f5fe5f13bb0',
  RUVAN_MARITZ:         'd180f591-e5a5-43ee-b98d-20343a24156e',
  JORDAN_KLAASEN:       'af33e25e-7419-489d-aa26-06cd3132a8df',
  AASHAY_NAGURA:        '34506afc-f8ca-45d4-9277-c80f01c6ffe6',
  // OK-N
  JACK_MOORE:           '72cc4190-7d19-4a97-8c02-8722bd143beb',
  CHASE_HASKINS:        '22ef5f07-bd58-45b1-af56-7153e46b0ce7',
  AIDAN_CALITZ:         '88e0a50d-3f0b-449f-a285-80fea1d3ac2e',
  ASHAAN_REDDI:         '294d9933-93fd-4f7e-92f4-44edac689a52',
  EMILE_VAN_DER_WATEREN:'b6d8feb6-8f24-4181-aef8-c3c38427249e',
};

// ─────────────────────────────────────────────────────────────────────────────
// DATA rows — [round, event_name, driver_key_or_id, class, h1, h2, final, position, notes]
// New driver keys prefixed with '$' are resolved at runtime via DB lookup
// ─────────────────────────────────────────────────────────────────────────────
function buildRows(newIds) {
  const RD3 = 'SA Nat - VKC 09 May 2026';
  const RD4 = 'SA Nat - VKC 10 May 2026';

  return [
    // ─── CADET — Round 3 (VKC 09-May) ───────────────────────────────────────
    // Only 2 scored; rest DNS'd this round
    [3, RD3, D.GRAYSON_VENTER,           'CADET',    35, 35, 35, '1st',  null],
    [3, RD3, newIds.TIYANI_MALABIE,      'CADET',    32,  0,  0, '2nd',  null],

    // ─── CADET — Round 4 (VKC 10-May) ───────────────────────────────────────
    [4, RD4, D.GRAYSON_VENTER,           'CADET',    35, 35, 35, '1st',  null],

    // ─── MINI ROK — Round 3 (VKC 09-May) ────────────────────────────────────
    // Round subtotals: Kayde=100, Maddox=94, Riley=92, Ronald=88, Omolemo=81, Zac=80, Hunter=80, Parker=74
    [3, RD3, D.KAYDE_CORNOFSKY,          'MINI ROK', 35, 35, 30, '1st',  null],
    [3, RD3, D.MADDOX_MASON,             'MINI ROK', 32, 30, 32, '2nd',  null],
    [3, RD3, D.RILEY_VAN_STADEN,         'MINI ROK', 29, 28, 35, '3rd',  null],
    [3, RD3, D.RONALD_VENTER,            'MINI ROK', 30, 29, 29, '4th',  null],
    [3, RD3, D.OMOLEMO_MFANA,            'MINI ROK', 27, 26, 28, '5th',  null],
    [3, RD3, D.ZAC_BOSHOFF,              'MINI ROK', 26, 32, 22, '6th',  null],
    [3, RD3, D.HUNTER_NORTH,             'MINI ROK', 28, 25, 27, '7th',  null],
    [3, RD3, D.PARKER_VAN_DER_MOLEN,     'MINI ROK', 25, 27, 22, '8th',  null],

    // ─── MINI ROK — Round 4 (VKC 10-May) ────────────────────────────────────
    // Round subtotals: Kayde=102, Riley=92, Maddox=91, Zac=89, DiegoB=85, Ronald=81, Hunter=80, Parker=71, Omolemo=69
    [4, RD4, D.KAYDE_CORNOFSKY,          'MINI ROK', 32, 35, 35, '1st',  null],
    [4, RD4, D.RILEY_VAN_STADEN,         'MINI ROK', 30, 32, 30, '2nd',  null],
    [4, RD4, D.MADDOX_MASON,             'MINI ROK', 35, 27, 29, '3rd',  null],
    [4, RD4, D.ZAC_BOSHOFF,              'MINI ROK', 29, 28, 32, '4th',  null],
    [4, RD4, D.DIEGO_BERARDONE,          'MINI ROK', 28, 30, 27, '5th',  null],
    [4, RD4, D.RONALD_VENTER,            'MINI ROK', 27, 26, 28, '6th',  null],
    [4, RD4, D.HUNTER_NORTH,             'MINI ROK', 26, 29, 25, '7th',  null],
    [4, RD4, D.PARKER_VAN_DER_MOLEN,     'MINI ROK', 25, 20, 26, '8th',  null],
    [4, RD4, D.OMOLEMO_MFANA,            'MINI ROK', 20, 25, 24, '9th',  null],

    // ─── OK-J — Round 3 (VKC 09-May) ────────────────────────────────────────
    // Round subtotals: Mattao=105, Declan=96, Logan=90, Kiyaan=83, Thekiso=79, Ruvan=75, Aleksandar=73, Max=69, Durelle=63, Jordan=57
    [3, RD3, D.MATTAO_MASON,             'OK-J', 35, 35, 35, '1st',  null],
    [3, RD3, newIds.DECLAN_JURGENS,      'OK-J', 32, 32, 32, '2nd',  null],
    [3, RD3, D.LOGAN_BILLAU,             'OK-J', 30, 30, 30, '3rd',  null],
    [3, RD3, D.KIYAAN_REDDI,             'OK-J', 28, 28, 27, '4th',  null],
    [3, RD3, D.THEKISO_RETLOTLENG,       'OK-J', 23, 27, 29, '5th',  null],
    [3, RD3, D.RUVAN_MARITZ,             'OK-J', 29, 26, 20, '6th',  null],
    [3, RD3, D.ALEKSANDAR_PRAIZOVIC,     'OK-J', 23, 25, 25, '7th',  null],
    [3, RD3, D.MAX_BOSHOFF,              'OK-J', 23, 20, 26, '8th',  null],
    [3, RD3, newIds.DURELLE_GOODMAN,     'OK-J', 23, 20, 20, '9th',  null],
    [3, RD3, D.JORDAN_KLAASEN,           'OK-J',  0, 29, 28, '10th', 'SA National Championship; DNS R1'],

    // ─── OK-J — Round 4 (VKC 10-May) ────────────────────────────────────────
    // Round subtotals: Mattao=105, Max=91, Logan=87, Declan=87, Thekiso=85, Ruvan=78, Kiyaan=77, Jordan=77, Aleksandar=69, Durelle=66
    [4, RD4, D.MATTAO_MASON,             'OK-J', 35, 35, 35, '1st',  null],
    [4, RD4, D.MAX_BOSHOFF,              'OK-J', 32, 30, 29, '2nd',  null],
    [4, RD4, D.LOGAN_BILLAU,             'OK-J', 25, 32, 30, '3rd',  null],
    [4, RD4, newIds.DECLAN_JURGENS,      'OK-J', 28, 27, 32, '4th',  null],
    [4, RD4, D.THEKISO_RETLOTLENG,       'OK-J', 29, 29, 27, '5th',  null],
    [4, RD4, D.RUVAN_MARITZ,             'OK-J', 30, 20, 28, '6th',  null],
    [4, RD4, D.KIYAAN_REDDI,             'OK-J', 27, 26, 24, '7th',  null],
    [4, RD4, D.JORDAN_KLAASEN,           'OK-J', 26, 25, 26, '8th',  null],
    [4, RD4, D.ALEKSANDAR_PRAIZOVIC,     'OK-J', 24, 20, 25, '9th',  null],
    [4, RD4, newIds.DURELLE_GOODMAN,     'OK-J', 19, 28, 19, '10th', null],

    // ─── OK-N — Round 3 (VKC 09-May) ────────────────────────────────────────
    // Round subtotals: Jack=97, Troy=97, Aidan=92, Chase=90, Jason=85, Ashaan=82
    [3, RD3, D.JACK_MOORE,               'OK-N', 30, 32, 35, '1st',  null],
    [3, RD3, newIds.TROY_SNYMAN,         'OK-N', 35, 30, 32, '2nd',  null],
    [3, RD3, D.AIDAN_CALITZ,             'OK-N', 27, 35, 30, '3rd',  null],
    [3, RD3, D.CHASE_HASKINS,            'OK-N', 32, 29, 29, '4th',  null],
    [3, RD3, newIds.JASON_COETZEE,       'OK-N', 29, 28, 28, '5th',  null],
    [3, RD3, D.ASHAAN_REDDI,             'OK-N', 28, 27, 27, '6th',  null],

    // ─── OK-N — Round 4 (VKC 10-May) ────────────────────────────────────────
    // Round subtotals: Aidan=94, Jason=94, Jack=91, Chase=91, Ashaan=88; Troy=excl(0)
    [4, RD4, D.AIDAN_CALITZ,             'OK-N', 30, 32, 32, '1st',  null],
    [4, RD4, newIds.JASON_COETZEE,       'OK-N', 24, 35, 35, '2nd',  null],
    [4, RD4, D.JACK_MOORE,               'OK-N', 35, 28, 28, '3rd',  null],
    [4, RD4, D.CHASE_HASKINS,            'OK-N', 32, 29, 30, '4th',  null],
    [4, RD4, D.ASHAAN_REDDI,             'OK-N', 29, 30, 29, '5th',  null],
    [4, RD4, newIds.TROY_SNYMAN,         'OK-N',  0,  0,  0, '6th',  'SA National Championship; Excluded Rd4'],
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   SA National Points 2026 — Rounds 3 & 4 Insert Script');
  console.log('   VKC 09-May (Rd3) + VKC 10-May (Rd4) | championship_type = ROK NATS');
  if (DRY_RUN) console.log('   *** DRY RUN — no changes will be made ***');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ── Step 1: Look up new driver IDs ──────────────────────────────────────
  console.log('Step 1 — Resolving new driver IDs from DB...\n');
  const newIds = {};
  let lookupFailed = false;

  for (const nd of NEW_DRIVER_LOOKUPS) {
    const res = await pool.query(
      `SELECT driver_id, first_name, last_name, race_number
       FROM drivers
       WHERE msa_license_number = $1
       LIMIT 2`,
      [nd.msa]
    );

    if (res.rows.length === 0) {
      console.error(`  ❌ NOT FOUND in DB: ${nd.name} (MSA ${nd.msa}, race#${nd.race_number}, ${nd.class})`);
      lookupFailed = true;
    } else if (res.rows.length > 1) {
      console.warn(`  ⚠ MULTIPLE MATCHES: ${nd.name} (MSA ${nd.msa}) — using first:`);
      res.rows.forEach(r => console.warn(`     ${r.driver_id}  ${r.first_name} ${r.last_name}  race#${r.race_number}`));
      newIds[nd.key] = res.rows[0].driver_id;
    } else {
      const r = res.rows[0];
      console.log(`  ✅ ${nd.name.padEnd(22)} → ${r.driver_id}  (${r.first_name} ${r.last_name}  race#${r.race_number})`);
      newIds[nd.key] = r.driver_id;
    }
  }

  if (lookupFailed) {
    console.error('\n❌ One or more new drivers not found in DB. Add them first, then re-run.\n');
    await pool.end();
    process.exit(1);
  }

  // ── Step 2: Verify existing round 1&2 data is present ───────────────────
  console.log('\nStep 2 — Checking rounds 1 & 2 already exist...\n');
  const existing = await pool.query(
    `SELECT COUNT(*) as cnt FROM points
     WHERE event IN ('SA Nat - RSR 21 Mar 2026','SA Nat - RSR 22 Mar 2026')
       AND championship_type = $1`,
    [CHAMP_TYPE]
  );
  const existingCount = parseInt(existing.rows[0].cnt);
  if (existingCount === 0) {
    console.warn('  ⚠ WARNING: No Round 1/2 rows found! Run insert_sa_nationals_2026.js first.\n');
  } else {
    console.log(`  ✅ Found ${existingCount} rows for Rounds 1 & 2\n`);
  }

  // ── Step 3: Build + preview rows ────────────────────────────────────────
  const ROWS = buildRows(newIds);
  console.log(`Step 3 — Prepared ${ROWS.length} rows for Rounds 3 & 4\n`);

  const byClass = {};
  for (const [, , , cls] of ROWS) {
    byClass[cls] = (byClass[cls] || 0) + 1;
  }
  Object.entries(byClass).forEach(([cls, n]) => console.log(`  ${cls.padEnd(10)} ${n} rows`));
  console.log();

  if (DRY_RUN) {
    console.log('DRY RUN — listing all rows:\n');
    for (const [round, event, driverId, cls, h1, h2, final_, pos] of ROWS) {
      const total = h1 + h2 + final_;
      console.log(`  [Rd${round}] ${cls.padEnd(9)} h1=${String(h1).padStart(2)} h2=${String(h2).padStart(2)} f=${String(final_).padStart(2)} total=${String(total).padStart(3)}  pos=${String(pos).padEnd(4)}  driver=${driverId.slice(0,8)}...`);
    }
    console.log('\nDry run complete. Re-run without --check to insert.\n');
    await pool.end();
    return;
  }

  // ── Step 4: Clear existing Rd3/Rd4 rows (safe re-run) ───────────────────
  const del = await pool.query(
    `DELETE FROM points
     WHERE event IN ('SA Nat - VKC 09 May 2026','SA Nat - VKC 10 May 2026')
       AND championship_type = $1`,
    [CHAMP_TYPE]
  );
  console.log(`Step 4 — Cleared ${del.rowCount} existing Rd3/Rd4 rows\n`);

  // ── Step 5: Insert ───────────────────────────────────────────────────────
  let inserted = 0;
  let errors   = 0;

  for (const row of ROWS) {
    const [round, event, driverId, cls, h1, h2, final_, pos, notesOverride] = row;
    const total  = h1 + h2 + final_;
    const notes  = notesOverride !== null && notesOverride !== undefined ? notesOverride : NOTE_STD;
    const pid    = uuidv4();

    try {
      await pool.query(
        `INSERT INTO points
           (points_id, driver_id, season, event, round, class,
            qualifying_points, heat1_points, heat2_points, final_points,
            penalties_points, total_points, position, notes,
            championship_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [pid, driverId, SEASON, event, round, cls,
         0, h1, h2, final_, 0, total, pos, notes, CHAMP_TYPE, 'SA_NAT_Import']
      );
      inserted++;
      console.log(`  ✅ [Rd${round}] ${cls.padEnd(9)} h1=${String(h1).padStart(2)} h2=${String(h2).padStart(2)} f=${String(final_).padStart(2)} total=${String(total).padStart(3)}  pos=${String(pos).padEnd(4)}  driver=${driverId.slice(0,8)}...`);
    } catch (err) {
      errors++;
      console.error(`  ❌ [Rd${round}] ${cls} driver=${driverId.slice(0,8)}  ERROR: ${err.message}`);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   Done — inserted: ${inserted}  errors: ${errors}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await pool.end();
}

run().catch(err => {
  console.error('Fatal error:', err);
  pool.end();
  process.exit(1);
});
