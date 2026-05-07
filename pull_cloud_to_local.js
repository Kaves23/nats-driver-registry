#!/usr/bin/env node
/**
 * pull_cloud_to_local.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Syncs the cloud (PlanetScale) database → local PostgreSQL (nats_raceday).
 * Run this on the race laptop BEFORE heading to the track each race day.
 *
 * Usage:
 *   node pull_cloud_to_local.js
 *
 * The server does NOT need to be running.
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config({ path: '.env.raceday' });
const { Pool } = require('pg');

const localPool = new Pool({
  host:     'localhost',
  port:     5432,
  database: 'nats_raceday',
  user:     'nats',
  password: 'natslocal',
  ssl:      false,
  connectionTimeoutMillis: 10000
});

const cloudPool = new Pool({
  host:                    process.env.CLOUD_DB_HOST,
  port:                    parseInt(process.env.CLOUD_DB_PORT || '6432'),
  database:                process.env.CLOUD_DB_DATABASE,
  user:                    process.env.CLOUD_DB_USERNAME,
  password:                process.env.CLOUD_DB_PASSWORD,
  ssl:                     { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000
});

function bar(label, n, total) {
  const pct = total > 0 ? Math.round((n / total) * 20) : 20;
  return `[${'█'.repeat(pct)}${'░'.repeat(20 - pct)}] ${n}/${total} ${label}`;
}

async function upsertRows(localClient, table, rows, conflictCol, updateCols, allCols) {
  let ins = 0, upd = 0;
  for (const row of rows) {
    const vals    = allCols.map(c => row[c] ?? null);
    const nums    = allCols.map((_, i) => `$${i + 1}`);
    const setClauses = updateCols
      .map(c => `${c} = EXCLUDED.${c}`)
      .join(', ');
    const result = await localClient.query(
      `INSERT INTO ${table} (${allCols.join(', ')})
       VALUES (${nums.join(', ')})
       ON CONFLICT (${conflictCol}) DO UPDATE SET ${setClauses}`,
      vals
    );
    if (result.rowCount > 0) ins++;
  }
  return { ins, upd };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       CLOUD → LOCAL DATABASE SYNC                ║');
  console.log('║  Run this before every race to update local DB   ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ── Connect ────────────────────────────────────────────────────────────────
  process.stdout.write('Connecting to local DB...  ');
  await localPool.query('SELECT 1');
  console.log('✅');

  process.stdout.write('Connecting to cloud DB...  ');
  await cloudPool.query('SELECT 1');
  console.log('✅\n');

  const localClient = await localPool.connect();
  try {
    await localClient.query('BEGIN');

    // ── 1. events ──────────────────────────────────────────────────────────
    process.stdout.write('Syncing events...          ');
    const { rows: events } = await cloudPool.query(
      `SELECT event_id, event_name, event_date, location, registration_deadline,
              entry_fee, created_at, updated_at, start_date, end_date,
              registration_open, national_only
       FROM events ORDER BY event_date DESC`
    );
    for (const row of events) {
      await localClient.query(
        `INSERT INTO events (event_id, event_name, event_date, location, registration_deadline,
                             entry_fee, created_at, updated_at, start_date, end_date,
                             registration_open, national_only)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (event_id) DO UPDATE SET
           event_name=EXCLUDED.event_name, event_date=EXCLUDED.event_date,
           location=EXCLUDED.location, registration_deadline=EXCLUDED.registration_deadline,
           entry_fee=EXCLUDED.entry_fee, start_date=EXCLUDED.start_date,
           end_date=EXCLUDED.end_date, registration_open=EXCLUDED.registration_open,
           national_only=EXCLUDED.national_only, updated_at=EXCLUDED.updated_at`,
        [row.event_id, row.event_name, row.event_date, row.location,
         row.registration_deadline, row.entry_fee, row.created_at, row.updated_at,
         row.start_date, row.end_date, row.registration_open, row.national_only]
      );
    }
    console.log(`✅  ${events.length} events`);

    // ── 2. drivers ─────────────────────────────────────────────────────────
    process.stdout.write('Syncing drivers...         ');
    const { rows: drivers } = await cloudPool.query(
      `SELECT driver_id, status, created_at, updated_at, first_name, last_name,
              preferred_name, date_of_birth, nationality, gender, championship, class,
              race_number, transponder_number, team_name, coach_name, kart_brand,
              engine_type, tyre_class, license_number, license_expiry_date,
              address_line1, suburb, city, province, postal_code, country,
              rookie_flag, academy_driver, medical_flag, notes_internal,
              id_or_passport_masked, season_engine_rental,
              is_deleted, deleted_at, national_package,
              password_hash, password_salt
       FROM drivers WHERE is_deleted IS NOT TRUE`
    );
    for (const row of drivers) {
      await localClient.query(
        `INSERT INTO drivers
           (driver_id, status, created_at, updated_at, first_name, last_name,
            preferred_name, date_of_birth, nationality, gender, championship, class,
            race_number, transponder_number, team_name, coach_name, kart_brand,
            engine_type, tyre_class, license_number, license_expiry_date,
            address_line1, suburb, city, province, postal_code, country,
            rookie_flag, academy_driver, medical_flag, notes_internal,
            id_or_passport_masked, season_engine_rental,
            is_deleted, deleted_at, national_package,
            password_hash, password_salt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,
                 $33,$34,$35,$36,$37,$38)
         ON CONFLICT (driver_id) DO UPDATE SET
           first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
           preferred_name=EXCLUDED.preferred_name, race_number=EXCLUDED.race_number,
           transponder_number=EXCLUDED.transponder_number, team_name=EXCLUDED.team_name,
           class=EXCLUDED.class, championship=EXCLUDED.championship,
           license_number=EXCLUDED.license_number, license_expiry_date=EXCLUDED.license_expiry_date,
           is_deleted=EXCLUDED.is_deleted, deleted_at=EXCLUDED.deleted_at,
           national_package=EXCLUDED.national_package,
           password_hash=EXCLUDED.password_hash, password_salt=EXCLUDED.password_salt,
           updated_at=EXCLUDED.updated_at`,
        [row.driver_id, row.status, row.created_at, row.updated_at,
         row.first_name, row.last_name, row.preferred_name, row.date_of_birth,
         row.nationality, row.gender, row.championship, row.class,
         row.race_number, row.transponder_number, row.team_name, row.coach_name,
         row.kart_brand, row.engine_type, row.tyre_class, row.license_number,
         row.license_expiry_date, row.address_line1, row.suburb, row.city,
         row.province, row.postal_code, row.country, row.rookie_flag,
         row.academy_driver, row.medical_flag, row.notes_internal,
         row.id_or_passport_masked, row.season_engine_rental,
         row.is_deleted, row.deleted_at, row.national_package,
         row.password_hash, row.password_salt]
      );
    }
    console.log(`✅  ${drivers.length} drivers`);

    // ── 3. race_entries ────────────────────────────────────────────────────
    process.stdout.write('Syncing race entries...    ');
    const { rows: entries } = await cloudPool.query(
      `SELECT entry_id, driver_id, race_name, timestamp, class, race_number,
              team_name, status, notes, race_class, entry_items, total_amount,
              payment_reference, payment_status, event_id, created_at, updated_at,
              entry_status, amount_paid, ticket_engine_ref, ticket_tyres_ref,
              ticket_transponder_ref, ticket_fuel_ref,
              engine_serial, engine_assigned_at, engine_returned, engine_returned_at,
              transponder_serial, transponder_assigned_at,
              tyre_front_left, tyre_front_right, tyre_rear_left, tyre_rear_right,
              tyres_registered_at, tyre_sets,
              driver_barcode_1, driver_barcode_2, driver_barcode_3,
              checked_in_at, checked_in_by
       FROM race_entries`
    );
    for (const row of entries) {
      await localClient.query(
        `INSERT INTO race_entries
           (entry_id, driver_id, race_name, timestamp, class, race_number,
            team_name, status, notes, race_class, entry_items, total_amount,
            payment_reference, payment_status, event_id, created_at, updated_at,
            entry_status, amount_paid, ticket_engine_ref, ticket_tyres_ref,
            ticket_transponder_ref, ticket_fuel_ref,
            engine_serial, engine_assigned_at, engine_returned, engine_returned_at,
            transponder_serial, transponder_assigned_at,
            tyre_front_left, tyre_front_right, tyre_rear_left, tyre_rear_right,
            tyres_registered_at, tyre_sets,
            driver_barcode_1, driver_barcode_2, driver_barcode_3,
            checked_in_at, checked_in_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,
                 $33,$34,$35,$36,$37,$38,$39,$40)
         ON CONFLICT (entry_id) DO UPDATE SET
           status=EXCLUDED.status, entry_status=EXCLUDED.entry_status,
           race_class=EXCLUDED.race_class, race_number=EXCLUDED.race_number,
           team_name=EXCLUDED.team_name, notes=EXCLUDED.notes,
           entry_items=EXCLUDED.entry_items, total_amount=EXCLUDED.total_amount,
           payment_status=EXCLUDED.payment_status, amount_paid=EXCLUDED.amount_paid,
           ticket_engine_ref=EXCLUDED.ticket_engine_ref,
           ticket_tyres_ref=EXCLUDED.ticket_tyres_ref,
           ticket_transponder_ref=EXCLUDED.ticket_transponder_ref,
           ticket_fuel_ref=EXCLUDED.ticket_fuel_ref,
           engine_serial=EXCLUDED.engine_serial,
           engine_assigned_at=EXCLUDED.engine_assigned_at,
           engine_returned=EXCLUDED.engine_returned,
           engine_returned_at=EXCLUDED.engine_returned_at,
           transponder_serial=EXCLUDED.transponder_serial,
           tyre_front_left=EXCLUDED.tyre_front_left,
           tyre_front_right=EXCLUDED.tyre_front_right,
           tyre_rear_left=EXCLUDED.tyre_rear_left,
           tyre_rear_right=EXCLUDED.tyre_rear_right,
           tyre_sets=EXCLUDED.tyre_sets,
           driver_barcode_1=EXCLUDED.driver_barcode_1,
           driver_barcode_2=EXCLUDED.driver_barcode_2,
           driver_barcode_3=EXCLUDED.driver_barcode_3,
           checked_in_at=EXCLUDED.checked_in_at,
           checked_in_by=EXCLUDED.checked_in_by,
           updated_at=EXCLUDED.updated_at`,
        [row.entry_id, row.driver_id, row.race_name, row.timestamp,
         row.class, row.race_number, row.team_name, row.status, row.notes,
         row.race_class, row.entry_items ? JSON.stringify(row.entry_items) : null,
         row.total_amount, row.payment_reference, row.payment_status,
         row.event_id, row.created_at, row.updated_at, row.entry_status,
         row.amount_paid, row.ticket_engine_ref, row.ticket_tyres_ref,
         row.ticket_transponder_ref, row.ticket_fuel_ref,
         row.engine_serial, row.engine_assigned_at, row.engine_returned,
         row.engine_returned_at, row.transponder_serial, row.transponder_assigned_at,
         row.tyre_front_left, row.tyre_front_right, row.tyre_rear_left, row.tyre_rear_right,
         row.tyres_registered_at,
         row.tyre_sets ? JSON.stringify(row.tyre_sets) : null,
         row.driver_barcode_1, row.driver_barcode_2, row.driver_barcode_3,
         row.checked_in_at, row.checked_in_by]
      );
    }
    console.log(`✅  ${entries.length} entries`);

    // ── 4. pool_engines ────────────────────────────────────────────────────
    process.stdout.write('Syncing pool engines...    ');
    const { rows: engines } = await cloudPool.query(
      `SELECT engine_id, draw_number, engine_serial, seal_number, carb_number,
              airbox_number, exhaust_number, class, notes, active, created_at,
              updated_at, deleted_at
       FROM pool_engines WHERE deleted_at IS NULL`
    );
    for (const row of engines) {
      await localClient.query(
        `INSERT INTO pool_engines
           (engine_id, draw_number, engine_serial, seal_number, carb_number,
            airbox_number, exhaust_number, class, notes, active, created_at,
            updated_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (engine_id) DO UPDATE SET
           draw_number=EXCLUDED.draw_number, engine_serial=EXCLUDED.engine_serial,
           seal_number=EXCLUDED.seal_number, carb_number=EXCLUDED.carb_number,
           airbox_number=EXCLUDED.airbox_number, exhaust_number=EXCLUDED.exhaust_number,
           class=EXCLUDED.class, notes=EXCLUDED.notes, active=EXCLUDED.active,
           updated_at=EXCLUDED.updated_at, deleted_at=EXCLUDED.deleted_at`,
        [row.engine_id, row.draw_number, row.engine_serial, row.seal_number,
         row.carb_number, row.airbox_number, row.exhaust_number, row.class,
         row.notes, row.active, row.created_at, row.updated_at, row.deleted_at]
      );
    }
    console.log(`✅  ${engines.length} engines`);

    // ── 5. scanners ────────────────────────────────────────────────────────
    process.stdout.write('Syncing scanners...        ');
    const { rows: scanners } = await cloudPool.query(
      `SELECT scanner_id, scanner_name, pin_code, created_at FROM scanners`
    );
    for (const row of scanners) {
      await localClient.query(
        `INSERT INTO scanners (scanner_id, scanner_name, pin_code, created_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (scanner_id) DO UPDATE SET
           scanner_name=EXCLUDED.scanner_name, pin_code=EXCLUDED.pin_code`,
        [row.scanner_id, row.scanner_name, row.pin_code, row.created_at]
      );
    }
    console.log(`✅  ${scanners.length} scanners`);

    // ── 6. entry_engine_draws (history) ───────────────────────────────────
    process.stdout.write('Syncing draw history...    ');
    const { rows: draws } = await cloudPool.query(
      `SELECT draw_id, entry_id, engine_serial, draw_number, day_label,
              session_type, assigned_at, returned, returned_at, engine_issue,
              replaced_by, notes, overnight_seal, overnight_seal_verified_at,
              carb_returned_separately, carb_overnight_seal,
              carb_overnight_seal_verified_at, carb_number
       FROM entry_engine_draws ORDER BY assigned_at`
    );
    for (const row of draws) {
      await localClient.query(
        `INSERT INTO entry_engine_draws
           (draw_id, entry_id, engine_serial, draw_number, day_label,
            session_type, assigned_at, returned, returned_at, engine_issue,
            replaced_by, notes, overnight_seal, overnight_seal_verified_at,
            carb_returned_separately, carb_overnight_seal,
            carb_overnight_seal_verified_at, carb_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (draw_id) DO UPDATE SET
           returned=EXCLUDED.returned, returned_at=EXCLUDED.returned_at,
           session_type=EXCLUDED.session_type,
           overnight_seal=EXCLUDED.overnight_seal,
           overnight_seal_verified_at=EXCLUDED.overnight_seal_verified_at,
           carb_returned_separately=EXCLUDED.carb_returned_separately,
           carb_overnight_seal=EXCLUDED.carb_overnight_seal,
           carb_overnight_seal_verified_at=EXCLUDED.carb_overnight_seal_verified_at,
           carb_number=EXCLUDED.carb_number`,
        [row.draw_id, row.entry_id, row.engine_serial, row.draw_number,
         row.day_label, row.session_type, row.assigned_at, row.returned,
         row.returned_at, row.engine_issue, row.replaced_by, row.notes,
         row.overnight_seal, row.overnight_seal_verified_at,
         row.carb_returned_separately, row.carb_overnight_seal,
         row.carb_overnight_seal_verified_at, row.carb_number]
      );
    }
    console.log(`✅  ${draws.length} draw records`);

    await localClient.query('COMMIT');

    // ── Summary ────────────────────────────────────────────────────────────
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  ✅ SYNC COMPLETE — local DB is up to date       ║');
    console.log('║                                                  ║');
    console.log(`║  Events:    ${String(events.length).padEnd(4)}  Drivers:  ${String(drivers.length).padEnd(4)}              ║`);
    console.log(`║  Entries:   ${String(entries.length).padEnd(4)}  Engines:  ${String(engines.length).padEnd(4)}              ║`);
    console.log(`║  Scanners:  ${String(scanners.length).padEnd(4)}  Draws:    ${String(draws.length).padEnd(4)}              ║`);
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('\nYou can now disconnect from the internet and run start_raceday.bat\n');

  } catch (err) {
    await localClient.query('ROLLBACK');
    console.error('\n❌ SYNC FAILED — rolled back. No local data was changed.');
    console.error('   Error:', err.message);
    process.exit(1);
  } finally {
    localClient.release();
    await localPool.end();
    await cloudPool.end();
  }
}

main().catch(async e => {
  console.error('\n❌ Unexpected error:', e.message);
  await localPool.end().catch(() => {});
  await cloudPool.end().catch(() => {});
  process.exit(1);
});
