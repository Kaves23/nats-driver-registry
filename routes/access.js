/**
 * Access Control routes
 * Mounted in server.js:  app.use(require('./routes/access')(pool, requireAdmin));
 *
 * Public endpoints (device sync/log — protected by checkpoint PIN, not admin token):
 *   GET  /api/access/areas-public          — list active areas (for boot screen selector)
 *   GET  /api/access/sync/:areaId          — download full sync payload for a checkpoint device
 *   POST /api/access/log                   — batch upload access log from device
 *
 * Admin endpoints (requireAdmin middleware):
 *   GET    /api/admin/access/areas             — list all areas
 *   POST   /api/admin/access/areas             — create area
 *   PUT    /api/admin/access/areas/:id         — update area
 *   DELETE /api/admin/access/areas/:id         — delete area
 *   GET    /api/admin/access/areas/:id/permissions  — get permissions for area
 *   POST   /api/admin/access/areas/:id/permissions  — replace permissions for area
 *   GET    /api/admin/access/classes            — distinct race classes from race_entries
 *   GET    /api/admin/access/flags              — all active flags
 *   POST   /api/admin/access/flags              — add flag to an entry
 *   DELETE /api/admin/access/flags/:flagId      — deactivate a flag
 *   GET    /api/admin/access/log                — recent access log (with filters)
 *   GET    /api/admin/access/occupancy/:areaId  — live IN count for an area
 */

const { Router } = require('express');

// Simple in-memory PIN store for checkpoint devices (PIN validated against CHECKPOINT_PIN env var)
// Falls back to 'checkpoint2026' if not set.
function checkpointPinMiddleware(req, res, next) {
  const pin = req.headers['x-checkpoint-pin'] || req.query.pin || '';
  const expected = process.env.CHECKPOINT_PIN || 'checkpoint2026';
  if (pin !== expected) {
    return res.status(401).json({ success: false, error: 'Invalid checkpoint PIN' });
  }
  next();
}

