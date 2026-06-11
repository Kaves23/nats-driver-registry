/**
 * Insert 2026 Northern Regions Regional Rounds 2 & 3
 * Rd2: RSR 21-Mar-2026  →  event = '2026 NR Rnd 2 - RSR 21 Mar'
 * Rd3: RSR 22-Mar-2026  →  event = '2026 NR Rnd 3 - RSR 22 Mar'
 *
 * championship_type = 'Northern Regions'
 * Safe to re-run — DELETE + re-insert these two events only.
 *
 * NOTE: 11-Apr VKC (Rd4) is CANCELLED.
 * Drop rule: 3 lowest individual heat scores across all rounds.
 *
 * John Duvill (596ebaa1) test entries added for ALL 3 NR rounds
 * (Rd1 included since he has no NR data yet) — mirrors Aleksandar Praizovic.
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

const SEASON    = '2026';
const CHAMP     = 'Northern Regions';
const NOTE      = 'NR Regional Championship';
const NOTE_JOHN = 'NR Regional Championship; TEST ENTRY';
const RD1_EVT   = '2026 NR Rnd 1 - Red Star';   // Rd1 already in DB for most; John needs it too
const RD2_EVT   = '2026 NR Rnd 2 - RSR 21 Mar';
const RD3_EVT   = '2026 NR Rnd 3 - RSR 22 Mar';

// Known driver IDs (all verified from national inserts + DB)
const D = {
  // CADET
  YERHU_MALABIE:        'ebf00123-f0f6-4a6d-89cd-314a9e8967fc',
  CHRISTOPHER_GRIMMICK: '20473727-ef88-4489-82c6-901b591682e4',
  GRAYSON_VENTER:       'c35dcca7-67f8-4825-ba6c-549a6fdf7107',
  GRANT_WILLIAM:        'cf8ea102-fbf6-4e1f-8f01-30738540a395',
  EWAN_WENTINK:         '5241ade1-2c24-4d9d-98f4-dbe5cea9fe12',
  // MINI ROK
  KAYDE_CORNOFSKY:      '957ea25a-fc3c-4797-b31e-d971b67d7abb',
  MADDOX_MASON:         'b5e52d27-c8c0-4374-84ca-17a435377426',
  NOAH_CRONJE:          '4a6118e8-4afa-4b26-987d-e0036bbb7ae5',
  RILEY_VAN_STADEN:     '11c7180c-db04-43b7-9c3e-d89a18367efe',
  ZAC_BOSHOFF:          'fc640e8e-2e07-4008-91fa-52670d888f3e',
  DIEGO_ANTUNES:        '0bbc219e-d415-4ffb-80d2-8bca04108be4',
  DIEGO_BERARDONE:      'c4613c7a-b4bd-4c84-9985-7bbc891e4b90',
  PARKER_VAN_DER_MOLEN: '8b3bc844-5a37-42de-bebd-cf16b17b5700',
  EGOR_GRISHIN:         'b0d40e19-b342-42a0-a2b6-67ca555329a2',
  RONALD_VENTER:        'b5dfa8b1-43e2-40c9-ab5e-c052cd4a6220',
  ETHAN_TUTTLEBERG:     '77345f09-8cc1-45e8-8e1a-535e4b77db74',
  IGOR_ESTEVES:         '59f7b735-746a-4601-af59-bb322444cdd2',
  HUNTER_NORTH:         'eaa8a06e-4898-4f42-8735-eb137b45f31e',
  OMOLEMO_MFANA:        '4ae3ad0b-6f30-490c-8c1e-f8e2364dd8ab',
  // OK-J
  MATTAO_MASON:         '74cfc3d6-96b5-42ef-8200-0a6e69fd1e87',
  ALEKSANDAR_PRAIZOVIC: 'b88efc5f-e328-4f3c-9706-84c0f9689d71',
  THEKISO_RETLOTLENG:   '0bf30fd9-cee1-4cf2-b549-6c99d16a0c12',
  LOGAN_BILLAU:         '8cc0750c-c83f-4133-a682-77611e37813d',
  KIYAAN_REDDI:         'cdfafa88-92c5-420c-a591-a51764c127f6',
  RUVAN_MARITZ:         'd180f591-e5a5-43ee-b98d-20343a24156e',
  AASHAY_NAGURA:        '34506afc-f8ca-45d4-9277-c80f01c6ffe6',
  MAX_BOSHOFF:          '44c5f498-77d5-4802-bd69-5f5fe5f13bb0',
  JORDAN_KLAASEN:       'af33e25e-7419-489d-aa26-06cd3132a8df',
  // OK-N
  JACK_MOORE:           '72cc4190-7d19-4a97-8c02-8722bd143beb',
  EMILE_VAN_DER_WATEREN:'b6d8feb6-8f24-4181-aef8-c3c38427249e',
  CHASE_HASKINS:        '22ef5f07-bd58-45b1-af56-7153e46b0ce7',
  AIDAN_CALITZ:         '88e0a50d-3f0b-449f-a285-80fea1d3ac2e',
  ASHAAN_REDDI:         '294d9933-93fd-4f7e-92f4-44edac689a52',
  // Test
  JOHN_DUVILL:          '596ebaa1-06cd-4324-bdde-3716ef0b9c28',
};

// ─────────────────────────────────────────────────────────────────────────────
// DATA: [round, event, driver_id, class, h1, h2, final, position, notes]
// ─────────────────────────────────────────────────────────────────────────────
const ROWS = [
  // ─── CADET — Rd2 (21-Mar) ────────────────────────────────────────────────
  [2, RD2_EVT, D.YERHU_MALABIE,        'CADET', 35, 35, 35, '1st',  null],
  [2, RD2_EVT, D.CHRISTOPHER_GRIMMICK, 'CADET', 32, 32, 30, '2nd',  null],
  [2, RD2_EVT, D.GRAYSON_VENTER,       'CADET', 30, 30, 32, '3rd',  null],
  [2, RD2_EVT, D.GRANT_WILLIAM,        'CADET', 29, 29, 28, '4th',  null],
  [2, RD2_EVT, D.EWAN_WENTINK,         'CADET',  0,  0,  0, '5th',  null],

  // ─── CADET — Rd3 (22-Mar) ────────────────────────────────────────────────
  [3, RD3_EVT, D.YERHU_MALABIE,        'CADET', 35, 35, 35, '1st',  null],
  [3, RD3_EVT, D.GRAYSON_VENTER,       'CADET', 32, 32, 32, '2nd',  null],
  [3, RD3_EVT, D.CHRISTOPHER_GRIMMICK, 'CADET', 29, 30, 30, '3rd',  null],
  [3, RD3_EVT, D.GRANT_WILLIAM,        'CADET', 30, 29, 29, '4th',  null],
  [3, RD3_EVT, D.EWAN_WENTINK,         'CADET', 28, 28, 28, '5th',  null],

  // ─── MINI ROK — Rd2 (21-Mar) ─────────────────────────────────────────────
  [2, RD2_EVT, D.KAYDE_CORNOFSKY,      'MINI ROK', 35, 35, 35, '1st',  null],
  [2, RD2_EVT, D.RILEY_VAN_STADEN,     'MINI ROK', 32, 32, 30, '2nd',  null],
  [2, RD2_EVT, D.NOAH_CRONJE,          'MINI ROK', 30, 29, 32, '3rd',  null],
  [2, RD2_EVT, D.MADDOX_MASON,         'MINI ROK', 29, 30, 29, '4th',  null],
  [2, RD2_EVT, D.DIEGO_BERARDONE,      'MINI ROK', 27, 28, 28, '5th',  null],
  [2, RD2_EVT, D.ZAC_BOSHOFF,          'MINI ROK', 28, 23, 27, '6th',  null],
  [2, RD2_EVT, D.DIEGO_ANTUNES,        'MINI ROK', 25, 25, 26, '7th',  null],
  [2, RD2_EVT, D.PARKER_VAN_DER_MOLEN, 'MINI ROK', 24, 26, 25, '8th',  null],
  [2, RD2_EVT, D.EGOR_GRISHIN,         'MINI ROK', 26, 27, 21, '9th',  null],
  [2, RD2_EVT, D.ETHAN_TUTTLEBERG,     'MINI ROK', 23, 21, 22, '10th', null],
  [2, RD2_EVT, D.IGOR_ESTEVES,         'MINI ROK', 22, 20, 23, '11th', null],
  [2, RD2_EVT, D.HUNTER_NORTH,         'MINI ROK', 21, 22, 20, '12th', null],
  [2, RD2_EVT, D.RONALD_VENTER,        'MINI ROK', 15, 24, 24, '13th', null],
  [2, RD2_EVT, D.OMOLEMO_MFANA,        'MINI ROK', 20, 19, 19, '14th', null],

  // ─── MINI ROK — Rd3 (22-Mar) ─────────────────────────────────────────────
  [3, RD3_EVT, D.MADDOX_MASON,         'MINI ROK', 35, 35, 35, '1st',  null],
  [3, RD3_EVT, D.NOAH_CRONJE,          'MINI ROK', 32, 30, 32, '2nd',  null],
  [3, RD3_EVT, D.KAYDE_CORNOFSKY,      'MINI ROK', 29, 32, 30, '3rd',  null],
  [3, RD3_EVT, D.ZAC_BOSHOFF,          'MINI ROK', 27, 29, 29, '4th',  null],
  [3, RD3_EVT, D.DIEGO_ANTUNES,        'MINI ROK', 28, 27, 26, '5th',  null],
  [3, RD3_EVT, D.RONALD_VENTER,        'MINI ROK', 25, 28, 27, '6th',  null],
  [3, RD3_EVT, D.RILEY_VAN_STADEN,     'MINI ROK', 30, 19, 28, '7th',  null],
  [3, RD3_EVT, D.DIEGO_BERARDONE,      'MINI ROK', 24, 25, 23, '8th',  null],
  [3, RD3_EVT, D.PARKER_VAN_DER_MOLEN, 'MINI ROK', 23, 23, 25, '9th',  null],
  [3, RD3_EVT, D.EGOR_GRISHIN,         'MINI ROK', 22, 24, 24, '10th', null],
  [3, RD3_EVT, D.ETHAN_TUTTLEBERG,     'MINI ROK', 26, 26, 15, '11th', null],
  [3, RD3_EVT, D.HUNTER_NORTH,         'MINI ROK', 20, 22, 22, '12th', null],
  [3, RD3_EVT, D.IGOR_ESTEVES,         'MINI ROK', 21, 21, 21, '13th', null],
  [3, RD3_EVT, D.OMOLEMO_MFANA,        'MINI ROK', 19, 20, 20, '14th', null],

  // ─── OK-J — Rd2 (21-Mar) ─────────────────────────────────────────────────
  [2, RD2_EVT, D.MATTAO_MASON,         'OK-J', 35, 35, 35, '1st',  null],
  [2, RD2_EVT, D.ALEKSANDAR_PRAIZOVIC, 'OK-J', 32, 32, 30, '2nd',  null],
  [2, RD2_EVT, D.THEKISO_RETLOTLENG,   'OK-J', 29, 30, 32, '3rd',  null],
  [2, RD2_EVT, D.RUVAN_MARITZ,         'OK-J', 25, 29, 28, '4th',  null],
  [2, RD2_EVT, D.LOGAN_BILLAU,         'OK-J', 28, 26, 26, '5th',  null],
  [2, RD2_EVT, D.KIYAAN_REDDI,         'OK-J', 27, 28, 24, '6th',  null],
  [2, RD2_EVT, D.AASHAY_NAGURA,        'OK-J', 26, 25, 25, '7th',  null],
  [2, RD2_EVT, D.MAX_BOSHOFF,          'OK-J', 30,  0, 29, '8th',  null],
  [2, RD2_EVT, D.JORDAN_KLAASEN,       'OK-J',  0, 27, 27, '9th',  'NR Regional Championship; Excl R1'],

  // ─── OK-J — Rd3 (22-Mar) ─────────────────────────────────────────────────
  [3, RD3_EVT, D.MATTAO_MASON,         'OK-J', 35, 35, 35, '1st',  null],
  [3, RD3_EVT, D.MAX_BOSHOFF,          'OK-J', 32, 30, 32, '2nd',  null],
  [3, RD3_EVT, D.THEKISO_RETLOTLENG,   'OK-J', 29, 32, 29, '3rd',  null],
  [3, RD3_EVT, D.ALEKSANDAR_PRAIZOVIC, 'OK-J', 30, 29, 30, '4th',  null],
  [3, RD3_EVT, D.LOGAN_BILLAU,         'OK-J', 28, 28, 27, '5th',  null],
  [3, RD3_EVT, D.KIYAAN_REDDI,         'OK-J', 24, 27, 28, '6th',  null],
  [3, RD3_EVT, D.AASHAY_NAGURA,        'OK-J', 27, 26, 24, '7th',  null],
  [3, RD3_EVT, D.RUVAN_MARITZ,         'OK-J', 25, 25, 25, '8th',  null],
  [3, RD3_EVT, D.JORDAN_KLAASEN,       'OK-J', 26,  0, 26, '9th',  'NR Regional Championship; Excl R2'],

  // ─── OK-N — Rd2 (21-Mar) ─────────────────────────────────────────────────
  [2, RD2_EVT, D.JACK_MOORE,           'OK-N', 29, 35, 35, '1st',  null],
  [2, RD2_EVT, D.CHASE_HASKINS,        'OK-N', 35, 30, 29, '2nd',  null],
  [2, RD2_EVT, D.ASHAAN_REDDI,         'OK-N', 32, 29, 30, '3rd',  null],
  [2, RD2_EVT, D.AIDAN_CALITZ,         'OK-N', 30, 28, 32, '4th',  null],
  [2, RD2_EVT, D.EMILE_VAN_DER_WATEREN,'OK-N', 28, 32, 28, '5th',  null],

  // ─── OK-N — Rd3 (22-Mar) ─────────────────────────────────────────────────
  [3, RD3_EVT, D.JACK_MOORE,           'OK-N', 32, 35, 35, '1st',  null],
  [3, RD3_EVT, D.EMILE_VAN_DER_WATEREN,'OK-N', 35, 32, 32, '2nd',  null],
  [3, RD3_EVT, D.CHASE_HASKINS,        'OK-N', 30, 29, 30, '3rd',  null],
  [3, RD3_EVT, D.AIDAN_CALITZ,         'OK-N', 29, 30, 29, '4th',  null],
  [3, RD3_EVT, D.ASHAAN_REDDI,         'OK-N', 28, 28, 28, '5th',  null],
];

// John Duvill test entries — mirrors Praizovic for ALL 3 NR rounds
// Rd1 included since John has no NR data yet
const JOHN_ROWS = [
  [1, RD1_EVT, D.JOHN_DUVILL, 'OK-J', 28, 32, 32, '2nd', NOTE_JOHN],
  [2, RD2_EVT, D.JOHN_DUVILL, 'OK-J', 32, 32, 30, '2nd', NOTE_JOHN],
  [3, RD3_EVT, D.JOHN_DUVILL, 'OK-J', 30, 29, 30, '4th', NOTE_JOHN],
];

// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   NR Regional Points 2026 — Rounds 2 & 3 Insert Script');
  console.log('   RSR 21-Mar (Rd2) + RSR 22-Mar (Rd3) | championship_type = Northern Regions');
  console.log('   Drop rule: 3 lowest heats overall | 11-Apr VKC CANCELLED');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Step 1 — clear existing Rd2/Rd3 NR data
  const del = await pool.query(
    `DELETE FROM points WHERE event = ANY($1::text[]) AND championship_type = $2`,
    [[RD2_EVT, RD3_EVT], CHAMP]
  );
  console.log(`Step 1 — Cleared ${del.rowCount} existing NR Rd2/Rd3 row(s)\n`);

  // Step 2 — clear John Duvill NR data (all 3 rounds)
  const delJohn = await pool.query(
    `DELETE FROM points WHERE driver_id = $1 AND championship_type = $2`,
    [D.JOHN_DUVILL, CHAMP]
  );
  console.log(`Step 2 — Cleared ${delJohn.rowCount} existing John Duvill NR row(s)\n`);

  let inserted = 0, errors = 0;

  // Step 3 — insert main rows
  console.log('Step 3 — Inserting main rows...');
  for (const row of ROWS) {
    const [round, event, driverId, cls, h1, h2, final_, pos, notesOverride] = row;
    const total = h1 + h2 + final_;
    const notes = notesOverride !== null ? notesOverride : NOTE;
    try {
      await pool.query(
        `INSERT INTO points
           (points_id, driver_id, season, event, round, class,
            qualifying_points, heat1_points, heat2_points, final_points,
            penalties_points, total_points, position, notes,
            championship_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [uuidv4(), driverId, SEASON, event, round, cls,
         0, h1, h2, final_, 0, total, pos, notes, CHAMP, 'NR_Regional_Import']
      );
      inserted++;
      console.log(`  ✅ [Rd${round}] ${cls.padEnd(8)} h1=${h1} h2=${h2} f=${final_} total=${total}  ${pos.padEnd(4)}  ${driverId.slice(0,8)}...`);
    } catch(err) {
      errors++;
      console.error(`  ❌ [Rd${round}] ${cls} driver=${driverId.slice(0,8)}  ERROR: ${err.message}`);
    }
  }

  // Step 4 — insert John Duvill test entries
  console.log('\nStep 4 — Inserting John Duvill test entries (mirror of Praizovic)...');
  for (const row of JOHN_ROWS) {
    const [round, event, driverId, cls, h1, h2, final_, pos, notes] = row;
    const total = h1 + h2 + final_;
    try {
      await pool.query(
        `INSERT INTO points
           (points_id, driver_id, season, event, round, class,
            qualifying_points, heat1_points, heat2_points, final_points,
            penalties_points, total_points, position, notes,
            championship_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [uuidv4(), driverId, SEASON, event, round, cls,
         0, h1, h2, final_, 0, total, pos, notes, CHAMP, 'NR_Regional_Import']
      );
      inserted++;
      console.log(`  ✅ [Rd${round}] John Duvill  h1=${h1} h2=${h2} f=${final_} total=${total}  ${pos}`);
    } catch(err) {
      errors++;
      console.error(`  ❌ John Duvill Rd${round}  ERROR: ${err.message}`);
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
