require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ host:process.env.DB_HOST, port:process.env.DB_PORT, database:process.env.DB_DATABASE, user:process.env.DB_USERNAME, password:process.env.DB_PASSWORD, ssl:{rejectUnauthorized:false} });
(async () => {
  const events = await pool.query(`SELECT event_id, event_name FROM events ORDER BY event_date DESC LIMIT 10`);
  console.log('Events:', JSON.stringify(events.rows, null, 2));
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='race_entries' ORDER BY ordinal_position`);
  console.log('\nrace_entries columns:', cols.rows.map(r=>r.column_name).join(', '));
  const entries = await pool.query(`SELECT * FROM race_entries LIMIT 3`);
  console.log('\nSample entries:');
  entries.rows.forEach(r => { console.log(JSON.stringify(r, null, 2)); console.log('---'); });
  const pricing = await pool.query(`SELECT event_id, class_name, config_json FROM event_class_pricing LIMIT 5`);
  console.log('\nPricing configs:');
  pricing.rows.forEach(r => { console.log(JSON.stringify(r, null, 2)); console.log('---'); });
  await pool.end();
})().catch(e=>{console.error(e.message);process.exit(1);});
