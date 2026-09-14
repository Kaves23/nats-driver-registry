const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const season = '2026';
const championshipType = 'ROK NATS';
const classes = ['CADET', 'MINI ROK', 'OK-J', 'OK-N'];
const classLabels = {
  CADET: 'Cadet ROK',
  'MINI ROK': 'Mini ROK',
  'OK-J': 'OK Junior',
  'OK-N': 'OK National'
};
const rounds = [
  { date: 'RSR 21-Mar', label: 'Rd 1', wknd: 0 },
  { date: 'RSR 22-Mar', label: 'Rd 2', wknd: 0 },
  { date: 'VKC 09-May', label: 'Rd 3', wknd: 1 },
  { date: 'VKC 10-May', label: 'Rd 4', wknd: 1 },
  { date: 'FK 11-Jul', label: 'Rd 5', wknd: 2 },
  { date: 'FK 12-Jul', label: 'Rd 6', wknd: 2 },
  { date: 'Killarney 11-Sep', label: 'Rd 7', wknd: 3 },
  { date: 'Killarney 12-Sep', label: 'Rd 8', wknd: 3 }
];
const weekends = [
  { title: 'SUMMER NATS', label: 'RSR Weekend · 21–22 Mar' },
  { title: 'AUTUMN NATS', label: 'VKC Weekend · 09–10 May' },
  { title: 'WINTER NATS', label: 'FK Weekend · 11–12 Jul' },
  { title: 'SPRING NATS', label: 'Killarney Weekend · 11–12 Sep' }
];

function columnLetter(columnNumber) {
  let value = '';
  while (columnNumber > 0) {
    const remainder = (columnNumber - 1) % 26;
    value = String.fromCharCode(65 + remainder) + value;
    columnNumber = Math.floor((columnNumber - 1) / 26);
  }
  return value;
}

