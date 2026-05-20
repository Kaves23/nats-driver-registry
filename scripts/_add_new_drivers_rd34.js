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

const newDrivers = [
  { first_name: 'Tiyani',  last_name: 'Malabie',  race_number: '29', msa: '44534' },
  { first_name: 'Declan',  last_name: 'Jurgens',  race_number: '63', msa: '30986' },
  { first_name: 'Durelle', last_name: 'Goodman',  race_number: '47', msa: '57543' },
  { first_name: 'Jason',   last_name: 'Coetzee',  race_number: '77', msa: '1445'  },
  { first_name: 'Troy',    last_name: 'Snyman',   race_number: '21', msa: '3011'  },
];

(async () => {
  for (const d of newDrivers) {
    const id = uuidv4();
    const check = await pool.query(
      'SELECT driver_id FROM drivers WHERE msa_license_number = $1',
      [d.msa]
    );
    if (check.rows.length > 0) {
      console.log(`  ~ ALREADY EXISTS: ${d.first_name} ${d.last_name} (MSA ${d.msa}) → ${check.rows[0].driver_id}`);
    } else {
      const res = await pool.query(
        `INSERT INTO drivers (driver_id, first_name, last_name, race_number, msa_license_number)
         VALUES ($1, $2, $3, $4, $5) RETURNING driver_id`,
        [id, d.first_name, d.last_name, d.race_number, d.msa]
      );
      console.log(`  ✓ INSERTED: ${d.first_name} ${d.last_name} (MSA ${d.msa}) → ${res.rows[0].driver_id}`);
    }
  }
  await pool.end();
  console.log('Done.');
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
