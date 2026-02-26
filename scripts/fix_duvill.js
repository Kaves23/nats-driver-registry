require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT||'6432'), database: process.env.DB_DATABASE, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, ssl: { rejectUnauthorized: false } });
pool.query("UPDATE drivers SET license_number = '67890', msa_license_number = '67890' WHERE LOWER(first_name)='john' AND LOWER(last_name)='duvill' AND (is_deleted=FALSE OR is_deleted IS NULL) RETURNING first_name, last_name, license_number")
  .then(r => { console.log(r.rows.length ? '✅ Updated: ' + JSON.stringify(r.rows[0]) : '⚠️ Not found'); pool.end(); })
  .catch(e => { console.error(e.message); pool.end(); });
