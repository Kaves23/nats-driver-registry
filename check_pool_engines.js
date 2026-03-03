require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_DATABASE, user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD, ssl: { rejectUnauthorized: false }
});

// national_package values:
//   'engine' = engine included, no engine charge at National entry
//   'full'   = full season package, entry fee + engine + fuel + race tyres all R0 for National
const assignments = [
  { first: 'Noah',         last: 'Cronje',   pkg: 'engine' },
  { first: 'John',         last: 'Duvill',   pkg: 'engine' },
  { first: 'Hunter',       last: 'North',    pkg: 'engine' },
  { first: 'Riley',        last: 'van Staden', pkg: 'full'  },
  { first: 'Logan',        last: 'Billau',   pkg: 'full'   },
  { first: 'Ruvan',        last: 'Maritz',   pkg: 'engine' },
  { first: 'Retlotleng',   last: 'Thekiso',  pkg: 'engine' },
  { first: 'Johnathan',    last: 'Duvill',   pkg: 'engine' },
];

async function run() {
  // Ensure column exists first
  await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS national_package VARCHAR(20)`);
  console.log('Column ready.\n');
  for (const a of assignments) {
    const res = await pool.query(
      `UPDATE drivers SET national_package = $1 WHERE LOWER(first_name) = LOWER($2) AND LOWER(last_name) = LOWER($3) AND (is_deleted IS NULL OR is_deleted = false) RETURNING driver_id, first_name, last_name, national_package`,
      [a.pkg, a.first, a.last]
    );
    if (res.rows.length === 0) {
      console.log(`âš ï¸  NOT FOUND: ${a.first} ${a.last}`);
    } else {
      res.rows.forEach(r => console.log(`âœ… ${r.first_name} ${r.last_name} â†’ national_package = '${r.national_package}'`));
    }
  }

  // Verify
  const chk = await pool.query(`SELECT first_name, last_name, class, national_package FROM drivers WHERE national_package IS NOT NULL AND (is_deleted IS NULL OR is_deleted = false) ORDER BY class, last_name`);
  console.log('\n--- Final state ---');
  chk.rows.forEach(r => console.log(`  ${(r.class||'').padEnd(18)} ${(r.first_name+' '+r.last_name).padEnd(25)} â†’ ${r.national_package}`));
  // pool.end() called by chained .then() below
}
run().then(async () => {
  const billauId = '8cc0750c-c83f-4133-a682-77611e37813d';
  // Check if already in payments
  const existing = await pool.query(`SELECT payment_id FROM payments WHERE driver_id=$1 LIMIT 1`, [billauId]);
  if (existing.rows.length > 0) {
    console.log('\nBillau already has a payment record ✅');
  } else {
    await pool.query(
      `INSERT INTO payments (payment_id, driver_id, item_description, payment_status, created_at)
       VALUES (gen_random_uuid(), $1, 'Full Season Package (manual)', 'Complete', NOW())`,
      [billauId]
    );
    console.log('\nBillau payment record created ✅');
  }
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
