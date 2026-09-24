/**
 * Reconcile SA Nationals Championship points DB with the latest master workbook
 * (SA-Nationals-Championship-Points 23092026_UPDATED.xlsx), following the same
 * per-round full-replace convention as scripts/insert_sa_nationals_round8_partial.js.
 *
 * Run with --check for a dry-run diff report. Add --apply to write changes.
 */
require('dotenv').config();
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');

const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
});

const APPLY = process.argv.includes('--apply');

function cellVal(cell) {
  const v = cell.value;
  if (v && typeof v === 'object' && 'result' in v) return v.result;
  return v;
}
function toPoints(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null; // DSQ/DNS/text -> null (Excel MIN/SUM ignore text cells)
}
function norm(s) { return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' '); }
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const ROUND_COLS = {
  1: [5, 6, 7], 2: [8, 9, 10],
  3: [14, 15, 16], 4: [17, 18, 19],
  5: [23, 24, 25], 6: [26, 27, 28],
  7: [32, 33, 34], 8: [35, 36, 37],
};
const ROUND_EVENT = {
  1: 'SA Nat - RSR 21 Mar 2026', 2: 'SA Nat - RSR 22 Mar 2026',
  3: 'SA Nat - VKC 09 May 2026', 4: 'SA Nat - VKC 10 May 2026',
  5: 'SA Nat - FK 11 Jul 2026', 6: 'SA Nat - FK 12 Jul 2026',
  7: 'SA Nat - Killarney 11 Sep 2026', 8: 'SA Nat - Killarney 12 Sep 2026',
};
const CLASSES = ['CADET', 'MINI ROK', 'OK-J', 'OK-N'];
const SEASON = '2026';
const CHAMP_TYPE = 'ROK NATS';
const NOTE = 'SA National Championship';
const CREATED_BY = 'SA_NAT_Import_20260923';

// Manual overrides where automatic name matching is ambiguous
const MANUAL_MATCH = {
  'cadet|yerhu malabie': 'ebf00123-f0f6-4a6d-89cd-314a9e8967fc',
};

const JOHN_DUVILL_ID = '596ebaa1-06cd-4324-bdde-3716ef0b9c28';
const ALEKSANDAR_ID = 'b88efc5f-e328-4f3c-9706-84c0f9689d71';

async function parseWorkbook(drivers, driverIdsWithHistory) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('SA-Nationals-Championship-Points 23092026_UPDATED.xlsx');

  const forwardMap = new Map();
  for (const d of drivers) {
    const full = norm(`${d.first_name} ${d.last_name}`);
    if (!forwardMap.has(full)) forwardMap.set(full, []);
    forwardMap.get(full).push(d);
  }
  function lookup(name) {
    const key = norm(name);
    let candidates = forwardMap.get(key) || [];
    if (!candidates.length) {
      const words = key.split(' ');
      if (words.length >= 2) {
        candidates = forwardMap.get(`${words.slice(1).join(' ')} ${words[0]}`) || [];
      }
    }
    return candidates;
  }

  const unresolved = [];
  const parsed = {};

  for (const className of CLASSES) {
    const ws = wb.getWorksheet(className);
    if (!ws) { console.log('MISSING SHEET:', className); continue; }
    parsed[className] = [];
    for (let r = 6; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const name = cellVal(row.getCell(3));
      if (!name || String(name).toLowerCase() === 'e&oe') continue;
      const raceNumber = String(cellVal(row.getCell(2)) || '').trim();

      const rounds = {};
      for (const [rnd, cols] of Object.entries(ROUND_COLS)) {
        const [c1, c2, c3] = cols;
        const v1 = cellVal(row.getCell(c1));
        const v2 = cellVal(row.getCell(c2));
        const v3 = cellVal(row.getCell(c3));
        const hasAny = (v1 !== null && v1 !== undefined) || (v2 !== null && v2 !== undefined) || (v3 !== null && v3 !== undefined);
        if (hasAny) rounds[rnd] = { h1: toPoints(v1), h2: toPoints(v2), h3: toPoints(v3) };
      }
      if (!Object.keys(rounds).length) continue; // blank placeholder row - nothing to import

      const manualKey = `${norm(className)}|${norm(name)}`;
      let driverId = MANUAL_MATCH[manualKey];
      if (!driverId) {
        let candidates = lookup(name);
        // Prefer a candidate that already has points history - duplicate driver
        // profiles frequently have a mismatched/null class field, making class-based
        // narrowing pick the wrong (historyless) duplicate.
        if (candidates.length > 1) {
          const withHistory = candidates.filter(c => driverIdsWithHistory.has(c.driver_id));
          if (withHistory.length === 1) candidates = withHistory;
        }
        if (candidates.length > 1) {
          const byClass = candidates.filter(c => norm(c.class) === norm(className));
          if (byClass.length >= 1) candidates = byClass;
        }
        if (candidates.length > 1) {
          const byNum = candidates.filter(c => String(c.race_number || '').trim() === raceNumber);
          if (byNum.length === 1) candidates = byNum;
        }
        if (candidates.length !== 1) {
          unresolved.push({ class: className, row: r, name, raceNumber, candidateCount: candidates.length });
          continue;
        }
        driverId = candidates[0].driver_id;
      }
      parsed[className].push({ name, raceNumber, driver_id: driverId, rounds });
    }
  }
  return { parsed, unresolved };
}

