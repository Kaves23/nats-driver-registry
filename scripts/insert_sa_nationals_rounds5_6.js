/**
 * Insert 2026 SA National Rounds 5 & 6 — Winter Nats (Formula K Raceway, Benoni)
 * Round 5: FK 11-Jul-2026  ->  event = 'SA Nat - FK 11 Jul 2026'
 * Round 6: FK 12-Jul-2026  ->  event = 'SA Nat - FK 12 Jul 2026'
 *
 * championship_type = 'ROK NATS'
 * Source: 2026-SA-National-Rok-Karting-Championship-16.07.2026.pdf (official MSA results sheet)
 * Safe to re-run -- DELETE + re-insert these two events only.
 *
 * Generated from the same driver-ID map used for insert_sa_nationals_rounds3_4.js.
 * Cross-checked: rounds 1-4 in this script's driver map reproduce the DB's existing
 * rounds 1-4 totals exactly (verified against the PDF before writing this file).
 *
 * Run this first to check:  node scripts/insert_sa_nationals_rounds5_6.js --check
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
const RD5 = 'SA Nat - FK 11 Jul 2026';
const RD6 = 'SA Nat - FK 12 Jul 2026';

// New drivers first appearing at Winter Nats -- resolved at runtime via MSA lookup
const NEW_DRIVER_LOOKUPS = [
  { key: 'TIYANI_MALABIE', msa: '44534' },
  { key: 'DECLAN_JURGENS', msa: '30986' },
  { key: 'DURELLE_GOODMAN', msa: '57543' },
  { key: 'JASON_COETZEE', msa: '1445' },
  { key: 'TROY_SNYMAN', msa: '3011' },
];

// Known driver IDs (verified against DB for rounds 1-4 before generating this script)
const D = {
  GRAYSON_VENTER: 'c35dcca7-67f8-4825-ba6c-549a6fdf7107',
  CHRISTOPHER_GRIMMICK: '20473727-ef88-4489-82c6-901b591682e4',
  YERHU_MALABIE: 'ebf00123-f0f6-4a6d-89cd-314a9e8967fc',
  GRANT_WILLIAM: 'cf8ea102-fbf6-4e1f-8f01-30738540a395',
  EWAN_WENTINK: '5241ade1-2c24-4d9d-98f4-dbe5cea9fe12',
  DECLAN_BEROWSKY: '03fde510-b8a0-4501-90a5-043ee7f64fb9',
  JAXON_HOLZAPFEL: '3345992e-62c5-4254-9b7b-f1d6072e2ba6',
  KAYDE_CORNOFSKY: '957ea25a-fc3c-4797-b31e-d971b67d7abb',
  MADDOX_MASON: 'b5e52d27-c8c0-4374-84ca-17a435377426',
  RILEY_VAN_STADEN: '11c7180c-db04-43b7-9c3e-d89a18367efe',
  ZAC_BOSHOFF: 'fc640e8e-2e07-4008-91fa-52670d888f3e',
  RONALD_VENTER: 'b5dfa8b1-43e2-40c9-ab5e-c052cd4a6220',
  PARKER_VAN_DER_MOLEN: '8b3bc844-5a37-42de-bebd-cf16b17b5700',
  HUNTER_NORTH: 'eaa8a06e-4898-4f42-8735-eb137b45f31e',
  OMOLEMO_MFANA: '4ae3ad0b-6f30-490c-8c1e-f8e2364dd8ab',
  DIEGO_BERARDONE: 'c4613c7a-b4bd-4c84-9985-7bbc891e4b90',
  NOAH_CRONJE: '4a6118e8-4afa-4b26-987d-e0036bbb7ae5',
  DIEGO_ANTUNES: '0bbc219e-d415-4ffb-80d2-8bca04108be4',
  EGOR_GRISHIN: 'b0d40e19-b342-42a0-a2b6-67ca555329a2',
  ETHAN_TUTTLEBERG: '77345f09-8cc1-45e8-8e1a-535e4b77db74',
  IGOR_ESTEVES: '59f7b735-746a-4601-af59-bb322444cdd2',
  ITHAN_GUERRAS: '701b413d-0682-4326-a261-6ad70b136759',
  ETHAN_ZITHA: '750d7bfa-f140-4119-88e8-1fc07e095631',
  NICHOLAS_FLEMING: 'aa6de6bf-ea61-453f-94d9-b0557c97c51a',
  MATTAO_MASON: '74cfc3d6-96b5-42ef-8200-0a6e69fd1e87',
  THEKISO_RETLOTLENG: '0bf30fd9-cee1-4cf2-b549-6c99d16a0c12',
  LOGAN_BILLAU: '8cc0750c-c83f-4133-a682-77611e37813d',
  ALEKSANDAR_PRAIZOVIC: 'b88efc5f-e328-4f3c-9706-84c0f9689d71',
  KIYAAN_REDDI: 'cdfafa88-92c5-420c-a591-a51764c127f6',
  MAX_BOSHOFF: '44c5f498-77d5-4802-bd69-5f5fe5f13bb0',
  RUVAN_MARITZ: 'd180f591-e5a5-43ee-b98d-20343a24156e',
  JORDAN_KLAASEN: 'af33e25e-7419-489d-aa26-06cd3132a8df',
  AASHAY_NAGURA: '34506afc-f8ca-45d4-9277-c80f01c6ffe6',
  CHRISTIAAN_MARAIS: '376dc202-aeb2-414c-837f-c39147d9dacf',
  JACK_MOORE: '72cc4190-7d19-4a97-8c02-8722bd143beb',
  CHASE_HASKINS: '22ef5f07-bd58-45b1-af56-7153e46b0ce7',
  AIDAN_CALITZ: '88e0a50d-3f0b-449f-a285-80fea1d3ac2e',
  ASHAAN_REDDI: '294d9933-93fd-4f7e-92f4-44edac689a52',
  EMILE_VAN_DER_WATEREN: 'b6d8feb6-8f24-4181-aef8-c3c38427249e',
  LIAM_PILLAY: 'ef2efd89-61c5-4924-8170-5699fd74e5d9',
  EMMA_ROSE_DOWLING: 'a8f0cb64-1af1-4d72-b52f-31195876b0e7',
};

function buildRows(newIds) {
  const RD5_EVT = RD5, RD6_EVT = RD6;
  return [
    // ---- ROUND 5 (FK 11-Jul) ----
    [5, RD5_EVT, D.DECLAN_BEROWSKY, 'CADET', 32, 35, 35, '1st', null],
    [5, RD5_EVT, D.JAXON_HOLZAPFEL, 'CADET', 35, 32, 32, '2nd', null],
    [5, RD5_EVT, D.CHRISTOPHER_GRIMMICK, 'CADET', 30, 30, 30, '3rd', null],
    [5, RD5_EVT, D.RILEY_VAN_STADEN, 'MINI ROK', 35, 29, 35, '1st', null],
    [5, RD5_EVT, D.MADDOX_MASON, 'MINI ROK', 30, 35, 29, '2nd', null],
    [5, RD5_EVT, D.KAYDE_CORNOFSKY, 'MINI ROK', 32, 32, 28, '3rd', null],
    [5, RD5_EVT, D.ZAC_BOSHOFF, 'MINI ROK', 29, 28, 32, '4th', null],
    [5, RD5_EVT, D.HUNTER_NORTH, 'MINI ROK', 27, 27, 27, '5th', null],
    [5, RD5_EVT, D.PARKER_VAN_DER_MOLEN, 'MINI ROK', 20, 30, 30, '6th', null],
    [5, RD5_EVT, D.OMOLEMO_MFANA, 'MINI ROK', 24, 25, 24, '7th', null],
    [5, RD5_EVT, D.DIEGO_BERARDONE, 'MINI ROK', 26, 18, 26, '8th', null],
    [5, RD5_EVT, D.ETHAN_ZITHA, 'MINI ROK', 22, 23, 23, '9th', null],
    [5, RD5_EVT, D.ITHAN_GUERRAS, 'MINI ROK', 23, 24, 18, '10th', null],
    [5, RD5_EVT, D.MATTAO_MASON, 'OK-J', 35, 35, 35, '1st', null],
    [5, RD5_EVT, D.THEKISO_RETLOTLENG, 'OK-J', 29, 32, 32, '2nd', null],
    [5, RD5_EVT, D.MAX_BOSHOFF, 'OK-J', 32, 30, 28, '3rd', null],
    [5, RD5_EVT, newIds.DECLAN_JURGENS, 'OK-J', 30, 29, 29, '4th', null],
    [5, RD5_EVT, D.LOGAN_BILLAU, 'OK-J', 28, 28, 30, '5th', null],
    [5, RD5_EVT, D.ALEKSANDAR_PRAIZOVIC, 'OK-J', 25, 26, 27, '6th', null],
    [5, RD5_EVT, D.JORDAN_KLAASEN, 'OK-J', 27, 27, 24, '7th', null],
    [5, RD5_EVT, D.RUVAN_MARITZ, 'OK-J', 26, 23, 26, '8th', null],
    [5, RD5_EVT, D.KIYAAN_REDDI, 'OK-J', 23, 25, 25, '9th', null],
    [5, RD5_EVT, D.CHRISTIAAN_MARAIS, 'OK-J', 24, 24, 19, '10th', null],
    [5, RD5_EVT, D.JACK_MOORE, 'OK-N', 35, 35, 32, '1st', null],
    [5, RD5_EVT, D.EMMA_ROSE_DOWLING, 'OK-N', 32, 32, 35, '2nd', null],
    [5, RD5_EVT, D.ASHAAN_REDDI, 'OK-N', 30, 29, 30, '3rd', null],
    [5, RD5_EVT, D.CHASE_HASKINS, 'OK-N', 29, 30, 28, '4th', null],
    [5, RD5_EVT, D.LIAM_PILLAY, 'OK-N', 27, 23, 29, '5th', null],
    [5, RD5_EVT, D.AIDAN_CALITZ, 'OK-N', 28, 28, 23, '6th', null],

    // ---- ROUND 6 (FK 12-Jul) ----
    [6, RD6_EVT, D.CHRISTOPHER_GRIMMICK, 'CADET', 35, 35, 35, '1st', null],
    [6, RD6_EVT, D.MADDOX_MASON, 'MINI ROK', 20, 35, 35, '1st', null],
    [6, RD6_EVT, D.DIEGO_BERARDONE, 'MINI ROK', 30, 30, 30, '2nd', null],
    [6, RD6_EVT, D.RILEY_VAN_STADEN, 'MINI ROK', 32, 29, 28, '3rd', null],
    [6, RD6_EVT, D.KAYDE_CORNOFSKY, 'MINI ROK', 35, 28, 22, '4th', null],
    [6, RD6_EVT, D.ZAC_BOSHOFF, 'MINI ROK', 20, 32, 32, '5th', null],
    [6, RD6_EVT, D.HUNTER_NORTH, 'MINI ROK', 29, 26, 27, '6th', null],
    [6, RD6_EVT, D.NICHOLAS_FLEMING, 'MINI ROK', 28, 25, 25, '7th', null],
    [6, RD6_EVT, D.PARKER_VAN_DER_MOLEN, 'MINI ROK', 20, 27, 29, '8th', null],
    [6, RD6_EVT, D.OMOLEMO_MFANA, 'MINI ROK', 26, 23, 26, '9th', null],
    [6, RD6_EVT, D.ITHAN_GUERRAS, 'MINI ROK', 27, 24, 24, '10th', null],
    [6, RD6_EVT, D.ETHAN_ZITHA, 'MINI ROK', 25, 22, 23, '11th', null],
    [6, RD6_EVT, D.MATTAO_MASON, 'OK-J', 35, 35, 35, '1st', null],
    [6, RD6_EVT, newIds.DECLAN_JURGENS, 'OK-J', 32, 30, 32, '2nd', null],
    [6, RD6_EVT, D.MAX_BOSHOFF, 'OK-J', 30, 29, 30, '3rd', null],
    [6, RD6_EVT, D.THEKISO_RETLOTLENG, 'OK-J', 26, 32, 27, '4th', null],
    [6, RD6_EVT, D.ALEKSANDAR_PRAIZOVIC, 'OK-J', 29, 27, 21, '5th', null],
    [6, RD6_EVT, D.LOGAN_BILLAU, 'OK-J', 28, 19, 29, '6th', null],
    [6, RD6_EVT, D.KIYAAN_REDDI, 'OK-J', 27, 20, 28, '7th', null],
    [6, RD6_EVT, D.JORDAN_KLAASEN, 'OK-J', 23, 24, 26, '8th', null],
    [6, RD6_EVT, D.RUVAN_MARITZ, 'OK-J', 24, 26, 21, '9th', null],
    [6, RD6_EVT, D.CHRISTIAAN_MARAIS, 'OK-J', 25, 25, 0, '10th', null],
    [6, RD6_EVT, D.JACK_MOORE, 'OK-N', 35, 35, 35, '1st', null],
    [6, RD6_EVT, D.LIAM_PILLAY, 'OK-N', 29, 32, 30, '2nd', null],
    [6, RD6_EVT, D.CHASE_HASKINS, 'OK-N', 32, 30, 29, '3rd', null],
    [6, RD6_EVT, D.AIDAN_CALITZ, 'OK-N', 28, 29, 32, '4th', null],
    [6, RD6_EVT, D.ASHAAN_REDDI, 'OK-N', 30, 0, 0, '5th', null],
  ];
}

async function run() {
  console.log('SA National Points 2026 -- Rounds 5 & 6 Insert Script (Winter Nats, FK)');
  if (DRY_RUN) console.log('*** DRY RUN -- no changes will be made ***');

  const newIds = {};
  let lookupFailed = false;
  for (const nd of NEW_DRIVER_LOOKUPS) {
    const res = await pool.query('SELECT driver_id, first_name, last_name FROM drivers WHERE msa_license_number = $1', [nd.msa]);
    if (res.rows.length === 0) {
      console.error('NOT FOUND: ' + nd.key + ' (msa ' + nd.msa + ')');
      lookupFailed = true;
    } else {
      newIds[nd.key] = res.rows[0].driver_id;
      console.log('OK ' + nd.key + ' -> ' + res.rows[0].driver_id + ' (' + res.rows[0].first_name + ' ' + res.rows[0].last_name + ')');
    }
  }
  if (lookupFailed) { console.error('Missing driver lookups, aborting.'); await pool.end(); process.exit(1); }

  const ROWS = buildRows(newIds);
  console.log('Prepared ' + ROWS.length + ' rows for Rounds 5 & 6');

  if (DRY_RUN) {
    for (const [round, event, driverId, cls, h1, h2, final_, pos] of ROWS) {
      const total = h1 + h2 + final_;
      console.log('[Rd' + round + '] ' + cls + ' h1=' + h1 + ' h2=' + h2 + ' f=' + final_ + ' total=' + total + ' pos=' + pos + ' driver=' + driverId.slice(0,8));
    }
    await pool.end();
    return;
  }

  const del = await pool.query(
    "DELETE FROM points WHERE event IN ($1,$2) AND championship_type = $3",
    [RD5, RD6, CHAMP_TYPE]
  );
  console.log('Cleared ' + del.rowCount + ' existing Rd5/Rd6 rows');

  let inserted = 0, errors = 0;
  for (const row of ROWS) {
    const [round, event, driverId, cls, h1, h2, final_, pos, notesOverride] = row;
    const total = h1 + h2 + final_;
    const notes = notesOverride !== null && notesOverride !== undefined ? notesOverride : NOTE_STD;
    try {
      await pool.query(
        `INSERT INTO points
           (points_id, driver_id, season, event, round, class,
            qualifying_points, heat1_points, heat2_points, final_points,
            penalties_points, total_points, position, notes,
            championship_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [uuidv4(), driverId, SEASON, event, round, cls, 0, h1, h2, final_, 0, total, pos, notes, CHAMP_TYPE, 'SA_NAT_Import']
      );
      inserted++;
    } catch (err) {
      errors++;
      console.error('ERROR [Rd' + round + '] ' + cls + ' driver=' + driverId.slice(0,8) + ': ' + err.message);
    }
  }
  console.log('Done -- inserted: ' + inserted + '  errors: ' + errors);
  await pool.end();
}

run().catch(err => { console.error('Fatal error:', err); pool.end(); process.exit(1); });
