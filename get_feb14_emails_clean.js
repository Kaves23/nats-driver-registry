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
  // Confirmed entries (unique drivers)
  const confirmed = await pool.query(`
    SELECT DISTINCT ON (d.driver_id)
      d.first_name, d.last_name, c.email, re.race_class, re.payment_status, re.entry_status
    FROM race_entries re
    LEFT JOIN drivers d ON re.driver_id = d.driver_id
    LEFT JOIN contacts c ON d.driver_id = c.driver_id
    WHERE re.event_id = 'event_redstar_001'
      AND re.entry_status IN ('confirmed', 'pending_payment')
    ORDER BY d.driver_id, re.entry_status DESC
  `);

  // All unique emails regardless of status (for reference)
  const all = await pool.query(`
    SELECT DISTINCT c.email, d.first_name, d.last_name
    FROM race_entries re
    LEFT JOIN drivers d ON re.driver_id = d.driver_id
    LEFT JOIN contacts c ON d.driver_id = c.driver_id
    WHERE re.event_id = 'event_redstar_001'
      AND c.email IS NOT NULL
      AND c.email NOT LIKE '%johnduvill%'
      AND c.email != 'win@rokthenats.co.za'
    ORDER BY d.last_name, d.first_name
  `);

  console.log('='.repeat(70));
  console.log('14 FEB 2026 - CONFIRMED/ACTIVE ENTRANTS');
  console.log('='.repeat(70));
  console.log(`Count: ${confirmed.rows.length}\n`);
  confirmed.rows.forEach(e => {
    console.log(`${(e.first_name + ' ' + e.last_name).padEnd(28)} ${(e.email || 'NO EMAIL').padEnd(40)} Class: ${e.race_class || 'N/A'}  ${e.payment_status}`);
  });

  console.log('\n' + '='.repeat(70));
  console.log('ALL UNIQUE REAL ENTRANT EMAILS (excl. test/admin):');
  console.log('='.repeat(70));
  all.rows.forEach(e => console.log(`${e.email}  (${e.first_name} ${e.last_name})`));

  console.log('\n--- COPY-PASTE EMAIL LIST ---');
  all.rows.forEach(e => console.log(e.email));

  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
