require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  const dbSize = await pool.query(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS total_db_size,
            pg_database_size(current_database()) AS raw_bytes`
  );
  const { total_db_size, raw_bytes } = dbSize.rows[0];
  console.log('=== NATS DATABASE SIZE REPORT ===');
  console.log('Total DB size:', total_db_size);
  console.log('Raw bytes:    ', Number(raw_bytes).toLocaleString(), 'bytes');
  console.log('');

  const tables = await pool.query(`
    SELECT
      relname AS table_name,
      pg_size_pretty(pg_total_relation_size(oid)) AS total_size,
      pg_size_pretty(pg_relation_size(oid)) AS data_size,
      pg_size_pretty(pg_total_relation_size(oid) - pg_relation_size(oid)) AS index_size,
      reltuples::bigint AS approx_rows
    FROM pg_class
    WHERE relkind = 'r'
      AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    ORDER BY pg_total_relation_size(oid) DESC
  `);

  console.log('Per-table breakdown:');
  console.log(
    'Table'.padEnd(38),
    'Total'.padEnd(12),
    'Data'.padEnd(12),
    'Indexes'.padEnd(12),
    'Approx rows'
  );
  console.log('-'.repeat(90));
  tables.rows.forEach(r => {
    console.log(
      r.table_name.padEnd(38),
      r.total_size.padEnd(12),
      r.data_size.padEnd(12),
      r.index_size.padEnd(12),
      r.approx_rows.toLocaleString()
    );
  });

  await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
