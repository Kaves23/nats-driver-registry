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
  const r = await pool.query(`
    SELECT d.first_name, d.last_name, c.email, re.race_class, re.payment_status, re.entry_status
    FROM race_entries re
    LEFT JOIN drivers d ON re.driver_id = d.driver_id
    LEFT JOIN contacts c ON d.driver_id = c.driver_id
    WHERE re.event_id = 'event_redstar_001'
    ORDER BY re.race_class, d.last_name, d.first_name
  `);

  console.log('='.repeat(70));
  console.log('14 FEB 2026 - RED STAR RACEWAY - ENTRANT EMAILS');
  console.log('='.repeat(70));
  console.log(`TOTAL ENTRIES: ${r.rows.length}\n`);

  r.rows.forEach(e => {
    console.log(`${(e.first_name + ' ' + e.last_name).padEnd(30)} ${(e.email || 'NO EMAIL').padEnd(40)} Class: ${e.race_class || 'N/A'}  Payment: ${e.payment_status}  Status: ${e.entry_status}`);
  });

  console.log('\n' + '='.repeat(70));
  console.log('EMAIL ADDRESSES ONLY (copy-paste ready):');
  console.log('='.repeat(70));
  r.rows.filter(e => e.email).forEach(e => console.log(e.email));

  const noEmail = r.rows.filter(e => !e.email);
  if (noEmail.length > 0) {
    console.log('\nNO EMAIL ON FILE:');
    noEmail.forEach(e => console.log(`  - ${e.first_name} ${e.last_name}`));
  }

  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
