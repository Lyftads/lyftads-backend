const router = require('express').Router();
const { query } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

/* GET /api/clients */
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, 
      json_agg(json_build_object('platform', pt.platform, 'account_name', pt.account_name, 'connected_at', pt.connected_at, 'last_refreshed', pt.last_refreshed)) FILTER (WHERE pt.platform IS NOT NULL) as connections
     FROM clients c
     LEFT JOIN platform_tokens pt ON pt.client_id = c.id
     WHERE c.agency_user_id = $1
     GROUP BY c.id ORDER BY c.created_at DESC`,
    [req.user.userId]
  );
  res.json(rows);
});

/* POST /api/clients */
router.post('/', requireAuth, async (req, res) => {
  const { name, industry } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome cliente obbligatorio.' });
  const { rows } = await query(
    'INSERT INTO clients (agency_user_id, name, industry) VALUES ($1, $2, $3) RETURNING *',
    [req.user.userId, name, industry]
  );
  res.status(201).json(rows[0]);
});

/* PUT /api/clients/:id */
router.put('/:id', requireAuth, async (req, res) => {
  const { name, industry } = req.body;
  const { rows } = await query(
    'UPDATE clients SET name=$1, industry=$2 WHERE id=$3 AND agency_user_id=$4 RETURNING *',
    [name, industry, req.params.id, req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Cliente non trovato.' });
  res.json(rows[0]);
});

/* DELETE /api/clients/:id */
router.delete('/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM clients WHERE id=$1 AND agency_user_id=$2', [req.params.id, req.user.userId]);
  res.json({ success: true });
});

module.exports = router;
