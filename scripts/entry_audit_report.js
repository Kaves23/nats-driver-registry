// Entry Audit Report - generates markdown of all drivers and their race entries
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 6432,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  // Get all drivers with their entry counts (email is in contacts table)
  const driversResult = await pool.query(`
    SELECT 
      d.driver_id,
      d.first_name,
      d.last_name,
      c.email,
      d.race_number,
      COUNT(re.entry_id) AS total_entries
    FROM drivers d
    LEFT JOIN contacts c ON c.driver_id = d.driver_id
    LEFT JOIN race_entries re ON re.driver_id = d.driver_id
    WHERE (d.is_deleted = FALSE OR d.is_deleted IS NULL)
    GROUP BY d.driver_id, d.first_name, d.last_name, c.email, d.race_number
    ORDER BY total_entries DESC, d.last_name
  `);

  // Get all entries with event info
  const entriesResult = await pool.query(`
    SELECT 
      re.entry_id,
      re.driver_id,
      re.event_id,
      re.payment_reference,
      re.payment_status,
      re.entry_status,
      re.amount_paid,
      re.race_class,
      re.created_at,
      re.updated_at,
      e.event_name,
      e.event_date
    FROM race_entries re
    LEFT JOIN events e ON e.event_id = re.event_id
    ORDER BY re.driver_id, re.created_at DESC
  `);

  // Group entries by driver_id
  const entriesByDriver = {};
  for (const row of entriesResult.rows) {
    if (!entriesByDriver[row.driver_id]) entriesByDriver[row.driver_id] = [];
    entriesByDriver[row.driver_id].push(row);
  }

  const lines = [];
  const now = new Date();

  lines.push(`# Race Entry Audit Report`);
  lines.push(`**Generated:** ${now.toLocaleString('en-ZA')}\n`);

  // Summary counts
  const totalDrivers = driversResult.rows.length;
  const driversWithEntries = driversResult.rows.filter(d => parseInt(d.total_entries) > 0);
  const driversWithMultiple = driversResult.rows.filter(d => parseInt(d.total_entries) > 1);
  const allEntries = entriesResult.rows;
  const pendingEntries = allEntries.filter(e => e.payment_status === 'Pending' || e.entry_status === 'pending_payment');
  const failedEntries = allEntries.filter(e => e.payment_status === 'Failed' || e.entry_status === 'cancelled');
  const confirmedEntries = allEntries.filter(e => e.entry_status === 'confirmed');

  lines.push(`## Summary`);
  lines.push(`| Metric | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| Total drivers in DB | ${totalDrivers} |`);
  lines.push(`| Drivers with ≥1 entry | ${driversWithEntries.length} |`);
  lines.push(`| Drivers with multiple entries | ${driversWithMultiple.length} |`);
  lines.push(`| Total entry records | ${allEntries.length} |`);
  lines.push(`| Confirmed entries | ${confirmedEntries.length} |`);
  lines.push(`| Pending/unpaid entries | ${pendingEntries.length} |`);
  lines.push(`| Failed/cancelled entries | ${failedEntries.length} |`);
  lines.push(``);

  // ── SECTION 1: Drivers with multiple entries ─────────────────────────────
  lines.push(`---`);
  lines.push(`## ⚠️ Drivers With Multiple Entries`);
  lines.push(`_These drivers have more than one entry record — possible duplicates._\n`);

  const multipleDrivers = driversResult.rows.filter(d => parseInt(d.total_entries) > 1);
  if (multipleDrivers.length === 0) {
    lines.push(`_None found._\n`);
  } else {
    for (const driver of multipleDrivers) {
      const name = `${driver.first_name || ''} ${driver.last_name || ''}`.trim() || '(no name)';
      const entries = entriesByDriver[driver.driver_id] || [];
      lines.push(`### ${name} — #${driver.race_number || '?'} | ${driver.email || 'no email'}`);
      lines.push(`**Driver ID:** \`${driver.driver_id}\`  `);
      lines.push(`**Total entries:** ${driver.total_entries}\n`);
      lines.push(`| # | Entry ID | Event | Date | Class | Payment | Status | Amount | Created |`);
      lines.push(`|---|---|---|---|---|---|---|---|---|`);
      entries.forEach((e, i) => {
        const eventDate = e.event_date ? new Date(e.event_date).toLocaleDateString('en-ZA') : 'TBA';
        const created = e.created_at ? new Date(e.created_at).toLocaleString('en-ZA') : '-';
        const amount = e.amount_paid != null ? `R${parseFloat(e.amount_paid).toFixed(2)}` : '-';
        const flag = (e.payment_status === 'Pending' || e.entry_status === 'pending_payment') ? '⏳' :
                     (e.entry_status === 'confirmed' && e.payment_status === 'Completed') ? '✅' :
                     (e.entry_status === 'cancelled' || e.payment_status === 'Failed') ? '❌' : '❓';
        lines.push(`| ${i+1} | \`${e.entry_id}\` | ${e.event_name || e.event_id || '-'} | ${eventDate} | ${e.race_class || '-'} | ${e.payment_status || '-'} | ${flag} ${e.entry_status || '-'} | ${amount} | ${created} |`);
      });
      lines.push(``);
    }
  }

  // ── SECTION 2: Pending / stuck entries ───────────────────────────────────
  lines.push(`---`);
  lines.push(`## ⏳ All Pending / Unpaid Entries`);
  lines.push(`_Entries where payment has not completed._\n`);

  if (pendingEntries.length === 0) {
    lines.push(`_None found._\n`);
  } else {
    lines.push(`| Driver | Email | Event | Class | Amount | Reference | Created |`);
    lines.push(`|---|---|---|---|---|---|---|`);
    for (const e of pendingEntries) {
      const driver = driversResult.rows.find(d => d.driver_id === e.driver_id);
      const name = driver ? `${driver.first_name || ''} ${driver.last_name || ''}`.trim() : '(unknown)';
      const email = driver?.email || '-';
      const amount = e.amount_paid != null ? `R${parseFloat(e.amount_paid).toFixed(2)}` : '-';
      const created = e.created_at ? new Date(e.created_at).toLocaleString('en-ZA') : '-';
      const ageMs = now - new Date(e.created_at);
      const ageDays = Math.floor(ageMs / (1000*60*60*24));
      const ageLabel = ageDays > 0 ? ` (${ageDays}d ago)` : ' (today)';
      lines.push(`| ${name} | ${email} | ${e.event_name || e.event_id || '-'} | ${e.race_class || '-'} | ${amount} | \`${e.payment_reference || '-'}\` | ${created}${ageLabel} |`);
    }
    lines.push(``);
  }

  // ── SECTION 3: All drivers full list ─────────────────────────────────────
  lines.push(`---`);
  lines.push(`## 📋 All Drivers — Full Entry List`);
  lines.push(`_Every driver in the database with their complete entry history._\n`);

  for (const driver of driversResult.rows) {
    const name = `${driver.first_name || ''} ${driver.last_name || ''}`.trim() || '(no name)';
    const entries = entriesByDriver[driver.driver_id] || [];

    lines.push(`### ${name} — #${driver.race_number || '?'}`);
    lines.push(`**Email:** ${driver.email || '-'}  `);
    lines.push(`**Driver ID:** \`${driver.driver_id}\`  `);
    lines.push(`**Total entries:** ${entries.length}\n`);

    if (entries.length === 0) {
      lines.push(`_No entries recorded._\n`);
    } else {
      lines.push(`| Event | Event Date | Class | Payment | Status | Amount | Reference | Created |`);
      lines.push(`|---|---|---|---|---|---|---|---|`);
      for (const e of entries) {
        const eventDate = e.event_date ? new Date(e.event_date).toLocaleDateString('en-ZA') : 'TBA';
        const created = e.created_at ? new Date(e.created_at).toLocaleString('en-ZA') : '-';
        const amount = e.amount_paid != null ? `R${parseFloat(e.amount_paid).toFixed(2)}` : '-';
        const flag = (e.payment_status === 'Pending' || e.entry_status === 'pending_payment') ? '⏳' :
                     (e.entry_status === 'confirmed' && e.payment_status === 'Completed') ? '✅' :
                     (e.entry_status === 'cancelled' || e.payment_status === 'Failed') ? '❌' : '❓';
        lines.push(`| ${e.event_name || e.event_id || '-'} | ${eventDate} | ${e.race_class || '-'} | ${e.payment_status || '-'} | ${flag} ${e.entry_status || '-'} | ${amount} | \`${e.payment_reference || '-'}\` | ${created} |`);
      }
      lines.push(``);
    }
  }

  const output = lines.join('\n');
  const outPath = path.join(__dirname, '..', 'ENTRY_AUDIT_REPORT.md');
  fs.writeFileSync(outPath, output, 'utf8');
  console.log(`✅ Report written to: ${outPath}`);
  console.log(`   Drivers: ${totalDrivers} | Entries: ${allEntries.length} | Multiple-entry drivers: ${multipleDrivers.length}`);

  await pool.end();
}

run().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
