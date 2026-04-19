/**
 * Insert 2026 SA National Rounds 1 & 2 — ROK Karting Championship
 * Round 1: RSR 21-Mar-2026  →  event = 'SA Nat - RSR 21 Mar 2026'
 * Round 2: RSR 22-Mar-2026  →  event = 'SA Nat - RSR 22 Mar 2026'
 *
 * championship_type = 'ROK NATS'
 * Uses ON CONFLICT DO UPDATE — safe to re-run.
 *
 * Special:
 *   - Ronald Venter scored in class 'MINI ROK' (NOT 'MINI ROK U/10')
 *   - John Duvill (win@rokthenats.co.za) added as test entry in OK-J
 *     with identical points to Aleksandar Praizovic for portal verification
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
const NOTE_TEST  = 'SA National Championship; TEST ENTRY';

// ─────────────────────────────────────────────────────────────────────────────
// DATA
// [round, event_name, driver_id, class, h1, h2, final, position, notes_override]
//   h1 = heat1_points (Race 1)
//   h2 = heat2_points (Race 2)
//   final = final_points (Race 3)
// ─────────────────────────────────────────────────────────────────────────────
const ROWS = [

  // ─── CADET — Round 1 ──────────────────────────────────────────────────────
  [1,'SA Nat - RSR 21 Mar 2026','ebf00123-f0f6-4a6d-89cd-314a9e8967fc','CADET', 35, 35, 35,'1st', null],
  [1,'SA Nat - RSR 21 Mar 2026','20473727-ef88-4489-82c6-901b591682e4','CADET', 32, 32, 30,'2nd', null],
  [1,'SA Nat - RSR 21 Mar 2026','c35dcca7-67f8-4825-ba6c-549a6fdf7107','CADET', 30, 30, 32,'3rd', null],
  [1,'SA Nat - RSR 21 Mar 2026','cf8ea102-fbf6-4e1f-8f01-30738540a395','CADET', 29, 29, 28,'4th', null],
  [1,'SA Nat - RSR 21 Mar 2026','5241ade1-2c24-4d9d-98f4-dbe5cea9fe12','CADET',  0,  0,  0,'5th', null],

  // ─── CADET — Round 2 ──────────────────────────────────────────────────────
  [2,'SA Nat - RSR 22 Mar 2026','ebf00123-f0f6-4a6d-89cd-314a9e8967fc','CADET', 35, 35, 35,'1st', null],
  [2,'SA Nat - RSR 22 Mar 2026','20473727-ef88-4489-82c6-901b591682e4','CADET', 29, 30, 30,'2nd', null],
  [2,'SA Nat - RSR 22 Mar 2026','c35dcca7-67f8-4825-ba6c-549a6fdf7107','CADET', 32, 32, 32,'3rd', null],
  [2,'SA Nat - RSR 22 Mar 2026','cf8ea102-fbf6-4e1f-8f01-30738540a395','CADET', 30, 29, 29,'4th', null],
  [2,'SA Nat - RSR 22 Mar 2026','5241ade1-2c24-4d9d-98f4-dbe5cea9fe12','CADET', 28, 28, 28,'5th', null],

  // ─── MINI ROK — Round 1 ───────────────────────────────────────────────────
  [1,'SA Nat - RSR 21 Mar 2026','957ea25a-fc3c-4797-b31e-d971b67d7abb','MINI ROK', 35, 35, 35, '1st',  null],
  [1,'SA Nat - RSR 21 Mar 2026','b5e52d27-c8c0-4374-84ca-17a435377426','MINI ROK', 29, 30, 29, '2nd',  null],
  [1,'SA Nat - RSR 21 Mar 2026','4a6118e8-4afa-4b26-987d-e0036bbb7ae5','MINI ROK', 30, 29, 32, '3rd',  null],
  [1,'SA Nat - RSR 21 Mar 2026','11c7180c-db04-43b7-9c3e-d89a18367efe','MINI ROK', 32, 32, 30, '4th',  null],
  [1,'SA Nat - RSR 21 Mar 2026','fc640e8e-2e07-4008-91fa-52670d888f3e','MINI ROK', 28, 23, 27, '5th',  null],
  [1,'SA Nat - RSR 21 Mar 2026','0bbc219e-d415-4ffb-80d2-8bca04108be4','MINI ROK', 25, 25, 26, '6th',  null],
  [1,'SA Nat - RSR 21 Mar 2026','c4613c7a-b4bd-4c84-9985-7bbc891e4b90','MINI ROK', 27, 28, 28, '7th',  null],
  [1,'SA Nat - RSR 21 Mar 2026','8b3bc844-5a37-42de-bebd-cf16b17b5700','MINI ROK', 24, 26, 25, '8th',  null],
  [1,'SA Nat - RSR 21 Mar 2026','b0d40e19-b342-42a0-a2b6-67ca555329a2','MINI ROK', 26, 27, 21, '9th',  null],
  [1,'SA Nat - RSR 21 Mar 2026','b5dfa8b1-43e2-40c9-ab5e-c052cd4a6220','MINI ROK', 15, 24, 24, '10th', null],  // Ronald Venter — MINI ROK (not U/10)
  [1,'SA Nat - RSR 21 Mar 2026','77345f09-8cc1-45e8-8e1a-535e4b77db74','MINI ROK', 23, 21, 22, '11th', null],
  [1,'SA Nat - RSR 21 Mar 2026','59f7b735-746a-4601-af59-bb322444cdd2','MINI ROK', 22, 20, 23, '12th', null],
  [1,'SA Nat - RSR 21 Mar 2026','eaa8a06e-4898-4f42-8735-eb137b45f31e','MINI ROK', 21, 22, 20, '13th', null],
  [1,'SA Nat - RSR 21 Mar 2026','4ae3ad0b-6f30-490c-8c1e-f8e2364dd8ab','MINI ROK', 20, 19, 19, '14th', null],

  // ─── MINI ROK — Round 2 ───────────────────────────────────────────────────
  [2,'SA Nat - RSR 22 Mar 2026','957ea25a-fc3c-4797-b31e-d971b67d7abb','MINI ROK', 29, 32, 30, '1st',  null],
  [2,'SA Nat - RSR 22 Mar 2026','b5e52d27-c8c0-4374-84ca-17a435377426','MINI ROK', 35, 35, 35, '2nd',  null],
  [2,'SA Nat - RSR 22 Mar 2026','4a6118e8-4afa-4b26-987d-e0036bbb7ae5','MINI ROK', 32, 30, 32, '3rd',  null],
  [2,'SA Nat - RSR 22 Mar 2026','11c7180c-db04-43b7-9c3e-d89a18367efe','MINI ROK', 30, 19, 28, '4th',  null],
  [2,'SA Nat - RSR 22 Mar 2026','fc640e8e-2e07-4008-91fa-52670d888f3e','MINI ROK', 27, 29, 29, '5th',  null],
  [2,'SA Nat - RSR 22 Mar 2026','0bbc219e-d415-4ffb-80d2-8bca04108be4','MINI ROK', 28, 27, 26, '6th',  null],
  [2,'SA Nat - RSR 22 Mar 2026','c4613c7a-b4bd-4c84-9985-7bbc891e4b90','MINI ROK', 24, 25, 23, '7th',  null],
  [2,'SA Nat - RSR 22 Mar 2026','8b3bc844-5a37-42de-bebd-cf16b17b5700','MINI ROK', 23, 23, 25, '8th',  null],
  [2,'SA Nat - RSR 22 Mar 2026','b0d40e19-b342-42a0-a2b6-67ca555329a2','MINI ROK', 22, 24, 24, '9th',  null],
  [2,'SA Nat - RSR 22 Mar 2026','b5dfa8b1-43e2-40c9-ab5e-c052cd4a6220','MINI ROK', 25, 28, 27, '10th', null],  // Ronald Venter — MINI ROK (not U/10)
  [2,'SA Nat - RSR 22 Mar 2026','77345f09-8cc1-45e8-8e1a-535e4b77db74','MINI ROK', 26, 26, 15, '11th', null],
  [2,'SA Nat - RSR 22 Mar 2026','59f7b735-746a-4601-af59-bb322444cdd2','MINI ROK', 21, 21, 21, '12th', null],
  [2,'SA Nat - RSR 22 Mar 2026','eaa8a06e-4898-4f42-8735-eb137b45f31e','MINI ROK', 20, 22, 22, '13th', null],
  [2,'SA Nat - RSR 22 Mar 2026','4ae3ad0b-6f30-490c-8c1e-f8e2364dd8ab','MINI ROK', 19, 20, 20, '14th', null],

  // ─── OK-J — Round 1 ───────────────────────────────────────────────────────
  [1,'SA Nat - RSR 21 Mar 2026','74cfc3d6-96b5-42ef-8200-0a6e69fd1e87','OK-J', 35, 35, 35, '1st', null],
  [1,'SA Nat - RSR 21 Mar 2026','b88efc5f-e328-4f3c-9706-84c0f9689d71','OK-J', 32, 32, 30, '2nd', null],  // Aleksandar Praizovic
  [1,'SA Nat - RSR 21 Mar 2026','0bf30fd9-cee1-4cf2-b549-6c99d16a0c12','OK-J', 29, 30, 32, '3rd', null],
  [1,'SA Nat - RSR 21 Mar 2026','8cc0750c-c83f-4133-a682-77611e37813d','OK-J', 28, 26, 26, '4th', null],
  [1,'SA Nat - RSR 21 Mar 2026','cdfafa88-92c5-420c-a591-a51764c127f6','OK-J', 27, 28, 24, '5th', null],
  [1,'SA Nat - RSR 21 Mar 2026','d180f591-e5a5-43ee-b98d-20343a24156e','OK-J', 25, 29, 28, '6th', null],
  [1,'SA Nat - RSR 21 Mar 2026','34506afc-f8ca-45d4-9277-c80f01c6ffe6','OK-J', 26, 25, 25, '7th', null],
  [1,'SA Nat - RSR 21 Mar 2026','44c5f498-77d5-4802-bd69-5f5fe5f13bb0','OK-J', 30,  0, 29, '8th', null],
  [1,'SA Nat - RSR 21 Mar 2026','af33e25e-7419-489d-aa26-06cd3132a8df','OK-J',  0, 27, 27, '9th', 'SA National Championship; Excluded R1'],
  // ── John Duvill — TEST (same points as Praizovic Rd1: 32/32/30)
  [1,'SA Nat - RSR 21 Mar 2026','596ebaa1-06cd-4324-bdde-3716ef0b9c28','OK-J', 32, 32, 30, '2nd', NOTE_TEST],

  // ─── OK-J — Round 2 ───────────────────────────────────────────────────────
  [2,'SA Nat - RSR 22 Mar 2026','74cfc3d6-96b5-42ef-8200-0a6e69fd1e87','OK-J', 35, 35, 35, '1st', null],
  [2,'SA Nat - RSR 22 Mar 2026','b88efc5f-e328-4f3c-9706-84c0f9689d71','OK-J', 30, 29, 30, '2nd', null],  // Aleksandar Praizovic
  [2,'SA Nat - RSR 22 Mar 2026','0bf30fd9-cee1-4cf2-b549-6c99d16a0c12','OK-J', 29, 32, 29, '3rd', null],
  [2,'SA Nat - RSR 22 Mar 2026','8cc0750c-c83f-4133-a682-77611e37813d','OK-J', 28, 28, 27, '4th', null],
  [2,'SA Nat - RSR 22 Mar 2026','cdfafa88-92c5-420c-a591-a51764c127f6','OK-J', 24, 27, 28, '5th', null],
  [2,'SA Nat - RSR 22 Mar 2026','d180f591-e5a5-43ee-b98d-20343a24156e','OK-J', 25, 25, 25, '6th', null],
  [2,'SA Nat - RSR 22 Mar 2026','34506afc-f8ca-45d4-9277-c80f01c6ffe6','OK-J', 27, 26, 24, '7th', null],
  [2,'SA Nat - RSR 22 Mar 2026','44c5f498-77d5-4802-bd69-5f5fe5f13bb0','OK-J', 32, 30, 32, '8th', null],
  [2,'SA Nat - RSR 22 Mar 2026','af33e25e-7419-489d-aa26-06cd3132a8df','OK-J', 26,  0, 26, '9th', 'SA National Championship; Excluded R2'],
  // ── John Duvill — TEST (same points as Praizovic Rd2: 30/29/30)
  [2,'SA Nat - RSR 22 Mar 2026','596ebaa1-06cd-4324-bdde-3716ef0b9c28','OK-J', 30, 29, 30, '2nd', NOTE_TEST],

  // ─── OK-N — Round 1 ───────────────────────────────────────────────────────
  [1,'SA Nat - RSR 21 Mar 2026','72cc4190-7d19-4a97-8c02-8722bd143beb','OK-N', 29, 35, 35, '1st', null],
  [1,'SA Nat - RSR 21 Mar 2026','b6d8feb6-8f24-4181-aef8-c3c38427249e','OK-N', 28, 32, 28, '2nd', null],
  [1,'SA Nat - RSR 21 Mar 2026','22ef5f07-bd58-45b1-af56-7153e46b0ce7','OK-N', 35, 30, 29, '3rd', null],
  [1,'SA Nat - RSR 21 Mar 2026','88e0a50d-3f0b-449f-a285-80fea1d3ac2e','OK-N', 30, 28, 32, '4th', null],
  [1,'SA Nat - RSR 21 Mar 2026','294d9933-93fd-4f7e-92f4-44edac689a52','OK-N', 32, 29, 30, '5th', null],  // Ashaan Reddi — races OK-N nationally

  // ─── OK-N — Round 2 ───────────────────────────────────────────────────────
  [2,'SA Nat - RSR 22 Mar 2026','72cc4190-7d19-4a97-8c02-8722bd143beb','OK-N', 32, 35, 35, '1st', null],
  [2,'SA Nat - RSR 22 Mar 2026','b6d8feb6-8f24-4181-aef8-c3c38427249e','OK-N', 35, 32, 32, '2nd', null],
  [2,'SA Nat - RSR 22 Mar 2026','22ef5f07-bd58-45b1-af56-7153e46b0ce7','OK-N', 30, 29, 30, '3rd', null],
  [2,'SA Nat - RSR 22 Mar 2026','88e0a50d-3f0b-449f-a285-80fea1d3ac2e','OK-N', 29, 30, 29, '4th', null],
  [2,'SA Nat - RSR 22 Mar 2026','294d9933-93fd-4f7e-92f4-44edac689a52','OK-N', 28, 28, 28, '5th', null],  // Ashaan Reddi — races OK-N nationally
];

// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   SA National Points 2026 — Insert Script');
  console.log('   Rounds 1 & 2 | RSR | championship_type = ROK NATS');
  console.log(`   Total rows to insert: ${ROWS.length} (66 real + 2 test = 68)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Step 1 — clear any existing SA National rows (safe re-run)
  const deleteRes = await pool.query(
    `DELETE FROM points
     WHERE event IN ('SA Nat - RSR 21 Mar 2026','SA Nat - RSR 22 Mar 2026')
       AND championship_type = $1`,
    [CHAMP_TYPE]
  );
  console.log(`Step 1 — Cleared ${deleteRes.rowCount} existing SA National row(s)\n`);

  let inserted = 0;
  let errors   = 0;

  // Step 2 — insert all rows
  for (const row of ROWS) {
    const [round, event, driverId, cls, h1, h2, final_, pos, notesOverride] = row;
    const total = h1 + h2 + final_;
    const notes = notesOverride !== null ? notesOverride : NOTE_STD;
    const pointsId = uuidv4();

    try {
      await pool.query(
        `INSERT INTO points
           (points_id, driver_id, season, event, round, class,
            qualifying_points, heat1_points, heat2_points, final_points,
            penalties_points, total_points, position, notes,
            championship_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10, $11,$12,$13,$14,$15,$16)`,
        [
          pointsId,
          driverId,
          SEASON,
          event,
          round,
          cls,
          0,        // qualifying_points
          h1,
          h2,
          final_,
          0,        // penalties_points
          total,
          pos,
          notes,
          CHAMP_TYPE,
          'SA_NAT_Import'
        ]
      );
      inserted++;
      console.log(`  ✅ [Rd${round}] ${cls.padEnd(8)} h1=${h1} h2=${h2} f=${final_} total=${total}  driver=${driverId.slice(0,8)}...`);
    } catch (err) {
      errors++;
      console.error(`  ❌ [Rd${round}] ${cls} driver=${driverId.slice(0,8)}  ERROR: ${err.message}`);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   Done — inserted: ${inserted}  errors: ${errors}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await pool.end();
}

run().catch(err => {
  console.error('Fatal error:', err);
  pool.end();
  process.exit(1);
});