module.exports = function accessRoutes(pool, requireAdmin) {
  const router = Router();

  // ─────────────────────────────────────────────────────────────────
  // PUBLIC / DEVICE endpoints
  // ─────────────────────────────────────────────────────────────────

  // List active areas — shown on checkpoint boot screen selector
  router.get('/api/access/areas-public', checkpointPinMiddleware, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT area_id, area_name, description, max_capacity
           FROM access_areas
          WHERE is_active = true
          ORDER BY area_name`
      );
      res.json({ success: true, areas: r.rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Full sync payload for a checkpoint device
  // Returns: area info, permission rules, all entries with barcodes + flags
  router.get('/api/access/sync/:areaId', checkpointPinMiddleware, async (req, res) => {
    try {
      const areaId = parseInt(req.params.areaId, 10);
      if (!areaId) return res.status(400).json({ success: false, error: 'Invalid area ID' });

      // Area info
      const areaR = await pool.query(
        `SELECT area_id, area_name, description, max_capacity FROM access_areas WHERE area_id = $1`,
        [areaId]
      );
      if (!areaR.rows.length) return res.status(404).json({ success: false, error: 'Area not found' });
      const area = areaR.rows[0];

      // Permission rules for this area
      const permR = await pool.query(
        `SELECT race_class, window_start, window_end
           FROM area_permissions
          WHERE area_id = $1 AND is_active = true`,
        [areaId]
      );
      const permissions = permR.rows; // [{race_class, window_start, window_end}, ...]

      // All race entries with driver info + barcodes
      const entryR = await pool.query(`
        SELECT re.entry_id,
               re.driver_barcode_1,
               re.driver_barcode_2,
               re.driver_barcode_3,
               re.race_class,
               d.first_name,
               d.last_name,
               d.race_number
          FROM race_entries re
          JOIN drivers d ON re.driver_id = d.driver_id
         WHERE re.driver_barcode_1 IS NOT NULL
            OR re.driver_barcode_2 IS NOT NULL
            OR re.driver_barcode_3 IS NOT NULL
         ORDER BY d.last_name, d.first_name
      `);

      // Active flags (all entries) — keyed by entry_id
      const flagR = await pool.query(`
        SELECT entry_id, flag_type, public_message
          FROM entry_access_flags
         WHERE is_active = true
      `);
      const flagMap = {};
      flagR.rows.forEach(f => { flagMap[f.entry_id] = { type: f.flag_type, message: f.public_message }; });

      const entries = entryR.rows.map(e => ({
        entry_id:  e.entry_id,
        barcodes:  [e.driver_barcode_1, e.driver_barcode_2, e.driver_barcode_3].filter(Boolean).map(b => b.toUpperCase()),
        race_class: e.race_class,
        first_name: e.first_name,
        last_name:  e.last_name,
        race_number: e.race_number,
        flag: flagMap[e.entry_id] || null,
      }));

      res.json({
        success: true,
        area,
        permissions,
        entries,
        synced_at: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Batch upload access log from device
  router.post('/api/access/log', checkpointPinMiddleware, async (req, res) => {
    try {
      const { area_id, device_id, events } = req.body;
      if (!Array.isArray(events) || !events.length) {
        return res.json({ success: true, inserted: 0 });
      }
      let inserted = 0;
      for (const ev of events) {
        await pool.query(`
          INSERT INTO access_log
            (entry_id, area_id, direction, was_allowed, denial_reason, scanned_at, device_id, is_manual_override)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [
          ev.entry_id   || null,
          area_id       || null,
          ev.direction  || 'IN',
          ev.was_allowed !== false,
          ev.denial_reason || null,
          ev.scanned_at ? new Date(ev.scanned_at) : new Date(),
          device_id     || null,
          ev.is_manual_override || false,
        ]);
        inserted++;
      }
      res.json({ success: true, inserted });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // ADMIN endpoints
  // ─────────────────────────────────────────────────────────────────

  // List all areas
  router.get('/api/admin/access/areas', requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(`SELECT * FROM access_areas ORDER BY area_name`);
      res.json({ success: true, areas: r.rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Create area
  router.post('/api/admin/access/areas', requireAdmin, async (req, res) => {
    try {
      const { area_name, description, max_capacity } = req.body;
      if (!area_name) return res.status(400).json({ success: false, error: 'area_name required' });
      const r = await pool.query(
        `INSERT INTO access_areas (area_name, description, max_capacity)
         VALUES ($1,$2,$3) RETURNING *`,
        [area_name.trim(), description || '', max_capacity || null]
      );
      res.json({ success: true, area: r.rows[0] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Update area
  router.put('/api/admin/access/areas/:id', requireAdmin, async (req, res) => {
    try {
      const { area_name, description, max_capacity, is_active } = req.body;
      const r = await pool.query(
        `UPDATE access_areas SET area_name=$1, description=$2, max_capacity=$3, is_active=$4
          WHERE area_id=$5 RETURNING *`,
        [area_name, description || '', max_capacity || null, is_active !== false, req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true, area: r.rows[0] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Delete area
  router.delete('/api/admin/access/areas/:id', requireAdmin, async (req, res) => {
    try {
      await pool.query(`DELETE FROM access_areas WHERE area_id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Get permissions for an area
  router.get('/api/admin/access/areas/:id/permissions', requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT * FROM area_permissions WHERE area_id=$1 ORDER BY race_class`,
        [req.params.id]
      );
      res.json({ success: true, permissions: r.rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Replace permissions for an area (send full array)
  router.post('/api/admin/access/areas/:id/permissions', requireAdmin, async (req, res) => {
    try {
      const areaId = req.params.id;
      const { permissions } = req.body; // [{race_class, window_start, window_end}]
      await pool.query(`DELETE FROM area_permissions WHERE area_id=$1`, [areaId]);
      if (Array.isArray(permissions) && permissions.length) {
        for (const p of permissions) {
          await pool.query(
            `INSERT INTO area_permissions (area_id, race_class, window_start, window_end)
             VALUES ($1,$2,$3,$4)`,
            [areaId, p.race_class || null, p.window_start || null, p.window_end || null]
          );
        }
      }
      const r = await pool.query(`SELECT * FROM area_permissions WHERE area_id=$1`, [areaId]);
      res.json({ success: true, permissions: r.rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Distinct race classes from live entries
  router.get('/api/admin/access/classes', requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT DISTINCT race_class FROM race_entries WHERE race_class IS NOT NULL AND race_class <> '' ORDER BY race_class`
      );
      res.json({ success: true, classes: r.rows.map(x => x.race_class) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // List all active flags
  router.get('/api/admin/access/flags', requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(`
        SELECT f.*, d.first_name, d.last_name, re.race_class
          FROM entry_access_flags f
          JOIN race_entries re ON f.entry_id = re.entry_id
          JOIN drivers d ON re.driver_id = d.driver_id
         WHERE f.is_active = true
         ORDER BY f.created_at DESC
      `);
      res.json({ success: true, flags: r.rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Add flag
  router.post('/api/admin/access/flags', requireAdmin, async (req, res) => {
    try {
      const { entry_id, flag_type, public_message, admin_note, flagged_by } = req.body;
      if (!entry_id) return res.status(400).json({ success: false, error: 'entry_id required' });
      // Deactivate any existing flag for this entry first
      await pool.query(`UPDATE entry_access_flags SET is_active=false WHERE entry_id=$1`, [entry_id]);
      const r = await pool.query(`
        INSERT INTO entry_access_flags (entry_id, flag_type, public_message, admin_note, flagged_by)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [entry_id, flag_type || 'BLOCK', public_message || 'Entry flagged — contact Race Director', admin_note || '', flagged_by || 'Admin']
      );
      res.json({ success: true, flag: r.rows[0] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Remove flag
  router.delete('/api/admin/access/flags/:flagId', requireAdmin, async (req, res) => {
    try {
      await pool.query(`UPDATE entry_access_flags SET is_active=false WHERE flag_id=$1`, [req.params.flagId]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Recent access log
  router.get('/api/admin/access/log', requireAdmin, async (req, res) => {
    try {
      const { area_id, limit = 200 } = req.query;
      const params = [];
      let where = '';
      if (area_id) { params.push(area_id); where = `WHERE l.area_id = $${params.length}`; }
      const r = await pool.query(`
        SELECT l.log_id, l.entry_id, l.area_id, a.area_name, l.direction,
               l.was_allowed, l.denial_reason, l.scanned_at, l.device_id, l.is_manual_override,
               d.first_name, d.last_name, re.race_class, re.race_number
          FROM access_log l
          LEFT JOIN access_areas a     ON l.area_id = a.area_id
          LEFT JOIN race_entries re     ON l.entry_id = re.entry_id
          LEFT JOIN drivers d           ON re.driver_id = d.driver_id
          ${where}
         ORDER BY l.scanned_at DESC
         LIMIT $${params.length + 1}
      `, [...params, parseInt(limit)]);
      res.json({ success: true, log: r.rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Live occupancy for an area (count IN minus OUT for today)
  router.get('/api/admin/access/occupancy/:areaId', requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE direction='IN'  AND was_allowed=true) AS total_in,
          COUNT(*) FILTER (WHERE direction='OUT' AND was_allowed=true) AS total_out
          FROM access_log
         WHERE area_id = $1
           AND scanned_at >= CURRENT_DATE
      `, [req.params.areaId]);
      const row = r.rows[0];
      const inside = Math.max(0, parseInt(row.total_in||0) - parseInt(row.total_out||0));
      res.json({ success: true, inside, total_in: parseInt(row.total_in||0), total_out: parseInt(row.total_out||0) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  return router;
};