async function main() {
  const driversRes = await pool.query(`SELECT driver_id, first_name, last_name, race_number, class FROM drivers WHERE (is_deleted = FALSE OR is_deleted IS NULL)`);
  const historyRes = await pool.query(`SELECT DISTINCT driver_id FROM points`);
  const driverIdsWithHistory = new Set(historyRes.rows.map(r => r.driver_id));
  const { parsed, unresolved } = await parseWorkbook(driversRes.rows, driverIdsWithHistory);

  if (unresolved.length) {
    console.log('=== UNRESOLVED (skipped, need manual mapping) ===');
    console.log(JSON.stringify(unresolved, null, 2));
  }

  // Build rows to write: class -> round -> [{driver_id, h1, h2, h3, total, position}]
  const writeSet = {};
  for (const className of CLASSES) {
    writeSet[className] = {};
    for (const rnd of Object.keys(ROUND_COLS)) {
      const entries = parsed[className]
        .filter(d => d.rounds[rnd])
        .map(d => {
          const { h1, h2, h3 } = d.rounds[rnd];
          const total = (h1 || 0) + (h2 || 0) + (h3 || 0);
          return { driver_id: d.driver_id, name: d.name, h1, h2, h3, total };
        })
        .sort((a, b) => b.total - a.total);
      // competition ranking (ties share rank)
      entries.forEach((e, i) => {
        const rank = 1 + entries.filter(o => o.total > e.total).length;
        e.position = ordinal(rank);
      });
      writeSet[className][rnd] = entries;
    }
  }

  // Diff against current DB
  let totalNew = 0, totalChanged = 0, totalSame = 0, totalRemoved = 0;
  const removedDetail = [];
  for (const className of CLASSES) {
    for (const rnd of Object.keys(ROUND_COLS)) {
      const existing = await pool.query(
        `SELECT driver_id, heat1_points, heat2_points, final_points, total_points, position
         FROM points WHERE season=$1 AND round=$2 AND class=$3 AND championship_type=$4`,
        [SEASON, rnd, className, CHAMP_TYPE]
      );
      const existingByDriver = new Map(existing.rows.map(r => [r.driver_id, r]));
      const newDriverIds = new Set(writeSet[className][rnd].map(e => e.driver_id));

      for (const e of writeSet[className][rnd]) {
        const old = existingByDriver.get(e.driver_id);
        const sameVal = (a, b) => (a === null || a === undefined) ? (b === null || b === undefined) : Number(a) === b;
        if (!old) { totalNew++; }
        else if (!sameVal(old.heat1_points, e.h1) || !sameVal(old.heat2_points, e.h2) ||
                 !sameVal(old.final_points, e.h3) || Number(old.total_points) !== e.total ||
                 old.position !== e.position) { totalChanged++; }
        else totalSame++;
      }
      for (const [driverId, old] of existingByDriver) {
        if (!newDriverIds.has(driverId)) {
          totalRemoved++;
          removedDetail.push({ class: className, round: rnd, driver_id: driverId, old });
        }
      }
    }
  }

  console.log(`\n=== DIFF SUMMARY (${APPLY ? 'APPLYING' : 'DRY RUN - use --apply to write'}) ===`);
  console.log({ totalNew, totalChanged, totalSame, totalRemoved });
  if (removedDetail.length) {
    console.log('\nRows that exist in DB but have NO matching row in the new workbook for that round/class (will be LEFT UNTOUCHED, not deleted):');
    console.log(JSON.stringify(removedDetail, null, 2));
  }

  if (!APPLY) { await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const className of CLASSES) {
      for (const rnd of Object.keys(ROUND_COLS)) {
        const entries = writeSet[className][rnd];
        if (!entries.length) continue;
        const driverIds = entries.map(e => e.driver_id);
        // Only replace rows for drivers present in the new data - never delete drivers absent from the sheet
        await client.query(
          `DELETE FROM points WHERE season=$1 AND round=$2 AND class=$3 AND championship_type=$4 AND driver_id = ANY($5::text[])`,
          [SEASON, rnd, className, CHAMP_TYPE, driverIds]
        );
        for (const e of entries) {
          await client.query(
            `INSERT INTO points
               (points_id, driver_id, season, event, round, class,
                qualifying_points, heat1_points, heat2_points, final_points,
                penalties_points, total_points, position, notes,
                championship_type, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,0,$10,$11,$12,$13,$14)`,
            [uuidv4(), e.driver_id, SEASON, ROUND_EVENT[rnd], rnd, className,
              e.h1, e.h2, e.h3, e.total, e.position, NOTE, CHAMP_TYPE, CREATED_BY]
          );
        }
      }
    }

    // John Duvill test-match: mirror Aleksandar Praizovic's OK-J rows exactly under John's driver_id
    await client.query(
      `DELETE FROM points WHERE season=$1 AND class='OK-J' AND championship_type=$2 AND driver_id=$3`,
      [SEASON, CHAMP_TYPE, JOHN_DUVILL_ID]
    );
    const aleksRows = await client.query(
      `SELECT * FROM points WHERE season=$1 AND class='OK-J' AND championship_type=$2 AND driver_id=$3`,
      [SEASON, CHAMP_TYPE, ALEKSANDAR_ID]
    );
    for (const row of aleksRows.rows) {
      await client.query(
        `INSERT INTO points
           (points_id, driver_id, season, event, round, class,
            qualifying_points, heat1_points, heat2_points, final_points,
            penalties_points, total_points, position, notes,
            championship_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [uuidv4(), JOHN_DUVILL_ID, row.season, row.event, row.round, row.class,
          row.qualifying_points, row.heat1_points, row.heat2_points, row.final_points,
          row.penalties_points, row.total_points, row.position,
          'TEST MATCH - mirrors Aleksandar Praizovic for verification', row.championship_type, CREATED_BY]
      );
    }
    console.log(`\nJohn Duvill (${JOHN_DUVILL_ID}) OK-J points now mirror Aleksandar Praizovic: ${aleksRows.rows.length} rounds copied.`);

    await client.query('COMMIT');
    console.log('\nCOMMITTED.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('FAILED, rolled back:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
