/**
 * Insert 2026 SA National Round 7 - Spring Nats (Killarney).
 *
 * Run first with --check. Without --check, the script validates every driver,
 * then transactionally replaces only 2026 ROK NATS Round 7 rows.
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

const SEASON = '2026';
const ROUND = 7;
const EVENT = 'SA Nat - Killarney 11 Sep 2026';
const CHAMP_TYPE = 'ROK NATS';
const NOTE = 'SA National Championship';
const DRY_RUN = process.argv.includes('--check');

// [driver_id, class, heat 1, heat 2, final, position]
const ROWS = [
  ['c35dcca7-67f8-4825-ba6c-549a6fdf7107', 'CADET', 35, 35, 32, '1st'],
  ['9ebeb1aa-0a36-4dc7-9d1d-12b04ea82a14', 'CADET', 32, 29, 35, '2nd'],
  ['20473727-ef88-4489-82c6-901b591682e4', 'CADET', 30, 32, 30, '3rd'],
  ['ccfb1213-cd31-4ad0-9767-83df8822262f', 'CADET', 29, 30, 29, '4th'],

  ['957ea25a-fc3c-4797-b31e-d971b67d7abb', 'MINI ROK', 35, 29, 32, '1st'],
  ['11c7180c-db04-43b7-9c3e-d89a18367efe', 'MINI ROK', 32, 26, 35, '2nd'],
  ['4a6118e8-4afa-4b26-987d-e0036bbb7ae5', 'MINI ROK', 27, 32, 30, '3rd'],
  ['fc640e8e-2e07-4008-91fa-52670d888f3e', 'MINI ROK', 30, 35, 20, '4th'],
  ['9c6a2508-e8e2-441f-a623-2366f420a5bc', 'MINI ROK', 28, 28, 29, '5th'],
  ['8b3bc844-5a37-42de-bebd-cf16b17b5700', 'MINI ROK', 25, 27, 28, '6th'],
  ['b5e52d27-c8c0-4374-84ca-17a435377426', 'MINI ROK', 29, 30, 20, '7th'],
  ['c4613c7a-b4bd-4c84-9985-7bbc891e4b90', 'MINI ROK', 26, 25, 27, '8th'],
  ['eaa8a06e-4898-4f42-8735-eb137b45f31e', 'MINI ROK', 24, 24, 26, '9th'],
  ['701b413d-0682-4326-a261-6ad70b136759', 'MINI ROK', 23, 23, 25, '10th'],

  ['3910e613-d031-4680-b387-b3b3bf78eff4', 'OK-J', 35, 27, 35, '1st'],
  ['b88efc5f-e328-4f3c-9706-84c0f9689d71', 'OK-J', 30, 35, 25, '2nd'],
  ['0bf30fd9-cee1-4cf2-b549-6c99d16a0c12', 'OK-J', 28, 32, 28, '3rd'],
  ['d180f591-e5a5-43ee-b98d-20343a24156e', 'OK-J', 26, 29, 30, '4th'],
  ['5e805039-ac6a-44ca-bbd2-f88048dc6ab5', 'OK-J', 27, 28, 29, '5th'],
  ['8cc0750c-c83f-4133-a682-77611e37813d', 'OK-J', 29, 30, 20, '6th'],
  ['44c5f498-77d5-4802-bd69-5f5fe5f13bb0', 'OK-J', 32, 24, 20, '7th'],
  ['af33e25e-7419-489d-aa26-06cd3132a8df', 'OK-J', 24, 26, 26, '8th'],
  ['376dc202-aeb2-414c-837f-c39147d9dacf', 'OK-J', 25, 23, 27, '9th'],
  ['74cfc3d6-96b5-42ef-8200-0a6e69fd1e87', 'OK-J', null, 25, 32, '10th'],

  ['72cc4190-7d19-4a97-8c02-8722bd143beb', 'OK-N', 35, 24, 35, '1st'],
  ['728d3bc7-37d9-4a76-97e2-03e1c62eb5a5', 'OK-N', 29, 32, 32, '2nd'],
  ['34506afc-f8ca-45d4-9277-c80f01c6ffe6', 'OK-N', 24, 35, 30, '3rd'],
  ['ef2efd89-61c5-4924-8170-5699fd74e5d9', 'OK-N', 32, 30, 27, '4th'],
  ['88e0a50d-3f0b-449f-a285-80fea1d3ac2e', 'OK-N', 30, 29, 29, '5th'],
  ['b5053721-bb2b-4079-bca8-5ef5c2d35a97', 'OK-N', 24, 0, 28, '6th'],
  ['aa31f13d-8f80-45ed-859f-31f15bed6fe9', 'OK-N', null, 0, 0, '7th']
];

const heatValue = (value) => value == null ? 0 : value;

async function run() {
  const ids = ROWS.map((row) => row[0]);
  const drivers = await pool.query(
    `SELECT driver_id, first_name, last_name
     FROM drivers
    WHERE driver_id = ANY($1::text[])`,
    [ids]
  );
  const found = new Set(drivers.rows.map((driver) => driver.driver_id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new Error(`Missing driver IDs: ${missing.join(', ')}`);

  const existing = await pool.query(
    `SELECT class, COUNT(*)::int AS count
     FROM points
     WHERE season = $1 AND round = $2 AND championship_type = $3
     GROUP BY class ORDER BY class`,
    [SEASON, ROUND, CHAMP_TYPE]
  );
  console.log(`Validated ${found.size} drivers. Existing Round 7 rows: ${existing.rows.reduce((sum, row) => sum + row.count, 0)}`);
  console.table(ROWS.reduce((counts, row) => {
    counts[row[1]] = (counts[row[1]] || 0) + 1;
    return counts;
  }, {}));

  if (DRY_RUN) {
    console.log('Dry run complete; no changes made.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await client.query(
      `DELETE FROM points
       WHERE season = $1 AND round = $2 AND championship_type = $3`,
      [SEASON, ROUND, CHAMP_TYPE]
    );

    for (const [driverId, raceClass, heat1, heat2, finalPoints, position] of ROWS) {
      const total = heatValue(heat1) + heatValue(heat2) + heatValue(finalPoints);
      await client.query(
        `INSERT INTO points
           (points_id, driver_id, season, event, round, class,
            qualifying_points, heat1_points, heat2_points, final_points,
            penalties_points, total_points, position, notes,
            championship_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,0,$10,$11,$12,$13,$14)`,
        [uuidv4(), driverId, SEASON, EVENT, ROUND, raceClass, heat1, heat2,
          finalPoints, total, position, NOTE, CHAMP_TYPE, 'SA_NAT_Import']
      );
    }

    await client.query('COMMIT');
    console.log(`Published ${ROWS.length} Round 7 rows; replaced ${deleted.rowCount}.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

run()
  .catch((error) => {
    console.error(`Round 7 import failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());