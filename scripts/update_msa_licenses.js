require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '6432'),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const drivers = [
  { last: 'Haskins',       first: 'Chase',                license: '45218' },
  { last: 'North',         first: 'Hunter',               license: '35901' },
  { last: 'Shuttleworth',  first: 'Matthew',              license: '20828' },
  { last: 'Reddi',         first: 'Kiyaan',               license: '57445' },
  { last: 'Praizovic',     first: 'Aleksandar',           license: '37414' },
  { last: 'Cornofsky',     first: 'Kayde',                license: '27945' },
  { last: 'van Staden',    first: 'Riley',                license: '33521' },
  { last: 'Fleming',       first: 'Nicholas',             license: '45645' },
  { last: 'Klaasen',       first: 'Jordan',               license: '40378' },
  { last: 'Cronje',        first: 'Noah',                 license: '28089' },
  { last: 'Reddi',         first: 'Ashaan',               license: '37470' },
  { last: 'Mason',         first: 'Mattao',               license: '19794' },
  { last: 'Venter',        first: 'Grayson',              license: '44150' },
  { last: 'Mason',         first: 'Maddox',               license: '20875' },
  { last: 'Moore',         first: 'Jack',                 license: '17650' },
  { last: 'Boshoff',       first: 'Max',                  license: '44265' },
  { last: 'Mfana',         first: 'Omolemo Aqhamile',     license: '32118' },
  { last: 'Tuttelberg',    first: 'Ethan',                license: '43664' },
  { last: 'Venter',        first: 'Ronald',               license: '32140' },
  { last: 'Boshoff',       first: 'Zac',                  license: '31242' },
  { last: 'van der Molen', first: 'Parker',               license: '44345' },
  { last: 'Billau',        first: 'Logan',                license: '27816' },
  { last: 'Thekiso',       first: 'Retlotleng',           license: '40654' },
  { last: 'Malabie',       first: 'Yerhu',                license: '44523' },
  { last: 'Berardone',     first: 'Diego',                license: '35865' },
  { last: 'Maritz',        first: 'Ruvan',                license: '27587' },
  { last: 'Grimmick',      first: 'Christopher',          license: '44432' },
  { last: 'Loreti',        first: 'Brooke',               license: '36142' },
  { last: 'Calitz',        first: 'Aidan',                license: '46452' },
  { last: 'Antunes',       first: 'Diego',                license: '32278' },
  { last: 'John',          first: 'Duvill',               license: '67890' },
];

// Deduplicate by last+first (keep first occurrence)
const seen = new Set();
const unique = drivers.filter(d => {
  const key = `${d.first.toLowerCase()}|${d.last.toLowerCase()}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

async function run() {
  const matched   = [];
  const notFound  = [];
  const updated   = [];
  const errors    = [];

  for (const d of unique) {
    try {
      // Case-insensitive match on first + last name
      const res = await pool.query(
        `SELECT driver_id, first_name, last_name, license_number, msa_license_number
         FROM drivers
         WHERE LOWER(first_name) = LOWER($1) AND LOWER(last_name) = LOWER($2)
           AND (is_deleted = FALSE OR is_deleted IS NULL)
         LIMIT 1`,
        [d.first, d.last]
      );

      if (res.rows.length === 0) {
        notFound.push(`${d.first} ${d.last}`);
        continue;
      }

      const row = res.rows[0];
      matched.push({ ...row, new_license: d.license });

      await pool.query(
        `UPDATE drivers SET license_number = $1, msa_license_number = $1 WHERE driver_id = $2`,
        [d.license, row.driver_id]
      );
      updated.push(`✅ ${d.first} ${d.last} → ${d.license} (was: ${row.license_number || 'none'})`);
    } catch (err) {
      errors.push(`❌ ${d.first} ${d.last}: ${err.message}`);
    }
  }

  console.log('\n=== UPDATED ===');
  updated.forEach(l => console.log(l));

  console.log('\n=== NOT FOUND IN DB ===');
  notFound.forEach(n => console.log('⚠️  ' + n));

  if (errors.length) {
    console.log('\n=== ERRORS ===');
    errors.forEach(e => console.log(e));
  }

  console.log(`\nSummary: ${updated.length} updated, ${notFound.length} not found, ${errors.length} errors`);
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
