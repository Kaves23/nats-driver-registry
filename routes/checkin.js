/**
 * Event Check-In routes
 * Mounted in server.js:  app.use(require('./routes/checkin')(pool, requireAdmin));
 *
 * Device endpoints (protected by CHECKPOINT_PIN / CHECKIN_PIN env var):
 *   GET  /api/checkin/events-list           — list upcoming/active events (for boot selector)
 *   POST /api/checkin/lookup                — body: { qr_code } → returns entry info or error
 *   POST /api/checkin/confirm               — body: { entry_id, event_id, device_name } → mark checked_in_at
 *
 * Admin endpoints (requireAdmin):
 *   GET  /api/admin/checkin/report          — ?event_id= list of checked-in entries
 *   POST /api/admin/checkin/undo/:entryId   — clear checked_in_at for an entry
 */

const { Router } = require('express');

function checkinPinMiddleware(req, res, next) {
  const pin = req.headers['x-checkin-pin'] || req.query.pin || '';
  const expected = process.env.CHECKIN_PIN || process.env.CHECKPOINT_PIN || 'checkpoint2026';
  if (pin !== expected) {
    return res.status(401).json({ success: false, error: 'Invalid PIN' });
  }
  next();
}

module.exports = function checkinRoutes(pool, requireAdmin) {
  const router = Router();

  // ─────────────────────────────────────────────────────────────────
  // DEVICE endpoints
  // ─────────────────────────────────────────────────────────────────

  // List events for boot screen selector
  router.get('/api/checkin/events-list', checkinPinMiddleware, async (req, res) => {
    try {
      // Show events within the past 60 days through future (so active/recent events always appear)
      const r = await pool.query(
        `SELECT event_id, event_name, event_date, start_date, end_date, location AS event_location
           FROM events
          ORDER BY COALESCE(start_date, event_date) DESC
          LIMIT 30`
      );
      res.json({ success: true, events: r.rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Look up an entry by scanning its ticket QR code
  // QR code contains the payment_reference (uppercased) value
  router.post('/api/checkin/lookup', checkinPinMiddleware, async (req, res) => {
    try {
      const { qr_code, event_id } = req.body;
      if (!qr_code) return res.status(400).json({ success: false, error: 'No QR code provided' });

      const qrNorm = String(qr_code).trim().toUpperCase();

      // Build query — optionally scope to a specific event
      const params = [qrNorm];
      let eventFilter = '';
      if (event_id) {
        params.push(event_id);
        eventFilter = `AND re.event_id = $2`;
      }

      const r = await pool.query(
        `SELECT
            re.entry_id,
            re.event_id,
            re.payment_reference,
            re.race_class,
            re.race_number,
            re.entry_status,
            re.payment_status,
            re.checked_in_at,
            re.checked_in_by,
            d.first_name,
            d.last_name,
            d.race_number   AS driver_race_number,
            e.event_name,
            e.event_date,
            e.event_location
           FROM race_entries re
           LEFT JOIN drivers d ON re.driver_id = d.driver_id
           LEFT JOIN events  e ON re.event_id  = e.event_id
          WHERE UPPER(re.payment_reference) = $1
            ${eventFilter}
          LIMIT 1`,
        params
      );

      if (!r.rows.length) {
        return res.json({ success: false, error: 'No entry found for that QR code' });
      }

      const entry = r.rows[0];
      res.json({ success: true, entry });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Confirm check-in — mark the entry as checked in
  router.post('/api/checkin/confirm', checkinPinMiddleware, async (req, res) => {
    try {
      const { entry_id, device_name } = req.body;
      if (!entry_id) return res.status(400).json({ success: false, error: 'entry_id required' });

      // Check current state
      const existing = await pool.query(
        `SELECT entry_id, checked_in_at FROM race_entries WHERE entry_id = $1`,
        [entry_id]
      );
      if (!existing.rows.length) return res.status(404).json({ success: false, error: 'Entry not found' });

      if (existing.rows[0].checked_in_at) {
        return res.json({
          success: false,
          already_checked_in: true,
          checked_in_at: existing.rows[0].checked_in_at,
          error: 'Already checked in'
        });
      }

      const r = await pool.query(
        `UPDATE race_entries
            SET checked_in_at = NOW(),
                checked_in_by = $2
          WHERE entry_id = $1
          RETURNING entry_id, checked_in_at, checked_in_by`,
        [entry_id, device_name || 'Scanner']
      );

      res.json({ success: true, entry: r.rows[0] });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // ADMIN endpoints
  // ─────────────────────────────────────────────────────────────────

  // Get check-in report for an event
  router.get('/api/admin/checkin/report', requireAdmin, async (req, res) => {
    try {
      const { event_id } = req.query;
      const params = [];
      let eventFilter = '';
      if (event_id) {
        params.push(event_id);
        eventFilter = `AND re.event_id = $1`;
      }

      const r = await pool.query(
        `SELECT
            re.entry_id,
            re.race_class,
            re.race_number,
            re.payment_reference,
            re.entry_status,
            re.payment_status,
            re.checked_in_at,
            re.checked_in_by,
            d.first_name,
            d.last_name,
            e.event_name
           FROM race_entries re
           LEFT JOIN drivers d ON re.driver_id = d.driver_id
           LEFT JOIN events  e ON re.event_id  = e.event_id
          WHERE re.checked_in_at IS NOT NULL
            ${eventFilter}
          ORDER BY re.checked_in_at DESC`,
        params
      );

      res.json({ success: true, entries: r.rows, total: r.rows.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Undo a check-in (admin only)
  router.post('/api/admin/checkin/undo/:entryId', requireAdmin, async (req, res) => {
    try {
      const { entryId } = req.params;
      await pool.query(
        `UPDATE race_entries SET checked_in_at = NULL, checked_in_by = NULL WHERE entry_id = $1`,
        [entryId]
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
};
