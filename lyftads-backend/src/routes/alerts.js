const router = require('express').Router();
const { query } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

/* GET /api/alerts — tutti gli alert attivi */
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await query(`
    SELECT a.*, c.name as client_name FROM alerts a
    JOIN clients c ON c.id = a.client_id
    WHERE c.agency_user_id = $1 AND a.is_active = TRUE
    ORDER BY a.triggered_at DESC
  `, [req.user.userId]);
  res.json(rows);
});

/* POST /api/alerts/:id/resolve */
router.post('/:id/resolve', requireAuth, async (req, res) => {
  await query('UPDATE alerts SET is_active=FALSE, resolved_at=NOW() WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
