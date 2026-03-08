/**
 * Fix #14: Engine / Equipment management routes extracted from server.js
 *
 * Factory function pattern: dependencies (pool, logEquipmentScan) are injected
 * instead of using module-level globals, keeping this file testable in isolation.
 *
 * Mount in server.js:
 *   app.use(require('./routes/equipment')(pool, logEquipmentScan));
 */

const { Router } = require('express');

module.exports = function equipmentRoutes(pool, logEquipmentScan) {
  const router = Router();

  // =============================================
  // ENGINE MANAGEMENT API ENDPOINTS
  // =============================================

  // Lookup ticket barcode and get driver info
  router.get('/api/lookupTicket', async (req, res) => {
    try {
      const { barcode } = req.query;

      if (!barcode) {
        return res.json({ success: false, error: 'Barcode required' });
      }

      const barcodeUpper = barcode.toUpperCase();

      // Determine ticket type from barcode prefix
      let ticketColumn = null;
      let ticketType = '';

      if (barcodeUpper.startsWith('ENG')) {
        ticketColumn = 'ticket_engine_ref';
        ticketType = 'Engine Rental';
      } else if (barcodeUpper.startsWith('TYR')) {
        ticketColumn = 'ticket_tyres_ref';
        ticketType = 'Tyres';
      } else if (barcodeUpper.startsWith('TX')) {
        ticketColumn = 'ticket_transponder_ref';
        ticketType = 'Transponder';
      } else if (barcodeUpper.startsWith('GAS')) {
        ticketColumn = 'ticket_fuel_ref';
        ticketType = 'Fuel';
      } else {
        return res.json({ success: false, error: 'Invalid barcode format' });
      }

      // Find entry with this ticket (supports both single ref and JSON array stored refs)
      const result = await pool.query(`
        SELECT re.entry_id, re.driver_id, re.race_class, re.engine_serial,
               re.engine_returned, re.event_id,
               re.tyre_front_left, re.tyre_front_right, re.tyre_rear_left, re.tyre_rear_right,
               re.tyre_sets, re.ticket_tyres_ref,
               d.first_name, d.last_name, d.race_number, d.transponder_number
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.${ticketColumn} = $1
           OR re.${ticketColumn}::text LIKE '%' || $1 || '%'
        ORDER BY re.created_at DESC
        LIMIT 1
      `, [barcodeUpper]);

      if (result.rows.length === 0) {
        return res.json({ success: false, error: 'No entry found for this ticket' });
      }

      const entry = result.rows[0];

      await logEquipmentScan({
        scan_type: 'ticket_lookup',
        barcode_scanned: barcodeUpper,
        entry_id: entry.entry_id,
        driver_id: entry.driver_id,
        driver_name: `${entry.first_name} ${entry.last_name}`,
        scanned_by: 'System',
        action_result: 'success',
        notes: `Looked up ${ticketType} ticket`,
        race_class: entry.race_class
      });

      const fl = entry.tyre_front_left;
      const fr = entry.tyre_front_right;
      const rl = entry.tyre_rear_left;
      const rr = entry.tyre_rear_right;
      const tyreSets = Array.isArray(entry.tyre_sets) ? entry.tyre_sets : [];
      if (tyreSets.length === 0 && fl && fr && rl && rr) tyreSets.push({ fl, fr, rl, rr });
      const allTyreSerials = [];
      tyreSets.forEach(s => {
        ['fl','fr','rl','rr'].forEach(k => { if (s[k]) allTyreSerials.push(s[k].toUpperCase()); });
      });
      const tyresOk = allTyreSerials.length >= 4;

      res.json({
        success: true,
        driver: {
          driver_id: entry.driver_id,
          entry_id: entry.entry_id,
          first_name: entry.first_name,
          last_name: entry.last_name,
          race_class: entry.race_class,
          race_number: entry.race_number,
          transponder_number: entry.transponder_number,
          event_id: entry.event_id || null,
          ticket_tyres_ref: entry.ticket_tyres_ref || null,
          registered_tyres: tyresOk,
          tyre_sets: tyreSets,
          all_tyre_serials: allTyreSerials,
          tyres: tyresOk ? { front_left: fl, front_right: fr, rear_left: rl, rear_right: rr } : null
        },
        ticket: {
          barcode: barcodeUpper,
          type: ticketType,
          engine_serial: (entry.engine_serial && entry.engine_returned !== true) ? entry.engine_serial : null
        }
      });
    } catch (err) {
      console.error('Error looking up ticket:', err);
      res.json({ success: false, error: 'Failed to look up ticket' });
    }
  });

  // Assign engine to driver
  router.post('/api/assignEngine', async (req, res) => {
    const client = await pool.connect();
    try {
      const { ticketBarcode, engineSerial, driverId, entryId, drawNumber, dayLabel } = req.body;

      if (!engineSerial || !driverId || !entryId) {
        client.release();
        return res.json({ success: false, error: 'Missing required fields' });
      }
      const barcodeKey = (ticketBarcode && ticketBarcode !== 'NO-TICKET') ? ticketBarcode : null;
      const noTicketFlag = !barcodeKey;

      await client.query('BEGIN');

      // Check if engine is already assigned — if so, clear and force-reassign
      const existingAssignment = await client.query(`
        SELECT re.entry_id, d.first_name, d.last_name
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.engine_serial = $1 AND (re.engine_returned = false OR re.engine_returned IS NULL)
      `, [engineSerial.toUpperCase()]);

      let reassignWarning = null;
      if (existingAssignment.rows.length > 0) {
        const prev = existingAssignment.rows[0];
        if (prev.entry_id !== entryId) {
          reassignWarning = `⚠️ Engine ${engineSerial} was previously assigned to ${prev.first_name} ${prev.last_name} — reassigned`;
          await client.query(`
            UPDATE race_entries
            SET engine_serial = NULL, engine_assigned_at = NULL, updated_at = NOW()
            WHERE entry_id = $1
          `, [prev.entry_id]);
        }
      }

      const assignResult = await client.query(`
        UPDATE race_entries 
        SET engine_serial = $1, 
            engine_assigned_at = NOW(),
            engine_returned = false,
            updated_at = NOW()
        WHERE entry_id = $2
        RETURNING driver_id, race_class, event_id
      `, [engineSerial.toUpperCase(), entryId]);

      await client.query('COMMIT');

      // Non-critical: history record — outside transaction so a failure doesn't undo the assignment
      const driverInfo = await pool.query(`
        SELECT first_name, last_name FROM drivers WHERE driver_id = $1
      `, [driverId]);
      const driverName = driverInfo.rows[0]
        ? `${driverInfo.rows[0].first_name} ${driverInfo.rows[0].last_name}`
        : 'Unknown';

      try {
        await pool.query(
          `INSERT INTO entry_engine_draws (entry_id, engine_serial, draw_number, day_label, assigned_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [entryId, engineSerial.toUpperCase(), drawNumber || null, dayLabel || null]
        );
      } catch (drawErr) {
        console.warn('⚠️ entry_engine_draws insert failed (non-fatal):', drawErr.message);
      }

      await logEquipmentScan({
        scan_type: 'engine_assign',
        barcode_scanned: barcodeKey || 'NO-TICKET',
        entry_id: entryId,
        driver_id: driverId,
        driver_name: driverName,
        equipment_serial: engineSerial.toUpperCase(),
        scanned_by: 'System',
        action_result: 'success',
        notes: `${dayLabel ? '[' + dayLabel + '] ' : ''}${drawNumber ? 'Draw #' + drawNumber + ' — ' : ''}Engine ${engineSerial} assigned${noTicketFlag ? ' [NO TICKET SCANNED]' : ''}`,
        event_id: assignResult.rows[0]?.event_id,
        race_class: assignResult.rows[0]?.race_class
      });

      console.log(`✅ Engine ${engineSerial} assigned to driver ${driverId} (Entry: ${entryId})${noTicketFlag ? ' [NO TICKET]' : ''}`);
      const warnings = [reassignWarning, noTicketFlag ? '⚠️ No ticket scanned — assignment flagged' : null].filter(Boolean);
      res.json({ success: true, warning: warnings.length ? warnings.join(' | ') : null });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error assigning engine:', err);
      res.json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Return engine — full version with peripherals, signature & scannedBy
  router.post('/api/returnEngine', async (req, res) => {
    const client = await pool.connect();
    try {
      const {
        engineSerial, entryId, driverId,
        peripheralsChecked, signatureData, scannedBy,
        notes: clientNotes
      } = req.body;

      if (!engineSerial && !entryId) {
        client.release();
        return res.json({ success: false, error: 'Engine serial or entry ID required' });
      }

      await client.query('BEGIN');

      let result;
      if (entryId) {
        result = await client.query(`
          SELECT re.entry_id, re.engine_serial, re.driver_id, re.event_id, re.race_class,
                 d.first_name, d.last_name
          FROM race_entries re JOIN drivers d ON re.driver_id = d.driver_id
          WHERE re.entry_id = $1 AND (re.engine_returned = false OR re.engine_returned IS NULL)
        `, [entryId]);
      } else {
        result = await client.query(`
          SELECT re.entry_id, re.engine_serial, re.driver_id, re.event_id, re.race_class,
                 d.first_name, d.last_name
          FROM race_entries re JOIN drivers d ON re.driver_id = d.driver_id
          WHERE UPPER(re.engine_serial) = UPPER($1) AND (re.engine_returned = false OR re.engine_returned IS NULL)
        `, [engineSerial.toUpperCase()]);
      }

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.json({ success: false, error: 'No active engine assignment found' });
      }

      const row        = result.rows[0];
      const theSerial  = (engineSerial || row.engine_serial || '').toUpperCase();
      const driverName = `${row.first_name} ${row.last_name}`;

      await client.query(`
        UPDATE race_entries
        SET engine_returned = true, engine_returned_at = NOW(), updated_at = NOW()
        WHERE entry_id = $1
      `, [row.entry_id]);

      // Close the draw record in multi-draw history
      await client.query(
        `UPDATE entry_engine_draws
         SET returned = true, returned_at = NOW()
         WHERE entry_id = $1 AND UPPER(engine_serial) = $2 AND returned = false`,
        [row.entry_id, theSerial]
      );

      await client.query('COMMIT');

      const periSummary = peripheralsChecked
        ? Object.entries(peripheralsChecked)
            .map(([k, v]) => `${k.replace('_number', '').toUpperCase()}:${v}`)
            .join(' ')
        : 'no component check';

      const fullNotes = [
        `Engine ${theSerial} returned by ${driverName}`,
        `Components: ${periSummary}`,
        clientNotes || null,
        scannedBy ? `Operator: ${scannedBy}` : null
      ].filter(Boolean).join(' | ');

      await logEquipmentScan({
        scan_type:        'engine_return',
        barcode_scanned:  theSerial || 'N/A',
        entry_id:         row.entry_id,
        driver_id:        row.driver_id || driverId,
        driver_name:      driverName,
        equipment_serial: theSerial || 'N/A',
        scanned_by:       scannedBy || 'Return Station',
        action_result:    'success',
        notes:            fullNotes,
        event_id:         row.event_id,
        race_class:       row.race_class,
        signature_data:   signatureData || null
      });

      try {
        await pool.query(
          `INSERT INTO audit_log (action, field_name, old_value, new_value, driver_email, created_at) VALUES ($1,$2,$3,$4,$5,NOW())`,
          ['engine_returned', 'engine_returned', `assigned: ${theSerial}`, 'returned',
           `${driverName} | ${periSummary}`]
        );
      } catch (auditErr) {
        console.warn('⚠️ audit_log insert failed (non-fatal):', auditErr.message);
      }

      console.log(`✅ Engine ${theSerial} returned from ${driverName}${signatureData ? ' [signed]' : ''}`);
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error returning engine:', err);
      res.json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  // Report engine issue
  router.post('/api/reportEngineIssue', async (req, res) => {
    const client = await pool.connect();
    try {
      const { engineSerial, issueDescription } = req.body;

      if (!engineSerial || !issueDescription) {
        client.release();
        return res.json({ success: false, error: 'Engine serial and issue description required' });
      }

      await client.query('BEGIN');

      const result = await client.query(`
        SELECT re.entry_id, re.driver_id, d.first_name, d.last_name
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.engine_serial = $1 AND re.engine_returned = false
      `, [engineSerial.toUpperCase()]);

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.json({ success: false, error: 'No active assignment found for this engine' });
      }

      const entry = result.rows[0];

      await client.query(`
        UPDATE race_entries 
        SET engine_returned = true,
            engine_returned_at = NOW(),
            engine_issue = $2,
            updated_at = NOW()
        WHERE engine_serial = $1 AND engine_returned = false
      `, [engineSerial.toUpperCase(), issueDescription]);

      // Close the draw record with issue note
      await client.query(
        `UPDATE entry_engine_draws
         SET returned = true, returned_at = NOW(), engine_issue = $3
         WHERE entry_id = $1 AND UPPER(engine_serial) = $2 AND returned = false`,
        [entry.entry_id, engineSerial.toUpperCase(), issueDescription]
      );

      await client.query('COMMIT');

      await logEquipmentScan({
        scan_type:        'engine_issue',
        barcode_scanned:  engineSerial.toUpperCase(),
        entry_id:         entry.entry_id,
        driver_id:        entry.driver_id,
        driver_name:      `${entry.first_name} ${entry.last_name}`,
        equipment_serial: engineSerial.toUpperCase(),
        scanned_by:       'Issue Reporter',
        action_result:    'issue',
        notes:            `Issue reported: ${issueDescription}`
      });

      console.log(`⚠️ Engine ${engineSerial} reported with issue: ${issueDescription}`);
      res.json({ success: true, driverId: entry.driver_id, entryId: entry.entry_id });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error reporting engine issue:', err);
      res.json({ success: false, error: 'Failed to report engine issue' });
    } finally {
      client.release();
    }
  });

  // Assign replacement engine
  router.post('/api/assignReplacementEngine', async (req, res) => {
    const client = await pool.connect();
    try {
      const { replacementSerial, returnedSerial, driverId, entryId } = req.body;

      if (!replacementSerial || !returnedSerial || !driverId || !entryId) {
        client.release();
        return res.json({ success: false, error: 'Missing required fields' });
      }

      // Check before opening transaction — read-only guard
      const existingAssignment = await client.query(`
        SELECT re.entry_id, d.first_name, d.last_name
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.engine_serial = $1 AND re.engine_returned = false
      `, [replacementSerial.toUpperCase()]);

      if (existingAssignment.rows.length > 0) {
        const existing = existingAssignment.rows[0];
        client.release();
        return res.json({
          success: false,
          error: `Engine ${replacementSerial} is already assigned to ${existing.first_name} ${existing.last_name}`
        });
      }

      await client.query('BEGIN');

      await client.query(`
        UPDATE race_entries 
        SET engine_serial = $1, 
            engine_assigned_at = NOW(),
            engine_returned = false,
            replacement_for = $3,
            updated_at = NOW()
        WHERE entry_id = $2
      `, [replacementSerial.toUpperCase(), entryId, returnedSerial.toUpperCase()]);

      // Close the returned draw and open a new one for the replacement
      await client.query(
        `UPDATE entry_engine_draws
         SET returned = true, returned_at = NOW(), replaced_by = $3
         WHERE entry_id = $1 AND UPPER(engine_serial) = $2 AND returned = false`,
        [entryId, returnedSerial.toUpperCase(), replacementSerial.toUpperCase()]
      );
      await client.query(
        `INSERT INTO entry_engine_draws (entry_id, engine_serial, assigned_at, notes)
         VALUES ($1, $2, NOW(), $3)`,
        [entryId, replacementSerial.toUpperCase(), `Replacement for ${returnedSerial}`]
      );

      await client.query('COMMIT');

      const _repDriverInfo = await pool.query(
        'SELECT first_name, last_name FROM drivers WHERE driver_id=$1', [driverId]
      );
      const _repName = _repDriverInfo.rows[0]
        ? `${_repDriverInfo.rows[0].first_name} ${_repDriverInfo.rows[0].last_name}`
        : 'Unknown';
      await logEquipmentScan({
        scan_type:        'engine_replacement',
        barcode_scanned:  replacementSerial.toUpperCase(),
        entry_id:         entryId,
        driver_id:        driverId,
        driver_name:      _repName,
        equipment_serial: replacementSerial.toUpperCase(),
        scanned_by:       'System',
        action_result:    'success',
        notes:            `Replacement engine ${replacementSerial} assigned (replaced ${returnedSerial})`
      });

      console.log(`✅ Replacement engine ${replacementSerial} assigned (replaced ${returnedSerial})`);
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error assigning replacement engine:', err);
      res.json({ success: false, error: 'Failed to assign replacement engine' });
    } finally {
      client.release();
    }
  });

  // Assign transponder
  router.post('/api/assignTransponder', async (req, res) => {
    try {
      const { ticketBarcode, transponderSerial, driverId, entryId } = req.body;

      if (!ticketBarcode || !transponderSerial || !driverId || !entryId) {
        return res.json({ success: false, error: 'Missing required fields' });
      }

      const txResult = await pool.query(`
        UPDATE race_entries 
        SET transponder_serial = $1,
            transponder_assigned_at = NOW(),
            updated_at = NOW()
        WHERE entry_id = $2
        RETURNING driver_id, race_class, event_id
      `, [transponderSerial.toUpperCase(), entryId]);

      const driverInfo = await pool.query(`
        SELECT first_name, last_name FROM drivers WHERE driver_id = $1
      `, [driverId]);

      const driverName = driverInfo.rows[0]
        ? `${driverInfo.rows[0].first_name} ${driverInfo.rows[0].last_name}`
        : 'Unknown';

      await logEquipmentScan({
        scan_type: 'transponder_assign',
        barcode_scanned: ticketBarcode,
        entry_id: entryId,
        driver_id: driverId,
        driver_name: driverName,
        equipment_serial: transponderSerial.toUpperCase(),
        scanned_by: 'System',
        action_result: 'success',
        notes: `Transponder ${transponderSerial} assigned`,
        event_id: txResult.rows[0]?.event_id,
        race_class: txResult.rows[0]?.race_class
      });

      console.log(`✅ Transponder ${transponderSerial} assigned to driver ${driverId}`);
      res.json({ success: true });
    } catch (err) {
      console.error('Error assigning transponder:', err);
      res.json({ success: false, error: 'Failed to assign transponder' });
    }
  });

  // Assign tyres — appends a new set of 4 to tyre_sets array (never overwrites)
  router.post('/api/assignTyres', async (req, res) => {
    try {
      const { ticketBarcode, tyres, driverId, entryId, scannedBy } = req.body;

      if (!tyres || !driverId || !entryId) {
        return res.json({ success: false, error: 'Missing required fields' });
      }

      const { front_left, front_right, rear_left, rear_right } = tyres;

      if (!front_left || !front_right || !rear_left || !rear_right) {
        return res.json({ success: false, error: 'All 4 tyre serials required' });
      }

      const fl = front_left.toUpperCase();
      const fr = front_right.toUpperCase();
      const rl = rear_left.toUpperCase();
      const rr = rear_right.toUpperCase();

      // Fetch existing tyre_sets array
      const existing = await pool.query(
        'SELECT tyre_sets FROM race_entries WHERE entry_id = $1',
        [entryId]
      );
      const currentSets = existing.rows[0]?.tyre_sets || [];
      const newSet = { fl, fr, rl, rr, registered_at: new Date().toISOString() };
      const updatedSets = [...currentSets, newSet];
      const setNumber = updatedSets.length;

      // Update: append to tyre_sets; also keep the 4 individual columns pointing at most recent set
      const tyreResult = await pool.query(`
        UPDATE race_entries
        SET tyre_front_left = $1,
            tyre_front_right = $2,
            tyre_rear_left = $3,
            tyre_rear_right = $4,
            tyre_sets = $5::jsonb,
            tyres_registered_at = NOW(),
            updated_at = NOW()
        WHERE entry_id = $6
        RETURNING driver_id, race_class, event_id
      `, [fl, fr, rl, rr, JSON.stringify(updatedSets), entryId]);

      const driverInfo = await pool.query(
        'SELECT first_name, last_name FROM drivers WHERE driver_id = $1',
        [driverId]
      );
      const driverName = driverInfo.rows[0]
        ? `${driverInfo.rows[0].first_name} ${driverInfo.rows[0].last_name}`
        : 'Unknown';

      await logEquipmentScan({
        scan_type: 'tyres_register',
        barcode_scanned: ticketBarcode || null,
        entry_id: entryId,
        driver_id: driverId,
        driver_name: driverName,
        equipment_serial: `FL:${fl} FR:${fr} RL:${rl} RR:${rr}`,
        scanned_by: scannedBy || 'Tyre Station',
        action_result: 'success',
        notes: `Set #${setNumber}: FL:${fl} FR:${fr} RL:${rl} RR:${rr} (total sets: ${setNumber})`,
        event_id: tyreResult.rows[0]?.event_id,
        race_class: tyreResult.rows[0]?.race_class
      });

      console.log(`✅ Tyre set #${setNumber} registered for driver ${driverId}`);
      res.json({ success: true, setNumber, totalSets: setNumber });
    } catch (err) {
      console.error('Error assigning tyres:', err);
      res.json({ success: false, error: 'Failed to assign tyres' });
    }
  });

  // Mark fuel collected
  router.post('/api/markFuelCollected', async (req, res) => {
    try {
      const { ticketBarcode, driverId, entryId } = req.body;

      if (!ticketBarcode || !driverId || !entryId) {
        return res.json({ success: false, error: 'Missing required fields' });
      }

      const fuelResult = await pool.query(`
        UPDATE race_entries 
        SET fuel_collected = true,
            fuel_collected_at = NOW(),
            updated_at = NOW()
        WHERE entry_id = $1
        RETURNING driver_id, race_class, event_id
      `, [entryId]);

      const driverInfo = await pool.query(`
        SELECT first_name, last_name FROM drivers WHERE driver_id = $1
      `, [driverId]);

      const driverName = driverInfo.rows[0]
        ? `${driverInfo.rows[0].first_name} ${driverInfo.rows[0].last_name}`
        : 'Unknown';

      await logEquipmentScan({
        scan_type: 'fuel_collect',
        barcode_scanned: ticketBarcode,
        entry_id: entryId,
        driver_id: driverId,
        driver_name: driverName,
        scanned_by: 'System',
        action_result: 'success',
        notes: 'Fuel collected',
        event_id: fuelResult.rows[0]?.event_id,
        race_class: fuelResult.rows[0]?.race_class
      });

      console.log(`✅ Fuel marked as collected for driver ${driverId}`);
      res.json({ success: true });
    } catch (err) {
      console.error('Error marking fuel collected:', err);
      res.json({ success: false, error: 'Failed to mark fuel collected' });
    }
  });

  // Titan Terminal Authentication
  router.post('/titan/authenticate', (req, res) => {
    const { password } = req.body;
    const TITAN_PASSWORD = process.env.TITAN_PASSWORD || 'titan2026';
    if (password === TITAN_PASSWORD) {
      res.status(200).json({ success: true });
    } else {
      res.status(401).json({ success: false, error: 'Invalid password' });
    }
  });

  // Get equipment scan log with limit
  router.get('/api/getEquipmentScanLog', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 500); // cap at 500

      const result = await pool.query(`
        SELECT 
          log_id, scan_timestamp, scan_type, barcode_scanned,
          entry_id, driver_id, driver_name, equipment_serial,
          scanned_by, action_result, notes, event_id, race_class
        FROM equipment_scan_log
        ORDER BY scan_timestamp DESC
        LIMIT $1
      `, [limit]);

      res.json(result.rows);
    } catch (err) {
      console.error('Error fetching equipment scan log:', err);
      res.status(500).json({ error: 'Failed to load scan log' });
    }
  });

  // Full history timeline for a driver entry (for admin detail panel)
  router.get('/api/driverHistory', async (req, res) => {
    try {
      const { entry_id } = req.query;
      if (!entry_id) return res.json({ success: false, error: 'entry_id required' });

      const entryRes = await pool.query(`
        SELECT re.entry_id, re.race_class, re.race_number, re.event_id,
               re.engine_serial, re.engine_assigned_at, re.engine_returned, re.engine_returned_at,
               re.engine_issue,
               re.tyre_front_left, re.tyre_front_right, re.tyre_rear_left, re.tyre_rear_right,
               re.tyres_registered_at, re.tyre_sets,
               re.transponder_serial, re.transponder_assigned_at,
               re.fuel_collected, re.fuel_collected_at,
               re.ticket_engine_ref, re.ticket_tyres_ref, re.ticket_transponder_ref, re.ticket_fuel_ref,
               d.first_name, d.last_name, d.race_number as driver_race_number,
               e.event_name, e.event_date
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        LEFT JOIN events e ON re.event_id = e.event_id
        WHERE re.entry_id = $1
      `, [entry_id]);

      if (entryRes.rows.length === 0) return res.json({ success: false, error: 'Entry not found' });
      const entry = entryRes.rows[0];

      // Pool engine parts for this engine serial
      let poolParts = null;
      if (entry.engine_serial) {
        const pRes = await pool.query(
          `SELECT draw_number, seal_number, carb_number, airbox_number, exhaust_number
           FROM pool_engines WHERE LOWER(engine_serial) = LOWER($1) LIMIT 1`,
          [entry.engine_serial]
        );
        poolParts = pRes.rows[0] || null;
      }

      const logsRes = await pool.query(`
        SELECT log_id, scan_timestamp, scan_type, barcode_scanned,
               equipment_serial, scanned_by, action_result, notes, race_class, event_id
        FROM equipment_scan_log
        WHERE entry_id = $1
        ORDER BY scan_timestamp ASC
      `, [entry_id]);

      // All engine draws for this entry (multi-draw support)
      const drawsRes = await pool.query(`
        SELECT eed.draw_id, eed.engine_serial, eed.draw_number, eed.day_label,
               eed.assigned_at, eed.returned, eed.returned_at, eed.engine_issue,
               eed.replaced_by, eed.notes as draw_notes,
               pe.seal_number, pe.carb_number, pe.airbox_number, pe.exhaust_number
        FROM entry_engine_draws eed
        LEFT JOIN pool_engines pe
          ON LOWER(eed.engine_serial) = LOWER(pe.engine_serial) AND pe.deleted_at IS NULL
        WHERE eed.entry_id = $1
        ORDER BY eed.assigned_at ASC
      `, [entry_id]).catch(() => ({ rows: [] }));

      res.json({ success: true, entry, pool: poolParts, draws: drawsRes.rows, logs: logsRes.rows });
    } catch (err) {
      console.error('driverHistory error:', err);
      res.json({ success: false, error: err.message });
    }
  });

  // Full history timeline for a piece of equipment (for admin detail panel)
  router.get('/api/equipmentHistory', async (req, res) => {
    try {
      const { serial } = req.query;
      if (!serial) return res.json({ success: false, error: 'serial required' });
      const s = serial.toUpperCase();

      // Exclude tyre events — tyres have their own per-driver history
      const logsRes = await pool.query(`
        SELECT log_id, scan_timestamp, scan_type, barcode_scanned,
               entry_id, driver_name, equipment_serial, scanned_by, action_result, notes, event_id, race_class
        FROM equipment_scan_log
        WHERE equipment_serial = $1
          AND scan_type NOT IN ('tyres_register','tyre_verify','tyres_verify')
        ORDER BY scan_timestamp ASC
      `, [s]);

      const assignRes = await pool.query(`
        SELECT re.entry_id, re.engine_assigned_at, re.engine_returned, re.engine_returned_at,
               re.engine_issue, re.race_class, re.event_id,
               d.first_name, d.last_name, d.race_number,
               e.event_name, e.event_date
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        LEFT JOIN events e ON re.event_id = e.event_id
        WHERE re.engine_serial = $1 OR re.transponder_serial = $1
        ORDER BY re.engine_assigned_at ASC
      `, [s]);

      // Comprehensive per-draw history (multi-draw support)
      const drawsRes = await pool.query(`
        SELECT eed.draw_id, eed.entry_id, eed.engine_serial, eed.draw_number, eed.day_label,
               eed.assigned_at, eed.returned, eed.returned_at, eed.engine_issue, eed.replaced_by,
               d.first_name, d.last_name, d.race_number,
               re.race_class, re.event_id,
               e.event_name, e.event_date
        FROM entry_engine_draws eed
        JOIN race_entries re ON eed.entry_id = re.entry_id
        JOIN drivers d ON re.driver_id = d.driver_id
        LEFT JOIN events e ON re.event_id = e.event_id
        WHERE UPPER(eed.engine_serial) = $1
        ORDER BY eed.assigned_at ASC
      `, [s]).catch(() => ({ rows: [] }));

      // Pool engine parts record (seal, carb, airbox, exhaust)
      const poolRes = await pool.query(`
        SELECT draw_number, seal_number, carb_number, airbox_number, exhaust_number, class, notes, active, deleted_at
        FROM pool_engines WHERE LOWER(engine_serial) = LOWER($1) LIMIT 1
      `, [s]);

      // DIR inspection / part-change contacts
      const dirRes = await pool.query(`
        SELECT contact_id, contact_date, contact_type, outcome, fault_category,
               description, dir_notes, person_name, follow_up
        FROM dir_engine_contacts
        WHERE LOWER(engine_serial) = LOWER($1)
        ORDER BY contact_date ASC
      `, [s]);

      res.json({
        success: true, serial: s,
        logs: logsRes.rows,
        assignments: assignRes.rows,
        draws: drawsRes.rows,
        pool: poolRes.rows[0] || null,
        dir: dirRes.rows
      });
    } catch (err) {
      console.error('equipmentHistory error:', err);
      res.json({ success: false, error: err.message });
    }
  });

  // Get engine history
  router.get('/api/engineHistory', async (req, res) => {
    try {
      const { engineSerial } = req.query;

      if (!engineSerial) {
        return res.json({ success: false, error: 'Engine serial required' });
      }

      const result = await pool.query(`
        SELECT re.entry_id, re.engine_serial, re.engine_assigned_at, re.engine_returned,
               re.engine_returned_at, re.engine_issue, re.replacement_for, re.race_class,
               d.first_name, d.last_name,
               CONCAT(d.first_name, ' ', d.last_name) as driver_name
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.engine_serial = $1
        ORDER BY re.engine_assigned_at DESC
      `, [engineSerial.toUpperCase()]);

      res.json({ success: true, history: result.rows, count: result.rows.length });
    } catch (err) {
      console.error('Error getting engine history:', err);
      res.json({ success: false, error: 'Failed to get engine history' });
    }
  });

  // Public events list for draw station dropdown (no admin auth required)
  router.get('/api/getDrawEvents', async (req, res) => {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 14); // last 14 days + future
      const result = await pool.query(`
        SELECT event_id, event_name, event_date, location
        FROM events
        WHERE event_date >= $1
        ORDER BY event_date ASC
      `, [cutoff.toISOString().slice(0, 10)]);
      res.json({ success: true, events: result.rows });
    } catch (err) {
      console.error('getDrawEvents error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Lookup driver by race number — returns all confirmed entries with equipment
  router.get('/api/lookupDriverByNumber', async (req, res) => {
    try {
      const { raceNumber, event_id } = req.query;
      if (!raceNumber) return res.json({ success: false, error: 'Race number required' });

      const params = [raceNumber];
      if (event_id) params.push(event_id);

      const result = await pool.query(`
        SELECT re.entry_id, re.driver_id, re.race_class,
               re.engine_serial, re.engine_returned, re.transponder_serial,
               re.tyre_front_left, re.tyre_front_right, re.tyre_rear_left, re.tyre_rear_right,
               re.tyre_sets,
               re.ticket_engine_ref, re.ticket_tyres_ref, re.ticket_transponder_ref, re.ticket_fuel_ref,
               re.entry_items, re.event_id,
               d.first_name, d.last_name, d.race_number,
               e.event_name, e.event_date
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        LEFT JOIN events e ON re.event_id = e.event_id
        WHERE d.race_number = $1
          ${event_id ? 'AND re.event_id = $2' : ''}
          AND LOWER(re.payment_status) IN ('completed','confirmed','paid','pending')
          AND re.entry_status NOT IN ('cancelled','canceled')
        ORDER BY e.event_date DESC NULLS LAST, re.created_at DESC
      `, params);

      if (result.rows.length === 0) {
        return res.json({ success: false, error: 'No confirmed entry found for this race number' });
      }

      // Batch all scan-log fallbacks into the main result using correlated subqueries —
      // avoids N×3 extra round-trips for each entry row.
      const driverIds = [...new Set(result.rows.map(r => r.driver_id))];
      const fallbackRes = driverIds.length ? await pool.query(`
        SELECT
          driver_id,
          (SELECT equipment_serial FROM equipment_scan_log
           WHERE driver_id = d.driver_id AND scan_type IN ('engine_assign','LOAN_ASSIGN')
             AND action_result = 'success' AND equipment_serial IS NOT NULL
           ORDER BY scan_timestamp DESC LIMIT 1) AS scan_engine,
          (SELECT equipment_serial FROM equipment_scan_log
           WHERE driver_id = d.driver_id AND scan_type = 'transponder_assign'
             AND action_result = 'success' AND equipment_serial IS NOT NULL
           ORDER BY scan_timestamp DESC LIMIT 1) AS scan_transponder,
          (SELECT equipment_serial FROM equipment_scan_log
           WHERE driver_id = d.driver_id AND scan_type = 'tyres_register'
             AND action_result = 'success' AND equipment_serial IS NOT NULL
           ORDER BY scan_timestamp DESC LIMIT 1) AS scan_tyres
        FROM (SELECT UNNEST($1::text[]) AS driver_id) d
      `, [driverIds]) : { rows: [] };
      const fallbackMap = {};
      for (const fb of fallbackRes.rows) fallbackMap[fb.driver_id] = fb;

      // Build entries array, using pre-fetched fallbacks
      const entries = [];
      for (const row of result.rows) {
        const fb = fallbackMap[row.driver_id] || {};
        // Only treat as currently assigned if NOT returned
        let engineSerial = (row.engine_serial && row.engine_returned !== true) ? row.engine_serial : null;
        if (!engineSerial && row.engine_returned !== true) engineSerial = fb.scan_engine || null;

        let transponderSerial = row.transponder_serial || fb.scan_transponder || null;
        let fl = row.tyre_front_left  || null;
        let fr = row.tyre_front_right || null;
        let rl = row.tyre_rear_left   || null;
        let rr = row.tyre_rear_right  || null;

        if ((!fl || !fr || !rl || !rr) && fb.scan_tyres) {
          const raw = fb.scan_tyres;
          const flM = raw.match(/FL:(\S+)/i); const frM = raw.match(/FR:(\S+)/i);
          const rlM = raw.match(/RL:(\S+)/i); const rrM = raw.match(/RR:(\S+)/i);
          if (flM) fl = flM[1]; if (frM) fr = frM[1];
          if (rlM) rl = rlM[1]; if (rrM) rr = rrM[1];
        }

        // Build all_tyre_serials from tyre_sets array (all registered sets)
        const tyreSets = Array.isArray(row.tyre_sets) ? row.tyre_sets : [];
        // Backfill: if tyre_sets empty but individual columns have data, treat as set #1
        if (tyreSets.length === 0 && fl && fr && rl && rr) {
          tyreSets.push({ fl, fr, rl, rr });
        }
        const allTyreSerials = [];
        tyreSets.forEach(s => {
          ['fl','fr','rl','rr'].forEach(k => { if (s[k]) allTyreSerials.push(s[k].toUpperCase()); });
        });
        const tyresOk = allTyreSerials.length >= 4;
        entries.push({
          driver_id:        row.driver_id,
          entry_id:         row.entry_id,
          first_name:       row.first_name,
          last_name:        row.last_name,
          race_number:      row.race_number,
          race_class:       row.race_class,
          event_name:       row.event_name  || null,
          event_date:       row.event_date  || null,
          event_id:         row.event_id    || null,
          engine_serial:    engineSerial,
          transponder_serial: transponderSerial,
          registered_tyres: tyresOk,
          tyre_sets:        tyreSets,
          all_tyre_serials: allTyreSerials,
          tyres: tyresOk ? { front_left: fl, front_right: fr, rear_left: rl, rear_right: rr } : null,
          ticket_engine_ref:      row.ticket_engine_ref      || null,
          ticket_tyres_ref:       row.ticket_tyres_ref       || null,
          ticket_transponder_ref: row.ticket_transponder_ref || null,
          ticket_fuel_ref:        row.ticket_fuel_ref        || null,
          entry_items:     row.entry_items || []
        });
      }

      const first = entries[0];
      res.json({
        success: true,
        entries,
        driver: {
          driver_id:    first.driver_id,
          entry_id:     first.entry_id,
          first_name:   first.first_name,
          last_name:    first.last_name,
          race_number:  first.race_number,
          race_class:   first.race_class,
          engine_serial: first.engine_serial
        },
        registered_tyres: first.registered_tyres,
        tyres:            first.tyres
      });
    } catch (err) {
      console.error('Error looking up driver:', err);
      res.json({ success: false, error: err.message });
    }
  });

  // Log a driver check / engine verify from check.html → broadcasts to monitor
  router.post('/api/logDriverCheck', async (req, res) => {
    try {
      const { driver_id, entry_id, driver_name, race_class, engine_serial, registered_tyres,
              scanned_by: reqScannedBy,
              scan_type: customType, action_result: customResult, notes: customNotes } = req.body;
      const scanType = customType || 'driver_check';
      const actionResult = customResult || 'success';
      let notes = customNotes;
      if (!notes) {
        const notesParts = [];
        if (engine_serial) notesParts.push(`Engine: ${engine_serial}`);
        else notesParts.push('No engine assigned');
        notesParts.push(`Tyres: ${registered_tyres ? 'Registered ✓' : 'Not registered'}`);
        notes = notesParts.join(' · ');
      }
      await logEquipmentScan({
        scan_type:        scanType,
        entry_id,
        driver_id,
        driver_name,
        race_class,
        equipment_serial: engine_serial || null,
        scanned_by:       reqScannedBy || 'Check Station',
        action_result:    actionResult,
        notes
      });
      res.json({ success: true });
    } catch (err) {
      console.error('Error logging driver check:', err);
      res.json({ success: false, error: err.message });
    }
  });

  // Equipment tracking — search by driver name or race number
  router.get('/api/equipmentTracking', async (req, res) => {
    try {
      const { search } = req.query;

      if (!search) {
        return res.json({ success: false, error: 'Search term required' });
      }

      const searchTerm = `%${search}%`;

      const result = await pool.query(`
        SELECT re.entry_id, re.driver_id, re.race_class, re.created_at,
               re.engine_serial, re.engine_assigned_at, re.engine_returned,
               re.engine_returned_at, re.engine_issue,
               re.tyre_front_left, re.tyre_front_right, re.tyre_rear_left, re.tyre_rear_right,
               re.tyres_registered_at,
               re.transponder_serial, re.transponder_assigned_at,
               re.fuel_collected, re.fuel_collected_at,
               d.first_name, d.last_name, d.race_number,
               CONCAT(d.first_name, ' ', d.last_name) as driver_name,
               e.event_name
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        LEFT JOIN events e ON re.event_id = e.event_id
        WHERE CONCAT(d.first_name, ' ', d.last_name) ILIKE $1
           OR d.race_number::text = $2
        ORDER BY re.created_at DESC
      `, [searchTerm, search]);

      res.json({ success: true, entries: result.rows, count: result.rows.length });
    } catch (err) {
      console.error('Error getting equipment tracking:', err);
      res.json({ success: false, error: 'Failed to get equipment tracking' });
    }
  });

  // Get equipment grouped by driver for an event
  router.get('/api/equipmentByDriver', async (req, res) => {
    try {
      const { event_id } = req.query;

      if (!event_id) {
        return res.json({ success: false, error: 'Event ID required' });
      }

      const result = await pool.query(`
        SELECT re.entry_id, re.driver_id, re.race_class,
               re.ticket_engine_ref, re.ticket_tyres_ref, re.ticket_transponder_ref, re.ticket_fuel_ref,
               re.engine_serial, re.engine_assigned_at, re.engine_returned,
               re.tyre_front_left, re.tyre_front_right, re.tyre_rear_left, re.tyre_rear_right,
               re.tyres_registered_at,
               re.transponder_serial, re.transponder_assigned_at,
               re.fuel_collected, re.fuel_collected_at,
               CONCAT(d.first_name, ' ', d.last_name) as driver_name,
               d.race_number
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.event_id = $1 AND re.entry_status != 'cancelled'
        ORDER BY d.last_name, d.first_name
      `, [event_id]);

      res.json({ success: true, entries: result.rows });
    } catch (err) {
      console.error('Error getting equipment by driver:', err);
      res.json({ success: false, error: 'Failed to get equipment by driver' });
    }
  });

  // Get equipment grouped by item type for an event
  router.get('/api/equipmentByItem', async (req, res) => {
    try {
      const { event_id } = req.query;

      if (!event_id) {
        return res.json({ success: false, error: 'Event ID required' });
      }

      const enginesResult = await pool.query(`
        SELECT re.engine_serial, re.engine_assigned_at, re.race_class,
               CONCAT(d.first_name, ' ', d.last_name) as driver_name,
               d.race_number
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.event_id = $1
          AND re.engine_serial IS NOT NULL
          AND re.engine_returned IS NOT TRUE
        ORDER BY re.engine_assigned_at DESC
      `, [event_id]);

      const transpondersResult = await pool.query(`
        SELECT re.transponder_serial, re.transponder_assigned_at, re.race_class,
               CONCAT(d.first_name, ' ', d.last_name) as driver_name,
               d.race_number
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.event_id = $1
          AND re.transponder_serial IS NOT NULL
        ORDER BY re.transponder_assigned_at DESC
      `, [event_id]);

      res.json({
        success: true,
        equipment: {
          engines: enginesResult.rows,
          transponders: transpondersResult.rows
        }
      });
    } catch (err) {
      console.error('Error getting equipment by item:', err);
      res.json({ success: false, error: 'Failed to get equipment by item' });
    }
  });

  // =============================================
  // ENGINE LOANS (manual/practice assignments)
  // =============================================

  // Create a new manual engine loan
  router.post('/api/loanEngine', async (req, res) => {
    try {
      const { engineSerial, driverName, driverId, purpose, loanDate, notes, assignedBy } = req.body;

      if (!engineSerial || !driverName) {
        return res.json({ success: false, error: 'Engine serial and driver name are required' });
      }

      // Block if already on an active loan
      const activeCheck = await pool.query(`
        SELECT loan_id FROM engine_loans
        WHERE engine_serial = $1 AND returned_at IS NULL
      `, [engineSerial.toUpperCase()]);

      if (activeCheck.rows.length > 0) {
        return res.json({ success: false, error: `Engine ${engineSerial} is already out on loan — return it first` });
      }

      // Also block if assigned to an active race entry
      const raceCheck = await pool.query(`
        SELECT re.entry_id, d.first_name, d.last_name
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.engine_serial = $1 AND re.engine_returned = false
      `, [engineSerial.toUpperCase()]);

      if (raceCheck.rows.length > 0) {
        const d = raceCheck.rows[0];
        return res.json({ success: false, error: `Engine ${engineSerial} is assigned to event entry for ${d.first_name} ${d.last_name}` });
      }

      const result = await pool.query(`
        INSERT INTO engine_loans
          (engine_serial, driver_name, driver_id, purpose, loan_date, notes, assigned_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING loan_id
      `, [
        engineSerial.toUpperCase(),
        driverName.trim(),
        driverId || null,
        purpose || 'Practice',
        loanDate ? new Date(loanDate) : new Date(),
        notes || null,
        assignedBy || null
      ]);

      await logEquipmentScan({
        scan_type: 'LOAN_ASSIGN',
        barcode_scanned: engineSerial.toUpperCase(),
        driver_id: driverId || null,
        driver_name: driverName.trim(),
        equipment_serial: engineSerial.toUpperCase(),
        scanned_by: assignedBy || 'System',
        action_result: 'success',
        notes: `Loaned for ${purpose || 'Practice'}${notes ? ': ' + notes : ''}`
      });

      console.log(`\u2705 Engine ${engineSerial} loaned to ${driverName} (Loan #${result.rows[0].loan_id})`);
      res.json({ success: true, loan_id: result.rows[0].loan_id });
    } catch (err) {
      console.error('Error creating engine loan:', err);
      res.json({ success: false, error: 'Failed to create loan' });
    }
  });

  // Return a loaned engine (sign-off)
  router.post('/api/returnLoanEngine', async (req, res) => {
    try {
      const { loanId, returnedTo, returnNotes } = req.body;

      if (!loanId) {
        return res.json({ success: false, error: 'Loan ID required' });
      }

      const loan = await pool.query(`
        SELECT * FROM engine_loans WHERE loan_id = $1 AND returned_at IS NULL
      `, [loanId]);

      if (loan.rows.length === 0) {
        return res.json({ success: false, error: 'Loan not found or already returned' });
      }

      const row = loan.rows[0];

      await pool.query(`
        UPDATE engine_loans
        SET returned_at = NOW(), returned_to = $1, return_notes = $2
        WHERE loan_id = $3
      `, [returnedTo || null, returnNotes || null, loanId]);

      await logEquipmentScan({
        scan_type: 'LOAN_RETURN',
        barcode_scanned: row.engine_serial,
        driver_id: row.driver_id || null,
        driver_name: row.driver_name,
        equipment_serial: row.engine_serial,
        scanned_by: returnedTo || 'System',
        action_result: 'success',
        notes: `Engine returned${returnNotes ? ': ' + returnNotes : ''}`
      });

      console.log(`\u2705 Engine ${row.engine_serial} returned from ${row.driver_name} (signed off by ${returnedTo || 'unknown'})`);
      res.json({ success: true, engine_serial: row.engine_serial, driver_name: row.driver_name });
    } catch (err) {
      console.error('Error returning loan engine:', err);
      res.json({ success: false, error: 'Failed to return engine' });
    }
  });

  // List all active engine loans (not yet returned)
  router.get('/api/activeLoans', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT loan_id, engine_serial, driver_name, driver_id,
               purpose, loan_date, notes, assigned_by
        FROM engine_loans
        WHERE returned_at IS NULL
        ORDER BY loan_date DESC
      `);
      res.json({ success: true, loans: result.rows });
    } catch (err) {
      console.error('Error fetching active loans:', err);
      res.json({ success: false, error: 'Failed to fetch active loans' });
    }
  });

  // Get full loan history for an engine serial
  router.get('/api/loanHistory', async (req, res) => {
    try {
      const { engineSerial } = req.query;
      if (!engineSerial) return res.json({ success: false, error: 'Engine serial required' });

      const result = await pool.query(`
        SELECT loan_id, engine_serial, driver_name, purpose,
               loan_date, notes, assigned_by,
               returned_at, returned_to, return_notes
        FROM engine_loans
        WHERE engine_serial = $1
        ORDER BY loan_date DESC
      `, [engineSerial.toUpperCase()]);

      res.json({ success: true, history: result.rows });
    } catch (err) {
      console.error('Error fetching loan history:', err);
      res.json({ success: false, error: 'Failed to fetch loan history' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // COMPREHENSIVE ENGINE TIMELINE — every event across all sources
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/api/engineFullHistory', async (req, res) => {
    try {
      const { engineSerial } = req.query;
      if (!engineSerial) return res.json({ success: false, error: 'Engine serial required' });
      const serial = engineSerial.toUpperCase();

      const result = await pool.query(`
        -- Manual loans — issued out
        SELECT
          'loan_out'              AS event_type,
          loan_date               AS event_time,
          driver_name,
          'Manual Loan'           AS context,
          COALESCE(purpose, 'Practice') AS detail,
          COALESCE(notes, '')     AS notes,
          COALESCE(assigned_by, '') AS actor,
          loan_id::text           AS ref_id,
          'out'                   AS status
        FROM engine_loans
        WHERE engine_serial = $1

        UNION ALL

        -- Manual loans — returned
        SELECT
          'loan_return'           AS event_type,
          returned_at             AS event_time,
          driver_name,
          'Manual Loan Return'    AS context,
          'Engine signed back in' AS detail,
          COALESCE(return_notes, '') AS notes,
          COALESCE(returned_to, '') AS actor,
          loan_id::text           AS ref_id,
          'returned'              AS status
        FROM engine_loans
        WHERE engine_serial = $1
          AND returned_at IS NOT NULL

        UNION ALL

        -- Equipment scan log (exclude loan events to avoid duplicates)
        SELECT
          LOWER(scan_type)        AS event_type,
          scan_timestamp          AS event_time,
          COALESCE(driver_name, '') AS driver_name,
          COALESCE(race_class, 'Equipment Scan') AS context,
          scan_type               AS detail,
          COALESCE(notes, '')     AS notes,
          COALESCE(scanned_by, '') AS actor,
          log_id::text            AS ref_id,
          COALESCE(action_result, 'success') AS status
        FROM equipment_scan_log
        WHERE equipment_serial = $1
          AND scan_type NOT IN ('LOAN_ASSIGN', 'LOAN_RETURN')

        UNION ALL

        -- Race entry — engine assigned for event
        SELECT
          'event_assign'          AS event_type,
          re.engine_assigned_at   AS event_time,
          CONCAT(d.first_name, ' ', d.last_name) AS driver_name,
          COALESCE(e.event_name, 'Race Event') AS context,
          COALESCE(re.race_class, '') AS detail,
          ''                      AS notes,
          ''                      AS actor,
          re.entry_id             AS ref_id,
          'assigned'              AS status
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        LEFT JOIN events e ON re.event_id = e.event_id
        WHERE re.engine_serial = $1
          AND re.engine_assigned_at IS NOT NULL

        UNION ALL

        -- Race entry — engine returned from event
        SELECT
          'event_return'          AS event_type,
          re.engine_returned_at   AS event_time,
          CONCAT(d.first_name, ' ', d.last_name) AS driver_name,
          COALESCE(e.event_name, 'Race Event') AS context,
          COALESCE(re.race_class, '') AS detail,
          ''                      AS notes,
          ''                      AS actor,
          re.entry_id             AS ref_id,
          'returned'              AS status
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        LEFT JOIN events e ON re.event_id = e.event_id
        WHERE re.engine_serial = $1
          AND re.engine_returned = true
          AND re.engine_returned_at IS NOT NULL

        UNION ALL

        -- Race entry — issue reported
        SELECT
          'issue_reported'        AS event_type,
          re.updated_at           AS event_time,
          CONCAT(d.first_name, ' ', d.last_name) AS driver_name,
          COALESCE(e.event_name, 'Race Event') AS context,
          COALESCE(re.engine_issue, 'Issue reported') AS detail,
          ''                      AS notes,
          ''                      AS actor,
          re.entry_id             AS ref_id,
          'issue'                 AS status
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        LEFT JOIN events e ON re.event_id = e.event_id
        WHERE re.engine_serial = $1
          AND re.engine_issue IS NOT NULL
          AND re.engine_issue != ''

        ORDER BY event_time DESC NULLS LAST
      `, [serial]);

      res.json({ success: true, serial, history: result.rows, count: result.rows.length });
    } catch (err) {
      console.error('Error fetching full engine history:', err);
      res.json({ success: false, error: 'Failed to fetch engine history' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Titan admin: full update of any payment record
  // payment_type: 'race_entry' | 'direct' | 'pool_rental'
  // ─────────────────────────────────────────────────────────────
  router.post('/api/titan/updatePaymentAdmin', async (req, res) => {
    const {
      payment_type, id,
      payment_status, amount_paid, payment_reference,
      entry_status, race_class, race_number,
      notes, performed_by
    } = req.body;

    if (!payment_type || !id) {
      return res.status(400).json({ success: false, error: 'payment_type and id are required' });
    }

    try {
      if (payment_type === 'race_entry') {
        const cols = []; const vals = []; let p = 1;
        if (payment_status  !== undefined) { cols.push(`payment_status=$${p++}`);    vals.push(payment_status); }
        if (amount_paid     !== undefined) { cols.push(`amount_paid=$${p++}`);       vals.push(parseFloat(amount_paid) || 0); }
        if (payment_reference !== undefined) { cols.push(`payment_reference=$${p++}`); vals.push(payment_reference); }
        if (entry_status    !== undefined) { cols.push(`entry_status=$${p++}`);      vals.push(entry_status); }
        if (race_class      !== undefined) { cols.push(`race_class=$${p++}`);        vals.push(race_class); }
        if (race_number     !== undefined) { cols.push(`race_number=$${p++}`);       vals.push(race_number); }
        if (!cols.length) throw new Error('No fields to update');
        cols.push(`updated_at=NOW()`);
        vals.push(id);
        const result = await pool.query(
          `UPDATE race_entries SET ${cols.join(',')} WHERE entry_id=$${p} RETURNING entry_id`,
          vals
        );
        if (!result.rows.length) throw new Error('Race entry not found');

        // Audit log
        try {
          await pool.query(
            `INSERT INTO audit_log (action, performed_by, details, event_time)
             VALUES ($1,$2,$3,NOW())`,
            ['TITAN_PAYMENT_EDIT', performed_by || 'TITAN',
             `entry_id=${id} status=${payment_status||'-'} amount=${amount_paid||'-'} ref=${payment_reference||'-'} ${notes||''}`]
          );
        } catch (_) {}

      } else if (payment_type === 'direct') {
        const cols = []; const vals = []; let p = 1;
        if (payment_status  !== undefined) { cols.push(`payment_status=$${p++}`);    vals.push(payment_status); }
        if (amount_paid     !== undefined) { cols.push(`amount_gross=$${p++}`);      vals.push(parseFloat(amount_paid) || 0); }
        if (payment_reference !== undefined) { cols.push(`merchant_payment_id=$${p++}`); vals.push(payment_reference); }
        if (!cols.length) throw new Error('No fields to update');
        vals.push(id);
        await pool.query(
          `UPDATE payments SET ${cols.join(',')} WHERE payment_id=$${p}`,
          vals
        );

      } else if (payment_type === 'pool_rental') {
        const cols = []; const vals = []; let p = 1;
        if (payment_status  !== undefined) { cols.push(`payment_status=$${p++}`);    vals.push(payment_status); }
        if (amount_paid     !== undefined) { cols.push(`amount_paid=$${p++}`);       vals.push(parseFloat(amount_paid) || 0); }
        if (payment_reference !== undefined) { cols.push(`payment_reference=$${p++}`); vals.push(payment_reference); }
        if (!cols.length) throw new Error('No fields to update');
        vals.push(id);
        await pool.query(
          `UPDATE pool_engine_rentals SET ${cols.join(',')} WHERE rental_id=$${p}`,
          vals
        );

      } else {
        throw new Error(`Unknown payment_type: ${payment_type}`);
      }

      res.json({ success: true, message: 'Payment updated' });
    } catch (err) {
      console.error('updatePaymentAdmin error:', err.message);
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // MSA Licenses — all drivers in an event with license status
  // ─────────────────────────────────────────────────────────────
  router.get('/api/titan/msaStatus', async (req, res) => {
    const { event_id } = req.query;
    if (!event_id) return res.status(400).json({ success: false, error: 'event_id required' });
    try {
      const result = await pool.query(`
        SELECT
          d.driver_id,
          d.first_name,
          d.last_name,
          re.race_class,
          re.race_number,
          re.entry_status,
          re.payment_status,
          CASE WHEN ml.document_id IS NOT NULL THEN true ELSE false END AS has_license,
          ml.document_id,
          ml.file_name,
          ml.file_size,
          ml.upload_date
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        LEFT JOIN msa_licenses ml ON d.driver_id = ml.driver_id
        WHERE re.event_id = $1
          AND re.entry_status NOT IN ('cancelled')
        ORDER BY re.race_class, d.last_name, d.first_name
      `, [event_id]);
      res.json({ success: true, drivers: result.rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Race Results — get results for event / class / session
  // ─────────────────────────────────────────────────────────────
  router.get('/api/titan/raceResults', async (req, res) => {
    const { event_id, race_class, session_type } = req.query;
    if (!event_id) return res.status(400).json({ success: false, error: 'event_id required' });
    try {
      // Ensure tables exist
      await pool.query(`
        CREATE TABLE IF NOT EXISTS race_results (
          result_id     SERIAL PRIMARY KEY,
          event_id      TEXT,
          driver_id     TEXT,
          race_class    TEXT,
          session_type  TEXT,
          position      INT,
          best_lap_time TEXT,
          fastest_lap   BOOLEAN DEFAULT false,
          total_laps    INT,
          dnf           BOOLEAN DEFAULT false,
          dns           BOOLEAN DEFAULT false,
          dsq           BOOLEAN DEFAULT false,
          notes         TEXT,
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(event_id, driver_id, session_type)
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS points (
          points_id         SERIAL PRIMARY KEY,
          driver_id         TEXT,
          season            TEXT,
          event             TEXT,
          round             INT,
          class             TEXT,
          qualifying_points NUMERIC DEFAULT 0,
          heat1_points      NUMERIC DEFAULT 0,
          heat2_points      NUMERIC DEFAULT 0,
          final_points      NUMERIC DEFAULT 0,
          penalties_points  NUMERIC DEFAULT 0,
          total_points      NUMERIC DEFAULT 0,
          position          INT,
          championship_type TEXT DEFAULT 'Northern Regions',
          notes             TEXT,
          created_at        TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(driver_id, season, event, class, championship_type)
        )
      `);

      // Get entries for class in event (all confirmed/pending)
      let entryQ = `
        SELECT re.driver_id, re.race_class, re.race_number,
               d.first_name, d.last_name
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.event_id = $1
          AND re.entry_status NOT IN ('cancelled')
      `;
      const entryParams = [event_id];
      if (race_class) { entryQ += ` AND re.race_class = $2`; entryParams.push(race_class); }
      entryQ += ` ORDER BY re.race_class, d.last_name`;
      const entries = await pool.query(entryQ, entryParams);

      // Get existing results for this event/session
      let resQ = `SELECT * FROM race_results WHERE event_id = $1`;
      const resParams = [event_id];
      if (session_type) { resQ += ` AND session_type = $2`; resParams.push(session_type); }
      if (race_class)   { resQ += ` AND race_class = $${resParams.length+1}`; resParams.push(race_class); }
      const results = await pool.query(resQ, resParams);

      // Get existing points
      const pointsQ = `SELECT * FROM points WHERE event = $1`;
      const pts = await pool.query(pointsQ, [event_id]);

      res.json({
        success: true,
        entries: entries.rows,
        results: results.rows,
        points: pts.rows
      });
    } catch (err) {
      console.error('raceResults error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Save Race Results + Points (upsert per driver/session)
  // ─────────────────────────────────────────────────────────────
  router.post('/api/titan/saveRaceResults', async (req, res) => {
    const { event_id, race_class, session_type, results, season, championship_type } = req.body;
    if (!event_id || !session_type || !Array.isArray(results)) {
      return res.status(400).json({ success: false, error: 'event_id, session_type and results[] required' });
    }
    try {
      for (const r of results) {
        // Upsert race_results
        await pool.query(`
          INSERT INTO race_results
            (event_id, driver_id, race_class, session_type, position,
             best_lap_time, fastest_lap, dnf, dns, dsq, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (event_id, driver_id, session_type)
          DO UPDATE SET
            position      = EXCLUDED.position,
            best_lap_time = EXCLUDED.best_lap_time,
            fastest_lap   = EXCLUDED.fastest_lap,
            dnf           = EXCLUDED.dnf,
            dns           = EXCLUDED.dns,
            dsq           = EXCLUDED.dsq,
            notes         = EXCLUDED.notes,
            race_class    = EXCLUDED.race_class
        `, [
          event_id, r.driver_id, race_class || r.race_class, session_type,
          r.position || null, r.best_lap_time || null,
          !!r.fastest_lap, !!r.dnf, !!r.dns, !!r.dsq, r.notes || null
        ]);

        // Upsert points if any provided
        if (r.points !== undefined && r.points !== null && r.points !== '') {
          const pts = parseFloat(r.points) || 0;
          const qp  = session_type === 'qualifying' ? pts : 0;
          const h1p = session_type === 'heat1'      ? pts : 0;
          const h2p = session_type === 'heat2'      ? pts : 0;
          const fp  = session_type === 'final'      ? pts : 0;

          await pool.query(`
            INSERT INTO points
              (driver_id, season, event, class, championship_type,
               qualifying_points, heat1_points, heat2_points, final_points,
               total_points, position)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT (driver_id, season, event, class, championship_type)
            DO UPDATE SET
              qualifying_points = CASE WHEN $6 > 0 THEN $6 ELSE points.qualifying_points END,
              heat1_points      = CASE WHEN $7 > 0 THEN $7 ELSE points.heat1_points END,
              heat2_points      = CASE WHEN $8 > 0 THEN $8 ELSE points.heat2_points END,
              final_points      = CASE WHEN $9 > 0 THEN $9 ELSE points.final_points END,
              total_points      = points.qualifying_points + points.heat1_points +
                                  points.heat2_points + points.final_points
                                  - COALESCE(points.penalties_points,0),
              position          = EXCLUDED.position
          `, [
            r.driver_id,
            season || new Date().getFullYear().toString(),
            event_id,
            race_class || r.race_class,
            championship_type || 'Northern Regions',
            qp, h1p, h2p, fp,
            pts,
            r.position || null
          ]);
        }
      }
      res.json({ success: true, saved: results.length });
    } catch (err) {
      console.error('saveRaceResults error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