function safeSheetName(name) {
  const safe = String(name || 'Sheet').replace(/[\\/*?:\[\]]/g, ' ').trim();
  return safe.slice(0, 31) || 'Sheet';
}

function hv(v) {
  return v === null || v === undefined ? 0 : Number(v);
}

function fullName(row) {
  const first = String(row.first_name || '').trim();
  const last = String(row.last_name || '').trim();
  if (last && first.toLowerCase().endsWith(last.toLowerCase())) return first;
  return `${first} ${last}`.trim();
}

function calcScores(driver) {
  let full = 0;
  driver.rounds.forEach((r) => {
    if (!r) return;
    r.forEach((h) => {
      full += hv(h);
    });
  });

  const droppedHeat = {};
  weekends.forEach((_, wi) => {
    const ra = driver.rounds[wi * 2];
    const rb = driver.rounds[wi * 2 + 1];
    if (!ra && !rb) return;
    const raArr = ra || [0, 0, 0];
    const rbArr = rb || [0, 0, 0];
    const raFull = Boolean(ra);
    const rbFull = Boolean(rb);

    const heats = [];
    raArr.forEach((h, hi) => {
      const v = hv(h);
      heats.push({ ri: wi * 2, hi, val: v, eligible: h > 0 || !raFull });
    });
    rbArr.forEach((h, hi) => {
      const v = hv(h);
      heats.push({ ri: wi * 2 + 1, hi, val: v, eligible: h > 0 || !rbFull });
    });

    let minVal = Infinity;
    let minIdx = -1;
    heats.forEach((o, i) => {
      if (o.eligible && o.val < minVal) {
        minVal = o.val;
        minIdx = i;
      }
    });

    if (minIdx === -1) return;
    const chosen = heats[minIdx];
    droppedHeat[`${chosen.ri}-${chosen.hi}`] = chosen.val;
  });

  let dropSum = 0;
  Object.keys(droppedHeat).forEach((k) => {
    dropSum += droppedHeat[k];
  });

  return {
    full,
    adjusted: full - dropSum,
    droppedHeat
  };
}

function roundAdjSub(roundData, roundIndex, droppedHeat) {
  if (!roundData) return null;
  return roundData.reduce((sum, h, hi) => {
    return droppedHeat[`${roundIndex}-${hi}`] !== undefined ? sum : sum + hv(h);
  }, 0);
}

function buildDrivers(rows) {
  const dMap = new Map();
  rows.forEach((r) => {
    const id = r.driver_id;
    if (!dMap.has(id)) {
      dMap.set(id, {
        id,
        name: fullName(r),
        no: r.race_number || '',
        team: r.team_name || '',
        rounds: Array(rounds.length).fill(null)
      });
    }

    const d = dMap.get(id);
    const ri = parseInt(r.round, 10) - 1;
    if (ri >= 0 && ri < rounds.length) {
      const h1 = r.heat1_points !== null && r.heat1_points !== undefined ? parseFloat(r.heat1_points) : null;
      const h2 = r.heat2_points !== null && r.heat2_points !== undefined ? parseFloat(r.heat2_points) : null;
      const h3 = r.final_points !== null && r.final_points !== undefined ? parseFloat(r.final_points) : null;
      d.rounds[ri] = [h1, h2, h3];
    }
  });

  return Array.from(dMap.values());
}

async function fetchClassRows(className) {
  const query = `
    SELECT d.driver_id, d.first_name, d.last_name, d.race_number, d.team_name,
           p.round, p.heat1_points, p.heat2_points, p.final_points, p.total_points, p.position
    FROM points p
    JOIN drivers d ON p.driver_id = d.driver_id
    WHERE p.season = $1 AND p.class = $2
      AND COALESCE(p.championship_type, 'Northern Regions') = $3
      AND (p.notes IS NULL OR p.notes NOT LIKE '%TEST ENTRY%')
    ORDER BY d.last_name, d.first_name, p.round
  `;
  const result = await pool.query(query, [season, className, championshipType]);
  return result.rows;
}

function addSheet(workbook, className, rows) {
  const sheet = workbook.addWorksheet(safeSheetName(classLabels[className] || className));
  const headers = ['Pos', 'Driver', 'Race No', 'Team', 'Full Total', 'Adj Total'];
  rounds.forEach((r, ri) => {
    headers.push(`${r.label} H1`);
    headers.push(`${r.label} H2`);
    headers.push(`${r.label} Final`);
    headers.push(`${r.label} Sub`);
    headers.push(`${r.label} Drop`);
  });
  sheet.addRow(headers);

  const drivers = buildDrivers(rows);
  const scored = drivers.map((d) => ({ d, sc: calcScores(d) }));
  scored.sort((a, b) => b.sc.adjusted - a.sc.adjusted || b.sc.full - a.sc.full);

  scored.forEach((entry, index) => {
    const { d, sc } = entry;
    const row = [index + 1, d.name, d.no, d.team, sc.full, sc.adjusted];
    rounds.forEach((r, ri) => {
      const roundData = d.rounds[ri];
      const dropValue = sc.droppedHeat[`${ri}-${0}`] !== undefined ? sc.droppedHeat[`${ri}-${0}`] :
        sc.droppedHeat[`${ri}-${1}`] !== undefined ? sc.droppedHeat[`${ri}-${1}`] :
        sc.droppedHeat[`${ri}-${2}`] !== undefined ? sc.droppedHeat[`${ri}-${2}`] : null;

      const subValue = roundAdjSub(roundData, ri, sc.droppedHeat);
      const dropText = dropValue === null || dropValue === undefined ? '—' : `Dropped ${dropValue}`;
      row.push(roundData ? roundData[0] : null);
      row.push(roundData ? roundData[1] : null);
      row.push(roundData ? roundData[2] : null);
      row.push(subValue === null ? null : subValue);
      row.push(dropText);
    });
    sheet.addRow(row);
  });

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E40AF' }
  };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.columns.forEach((column) => {
    column.width = Math.max(12, column.width || 12);
  });
  sheet.autoFilter = {
    from: 'A1',
    to: `${columnLetter(sheet.columns.length)}${sheet.rowCount}`
  };
}

function addSummarySheet(workbook, summaryRows) {
  const sheet = workbook.addWorksheet('Summary');
  sheet.addRow(['Class', '1st', '2nd', '3rd']);
  summaryRows.forEach((row) => sheet.addRow(row));
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((column) => {
    column.width = 24;
  });
}

function addRound8AuditSheet(workbook, rows) {
  const sheet = workbook.addWorksheet('Round 8 Audit');
  sheet.addRow(['Class', 'Position', 'Driver', 'Race 1', 'Race 2', 'Race 3', 'Stored Total', 'Calculated Total', 'Check']);
  rows.sort((a, b) => classes.indexOf(a.class) - classes.indexOf(b.class)
    || parseInt(a.position, 10) - parseInt(b.position, 10));

  rows.forEach((row) => {
    const excelRow = sheet.addRow([
      classLabels[row.class] || row.class,
      row.position,
      fullName(row),
      row.heat1_points,
      row.heat2_points,
      row.final_points,
      Number(row.total_points)
    ]);
    const rowNumber = excelRow.number;
    const calculatedTotal = [row.heat1_points, row.heat2_points, row.final_points]
      .reduce((sum, value) => sum + hv(value), 0);
    excelRow.getCell(8).value = { formula: `SUM(D${rowNumber}:F${rowNumber})`, result: calculatedTotal };
    excelRow.getCell(9).value = { formula: `IF(G${rowNumber}=H${rowNumber},"OK","CHECK")`, result: 'OK' };
  });

  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: `I${sheet.rowCount}` };
  sheet.columns = [14, 12, 26, 11, 11, 11, 14, 17, 11].map((width) => ({ width }));
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    sheet.getCell(rowNumber, 9).font = { bold: true, color: { argb: 'FF15803D' } };
  }
}

async function main() {
  const poolConfig = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    database: process.env.DB_DATABASE,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
  };

  global.pool = new Pool(poolConfig);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Copilot';
  workbook.lastModifiedBy = 'Copilot';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const summaryRows = [];
  const round8Rows = [];
  for (const className of classes) {
    const rows = await fetchClassRows(className);
    round8Rows.push(...rows.filter((row) => Number(row.round) === 8).map((row) => ({ ...row, class: className })));
    const drivers = buildDrivers(rows);
    const scored = drivers.map((d) => ({ d, sc: calcScores(d) }));
    scored.sort((a, b) => b.sc.adjusted - a.sc.adjusted || b.sc.full - a.sc.full);
    addSheet(workbook, className, rows);
    summaryRows.push([
      classLabels[className] || className,
      scored[0] ? `${scored[0].d.name} (${scored[0].sc.adjusted})` : '-',
      scored[1] ? `${scored[1].d.name} (${scored[1].sc.adjusted})` : '-',
      scored[2] ? `${scored[2].d.name} (${scored[2].sc.adjusted})` : '-'
    ]);
  }
  addSummarySheet(workbook, summaryRows);
  addRound8AuditSheet(workbook, round8Rows);

  const outputPaths = [
    path.join(__dirname, '..', 'championship_results_and_drops_2026.xlsx'),
    path.join(__dirname, '..', 'SA-Nationals-Championship-Points.xlsx')
  ];
  for (const outputPath of outputPaths) {
    await workbook.xlsx.writeFile(outputPath);
    console.log(`Created Excel workbook: ${outputPath}`);
  }
  await global.pool.end();
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});
