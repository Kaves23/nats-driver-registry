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

      // Find entry with this ticket
      const result = await pool.query(`
        SELECT re.entry_id, re.driver_id, re.race_class, re.engine_serial,
               d.first_name, d.last_name, d.race_number, d.transponder_number
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.${ticketColumn} = $1
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

      res.json({
        success: true,
        driver: {
          driver_id: entry.driver_id,
          entry_id: entry.entry_id,
          first_name: entry.first_name,
          last_name: entry.last_name,
          race_class: entry.race_class,
          race_number: entry.race_number,
          transponder_number: entry.transponder_number
        },
        ticket: {
          barcode: barcodeUpper,
          type: ticketType,
          engine_serial: entry.engine_serial
        }
      });
    } catch (err) {
      console.error('Error looking up ticket:', err);
      res.json({ success: false, error: 'Failed to look up ticket' });
    }
  });

  // Assign engine to driver
  router.post('/api/assignEngine', async (req, res) => {
    try {
      const { ticketBarcode, engineSerial, driverId, entryId } = req.body;

      if (!ticketBarcode || !engineSerial || !driverId || !entryId) {
        return res.json({ success: false, error: 'Missing required fields' });
      }

      const existingAssignment = await pool.query(`
        SELECT re.entry_id, d.first_name, d.last_name
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.engine_serial = $1 AND re.engine_returned = false
      `, [engineSerial.toUpperCase()]);

      if (existingAssignment.rows.length > 0) {
        const existing = existingAssignment.rows[0];
        return res.json({
          success: false,
          error: `Engine ${engineSerial} is already assigned to ${existing.first_name} ${existing.last_name}`
        });
      }

      const assignResult = await pool.query(`
        UPDATE race_entries 
        SET engine_serial = $1, 
            engine_assigned_at = NOW(),
            engine_returned = false,
            updated_at = NOW()
        WHERE entry_id = $2
        RETURNING driver_id, race_class, event_id
      `, [engineSerial.toUpperCase(), entryId]);

      const driverInfo = await pool.query(`
        SELECT first_name, last_name FROM drivers WHERE driver_id = $1
      `, [driverId]);

      const driverName = driverInfo.rows[0]
        ? `${driverInfo.rows[0].first_name} ${driverInfo.rows[0].last_name}`
        : 'Unknown';

      await logEquipmentScan({
        scan_type: 'engine_assign',
        barcode_scanned: ticketBarcode,
        entry_id: entryId,
        driver_id: driverId,
        driver_name: driverName,
        equipment_serial: engineSerial.toUpperCase(),
        scanned_by: 'System',
        action_result: 'success',
        notes: `Engine ${engineSerial} assigned`,
        event_id: assignResult.rows[0]?.event_id,
        race_class: assignResult.rows[0]?.race_class
      });

      console.log(`✅ Engine ${engineSerial} assigned to driver ${driverId} (Entry: ${entryId})`);
      res.json({ success: true });
    } catch (err) {
      console.error('Error assigning engine:', err);
      res.json({ success: false, error: 'Failed to assign engine' });
    }
  });

  // Return engine
  router.post('/api/returnEngine', async (req, res) => {
    try {
      const { engineSerial } = req.body;

      if (!engineSerial) {
        return res.json({ success: false, error: 'Engine serial required' });
      }

      const result = await pool.query(`
        SELECT re.entry_id, d.first_name, d.last_name
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.engine_serial = $1 AND re.engine_returned = false
      `, [engineSerial.toUpperCase()]);

      if (result.rows.length === 0) {
        return res.json({ success: false, error: 'No active assignment found for this engine' });
      }

      const returnResult = await pool.query(`
        UPDATE race_entries 
        SET engine_returned = true,
            engine_returned_at = NOW(),
            updated_at = NOW()
        WHERE engine_serial = $1 AND engine_returned = false
        RETURNING entry_id, driver_id, event_id, race_class
      `, [engineSerial.toUpperCase()]);

      const driverName = `${result.rows[0].first_name} ${result.rows[0].last_name}`;

      await logEquipmentScan({
        scan_type: 'engine_return',
        barcode_scanned: engineSerial.toUpperCase(),
        entry_id: returnResult.rows[0]?.entry_id,
        driver_id: returnResult.rows[0]?.driver_id,
        driver_name: driverName,
        equipment_serial: engineSerial.toUpperCase(),
        scanned_by: 'System',
        action_result: 'success',
        notes: `Engine ${engineSerial} returned`,
        event_id: returnResult.rows[0]?.event_id,
        race_class: returnResult.rows[0]?.race_class
      });

      console.log(`✅ Engine ${engineSerial} returned from ${driverName}`);
      res.json({ success: true });
    } catch (err) {
      console.error('Error returning engine:', err);
      res.json({ success: false, error: 'Failed to return engine' });
    }
  });

  // Report engine issue
  router.post('/api/reportEngineIssue', async (req, res) => {
    try {
      const { engineSerial, issueDescription } = req.body;

      if (!engineSerial || !issueDescription) {
        return res.json({ success: false, error: 'Engine serial and issue description required' });
      }

      const result = await pool.query(`
        SELECT re.entry_id, re.driver_id, d.first_name, d.last_name
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.engine_serial = $1 AND re.engine_returned = false
      `, [engineSerial.toUpperCase()]);

      if (result.rows.length === 0) {
        return res.json({ success: false, error: 'No active assignment found for this engine' });
      }

      const entry = result.rows[0];

      await pool.query(`
        UPDATE race_entries 
        SET engine_returned = true,
            engine_returned_at = NOW(),
            engine_issue = $2,
            updated_at = NOW()
        WHERE engine_serial = $1 AND engine_returned = false
      `, [engineSerial.toUpperCase(), issueDescription]);

      console.log(`⚠️ Engine ${engineSerial} reported with issue: ${issueDescription}`);
      res.json({ success: true, driverId: entry.driver_id, entryId: entry.entry_id });
    } catch (err) {
      console.error('Error reporting engine issue:', err);
      res.json({ success: false, error: 'Failed to report engine issue' });
    }
  });

  // Assign replacement engine
  router.post('/api/assignReplacementEngine', async (req, res) => {
    try {
      const { replacementSerial, returnedSerial, driverId, entryId } = req.body;

      if (!replacementSerial || !returnedSerial || !driverId || !entryId) {
        return res.json({ success: false, error: 'Missing required fields' });
      }

      const existingAssignment = await pool.query(`
        SELECT re.entry_id, d.first_name, d.last_name
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE re.engine_serial = $1 AND re.engine_returned = false
      `, [replacementSerial.toUpperCase()]);

      if (existingAssignment.rows.length > 0) {
        const existing = existingAssignment.rows[0];
        return res.json({
          success: false,
          error: `Engine ${replacementSerial} is already assigned to ${existing.first_name} ${existing.last_name}`
        });
      }

      await pool.query(`
        UPDATE race_entries 
        SET engine_serial = $1, 
            engine_assigned_at = NOW(),
            engine_returned = false,
            replacement_for = $3,
            updated_at = NOW()
        WHERE entry_id = $2
      `, [replacementSerial.toUpperCase(), entryId, returnedSerial.toUpperCase()]);

      console.log(`✅ Replacement engine ${replacementSerial} assigned (replaced ${returnedSerial})`);
      res.json({ success: true });
    } catch (err) {
      console.error('Error assigning replacement engine:', err);
      res.json({ success: false, error: 'Failed to assign replacement engine' });
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

  // Assign tyres (4 required)
  router.post('/api/assignTyres', async (req, res) => {
    try {
      const { ticketBarcode, tyres, driverId, entryId } = req.body;

      if (!ticketBarcode || !tyres || !driverId || !entryId) {
        return res.json({ success: false, error: 'Missing required fields' });
      }

      const { front_left, front_right, rear_left, rear_right } = tyres;

      if (!front_left || !front_right || !rear_left || !rear_right) {
        return res.json({ success: false, error: 'All 4 tyre serials required' });
      }

      const tyreResult = await pool.query(`
        UPDATE race_entries 
        SET tyre_front_left = $1,
            tyre_front_right = $2,
            tyre_rear_left = $3,
            tyre_rear_right = $4,
            tyres_registered_at = NOW(),
            updated_at = NOW()
        WHERE entry_id = $5
        RETURNING driver_id, race_class, event_id
      `, [
        front_left.toUpperCase(), front_right.toUpperCase(),
        rear_left.toUpperCase(), rear_right.toUpperCase(),
        entryId
      ]);

      const driverInfo = await pool.query(`
        SELECT first_name, last_name FROM drivers WHERE driver_id = $1
      `, [driverId]);

      const driverName = driverInfo.rows[0]
        ? `${driverInfo.rows[0].first_name} ${driverInfo.rows[0].last_name}`
        : 'Unknown';

      await logEquipmentScan({
        scan_type: 'tyres_register',
        barcode_scanned: ticketBarcode,
        entry_id: entryId,
        driver_id: driverId,
        driver_name: driverName,
        equipment_serial: `FL:${front_left} FR:${front_right} RL:${rear_left} RR:${rear_right}`,
        scanned_by: 'System',
        action_result: 'success',
        notes: '4 tyres registered',
        event_id: tyreResult.rows[0]?.event_id,
        race_class: tyreResult.rows[0]?.race_class
      });

      console.log(`✅ Tyres registered for driver ${driverId}`);
      res.json({ success: true });
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

  // Lookup driver by race number for tyre verification
  router.get('/api/lookupDriverByNumber', async (req, res) => {
    try {
      const { raceNumber } = req.query;

      if (!raceNumber) {
        return res.json({ success: false, error: 'Race number required' });
      }

      const result = await pool.query(`
        SELECT re.entry_id, re.driver_id, re.race_class,
               re.tyre_front_left, re.tyre_front_right, re.tyre_rear_left, re.tyre_rear_right,
               d.first_name, d.last_name, d.race_number
        FROM race_entries re
        JOIN drivers d ON re.driver_id = d.driver_id
        WHERE d.race_number = $1
        ORDER BY re.created_at DESC
        LIMIT 1
      `, [raceNumber]);

      if (result.rows.length === 0) {
        return res.json({ success: false, error: 'No entry found for this race number' });
      }

      const entry = result.rows[0];
      const tyresRegistered = !!(entry.tyre_front_left && entry.tyre_front_right &&
                                 entry.tyre_rear_left && entry.tyre_rear_right);

      res.json({
        success: true,
        driver: {
          driver_id: entry.driver_id,
          entry_id: entry.entry_id,
          first_name: entry.first_name,
          last_name: entry.last_name,
          race_number: entry.race_number,
          race_class: entry.race_class
        },
        registered_tyres: tyresRegistered,
        tyres: tyresRegistered ? {
          front_left: entry.tyre_front_left,
          front_right: entry.tyre_front_right,
          rear_left: entry.tyre_rear_left,
          rear_right: entry.tyre_rear_right
        } : null
      });
    } catch (err) {
      console.error('Error looking up driver:', err);
      res.json({ success: false, error: 'Failed to look up driver' });
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
          AND re.engine_returned = false
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

  return router;
};
