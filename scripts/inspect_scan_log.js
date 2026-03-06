require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_DATABASE, user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD, ssl: { rejectUnauthorized: false }
});
(async () => {
  // Exact row count
  const count = await pool.query(`SELECT COUNT(*) FROM equipment_scan_log`);
  console.log('Exact row count:', count.rows[0].count);

  // Column definitions
  const cols = await pool.query(`
    SELECT column_name, data_type, character_maximum_length
    FROM information_schema.columns
    WHERE table_name = 'equipment_scan_log'
    ORDER BY ordinal_position
  `);
  console.log('\nColumns:');
  cols.rows.forEach(r => console.log(' ', r.column_name, '-', r.data_type, r.character_maximum_length ? `(max ${r.character_maximum_length})` : ''));

  // Index list
  const idx = await pool.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'equipment_scan_log'
  `);
  console.log('\nIndexes:');
  idx.rows.forEach(r => console.log(' ', r.indexname, ':', r.indexdef));

  // Average row size
  const rowSize = await pool.query(`
    SELECT AVG(pg_column_size(t.*)) AS avg_row_bytes,
           MAX(pg_column_size(t.*)) AS max_row_bytes
    FROM equipment_scan_log t
  `);
  console.log('\nAvg row size:', Math.round(rowSize.rows[0].avg_row_bytes), 'bytes');
  console.log('Max row size:', rowSize.rows[0].max_row_bytes, 'bytes');

  // Sample rows to see what data looks like
  const sample = await pool.query(`SELECT * FROM equipment_scan_log ORDER BY id DESC LIMIT 3`);
  console.log('\nSample rows (latest 3):');
  sample.rows.forEach((r, i) => {
    console.log(`\n  Row ${i+1}:`);
    Object.entries(r).forEach(([k,v]) => {
      const val = typeof v === 'string' && v.length > 120 ? v.slice(0,120) + '...' : v;
      console.log(`    ${k}: ${val}`);
    });
  });

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
