#!/usr/bin/env node
/**
 * create_test_entry_win.js
 * ───────────────────────────────────────────────────────────────────────────
 * Creates a fully-populated race entry for win@rokthenats.co.za with all four
 * ticket types (Engine, Tyres, Transponder, Fuel) so you can test the engine
 * and equipment workflows offline / in development.
 *
 * Usage:
 *   node scripts/create_test_entry_win.js
 *   node scripts/create_test_entry_win.js --event event_redstar_001
 *
 * What it does:
 *   1. Looks up the driver record linked to win@rokthenats.co.za
 *   2. Picks the most-recent (or first upcoming) event – or creates a stub
 *      "Test Event 2026" if none exist
 *   3. Inserts a race_entry with:
 *        • payment_status  = 'Completed'
 *        • entry_status    = 'confirmed'
 *        • entry_items     = Engine Rental, Tyres, Transponder, Fuel
 *        • ticket_engine_ref, ticket_tyres_ref, ticket_transponder_ref,
 *          ticket_fuel_ref all pre-generated in the correct barcode format
 *   4. Prints every ticket barcode so you can scan / test them immediately
 *
 * Re-running is safe: an existing entry for the same driver+event is reused
 * and tickets are regenerated only where they are missing.
 * ───────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user:     process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

// ── Ticket-ref generator (matches server.js logic exactly) ──────────────────
function generateTicketRef(type) {
  const prefixes = { engine: 'ENG', tyres: 'TYR', transponder: 'TX', fuel: 'GAS' };
  const prefix = prefixes[type] || 'TKT';
  let num;
  if (type === 'engine') {
    num = Math.floor(5500 + Math.random() * 100); // ENG5500–ENG5599
  } else {
    num = Math.floor(1000 + Math.random() * 9000);
  }
  return `${prefix}${num}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  // Optional --event <event_id> CLI argument
  const eventArgIdx = process.argv.indexOf('--event');
  const forcedEventId = eventArgIdx !== -1 ? process.argv[eventArgIdx + 1] : null;
  try {
    // ── 1. Find driver ──────────────────────────────────────────────────────
    const driverRes = await pool.query(
      `SELECT d.driver_id, d.first_name, d.last_name, d.race_number, d.class
         FROM drivers d
         JOIN contacts c ON c.driver_id = d.driver_id
        WHERE LOWER(c.email) = 'win@rokthenats.co.za'
        LIMIT 1`
    );
    if (!driverRes.rows.length) {
      console.error('❌  Cannot find driver linked to win@rokthenats.co.za');
      process.exit(1);
    }
    const driver = driverRes.rows[0];
    console.log(`✅  Driver:       ${driver.first_name} ${driver.last_name}`);
    console.log(`   driver_id:    ${driver.driver_id}`);
    console.log(`   race_number:  ${driver.race_number || '—'}`);
    console.log(`   class:        ${driver.class       || '—'}`);

    // ── 2. Find / create event ─────────────────────────────────────────────
    let eventRes;
    if (forcedEventId) {
      eventRes = await pool.query(
        `SELECT event_id, event_name, event_date, location FROM events WHERE event_id = $1`,
        [forcedEventId]
      );
      if (!eventRes.rows.length) {
        console.error(`❌  Event not found: ${forcedEventId}`);
        process.exit(1);
      }
    } else {
      eventRes = await pool.query(
        `SELECT event_id, event_name, event_date, location
           FROM events
          ORDER BY event_date DESC
          LIMIT 1`
      );
    }

    let event;
    if (eventRes.rows.length) {
      event = eventRes.rows[0];
      console.log(`\n✅  Event:        ${event.event_name} (${event.event_id})`);
    } else {
      // No events at all – create a stub test event
      const stubId = `evt_test_${Date.now()}`;
      await pool.query(
        `INSERT INTO events (event_id, event_name, event_date, location, status, created_at, updated_at)
              VALUES ($1, $2, CURRENT_DATE + INTERVAL '7 days', $3, 'active', NOW(), NOW())`,
        [stubId, 'Test Event 2026 (stub)', 'Test Venue, Johannesburg']
      );
      event = { event_id: stubId, event_name: 'Test Event 2026 (stub)', location: 'Test Venue, Johannesburg' };
      console.log(`\n⚠️   No events found – created stub event: ${stubId}`);
    }

    // ── 3. Check for existing entry ────────────────────────────────────────
    const existingRes = await pool.query(
      `SELECT entry_id,
              ticket_engine_ref, ticket_tyres_ref,
              ticket_transponder_ref, ticket_fuel_ref
         FROM race_entries
        WHERE driver_id = $1
          AND event_id  = $2
          AND entry_status != 'cancelled'
        ORDER BY created_at DESC
        LIMIT 1`,
      [driver.driver_id, event.event_id]
    );

    let entryId;
    let engRef, tyrRef, txRef, gasRef;

    if (existingRes.rows.length) {
      // ── Reuse existing entry, fill missing tickets only ──────────────────
      const ex = existingRes.rows[0];
      entryId = ex.entry_id;
      engRef  = ex.ticket_engine_ref       || generateTicketRef('engine');
      tyrRef  = ex.ticket_tyres_ref        || generateTicketRef('tyres');
      txRef   = ex.ticket_transponder_ref  || generateTicketRef('transponder');
      gasRef  = ex.ticket_fuel_ref         || generateTicketRef('fuel');

      await pool.query(
        `UPDATE race_entries
            SET ticket_engine_ref      = $1,
                ticket_tyres_ref       = $2,
                ticket_transponder_ref = $3,
                ticket_fuel_ref        = $4,
                entry_items            = $5::jsonb,
                payment_status         = 'Completed',
                entry_status           = 'confirmed',
                engine                 = 1,
                updated_at             = NOW()
          WHERE entry_id = $6`,
        [
          engRef, tyrRef, txRef, gasRef,
          JSON.stringify(['Engine Rental', 'Tyres (Optional)', 'Rent Transponder', 'Controlled Fuel']),
          entryId
        ]
      );
      console.log(`\n♻️   Existing entry updated: ${entryId}`);
    } else {
      // ── Insert fresh entry ───────────────────────────────────────────────
      entryId = `race_entry_${Date.now()}_test`;
      engRef  = generateTicketRef('engine');
      tyrRef  = generateTicketRef('tyres');
      txRef   = generateTicketRef('transponder');
      gasRef  = generateTicketRef('fuel');

      const raceClass = driver.class || 'MINI ROK';

      await pool.query(
        `INSERT INTO race_entries (
           entry_id, event_id, driver_id,
           race_class, entry_items,
           payment_status, entry_status,
           amount_paid,
           engine,
           ticket_engine_ref, ticket_tyres_ref,
           ticket_transponder_ref, ticket_fuel_ref,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3,
           $4, $5::jsonb,
           'Completed', 'confirmed',
           15600,
           1,
           $6, $7, $8, $9,
           NOW(), NOW()
         )`,
        [
          entryId,
          event.event_id,
          driver.driver_id,
          raceClass,
          JSON.stringify(['Engine Rental', 'Tyres (Optional)', 'Rent Transponder', 'Controlled Fuel']),
          engRef, tyrRef, txRef, gasRef
        ]
      );
      console.log(`\n✅  New entry created: ${entryId}`);
    }

    // ── 4. Print all tickets ───────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  TEST TICKETS  –  win@rokthenats.co.za');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Entry ID          : ${entryId}`);
    console.log(`  Event             : ${event.event_name}`);
    console.log(`  Driver            : ${driver.first_name} ${driver.last_name}`);
    console.log(`  Race Class        : ${driver.class || 'MINI ROK'}`);
    console.log('');
    console.log(`  🔧  Engine Ticket     : ${engRef}`);
    console.log(`  🛞  Tyres Ticket      : ${tyrRef}`);
    console.log(`  📡  Transponder Ticket: ${txRef}`);
    console.log(`  ⛽  Fuel Ticket       : ${gasRef}`);
    console.log('═══════════════════════════════════════════════════════');
    console.log('\n📋  Quick-test barcodes (copy-paste into scanner fields):');
    console.log(`   ${engRef}   ${tyrRef}   ${txRef}   ${gasRef}`);
    console.log('\n✅  Done.\n');

  } catch (err) {
    console.error('❌  Error:', err.message);
    if (err.detail) console.error('   Detail:', err.detail);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
