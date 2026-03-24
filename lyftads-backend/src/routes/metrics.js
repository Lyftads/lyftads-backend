const router = require('express').Router();
const { query } = require('../models/db');
const { requireAuth } = require('../middleware/auth');
const { fetchAndCacheMetrics } = require('../services/metricsService');

/* ── GET /api/metrics/:clientId?from=&to=&platform= ── */
router.get('/:clientId', requireAuth, async (req, res) => {
  const { clientId } = req.params;
  const { from, to, platform } = req.query;

  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const toDate = to ? new Date(to) : new Date();

  try {
    let q = `SELECT platform, date, data FROM metrics_cache WHERE client_id = $1 AND date BETWEEN $2 AND $3`;
    const params = [clientId, fromDate.toISOString().split('T')[0], toDate.toISOString().split('T')[0]];
    if (platform) { q += ` AND platform = $4`; params.push(platform); }
    q += ` ORDER BY platform, date ASC`;

    const { rows } = await query(q, params);

    /* Raggruppa per piattaforma */
    const result = {};
    rows.forEach(r => {
      if (!result[r.platform]) result[r.platform] = [];
      result[r.platform].push({ date: r.date, ...r.data });
    });

    /* KPI aggregate */
    const kpis = {};
    Object.entries(result).forEach(([plat, days]) => {
      const total_revenue = days.reduce((s, d) => s + (d.revenue || 0), 0);
      const total_spend = days.reduce((s, d) => s + (d.spend || 0), 0);
      const total_orders = days.reduce((s, d) => s + (d.orders || 0), 0);
      kpis[plat] = {
        revenue: Math.round(total_revenue * 100) / 100,
        spend: Math.round(total_spend * 100) / 100,
        orders: Math.round(total_orders),
        roas: total_spend > 0 ? Math.round((total_revenue / total_spend) * 100) / 100 : 0,
        mer: 0, /* calcolato lato client con Shopify revenue */
      };
    });

    res.json({ daily: result, kpis, period: { from: fromDate, to: toDate } });
  } catch (err) {
    console.error('[METRICS GET]', err.message);
    res.status(500).json({ error: 'Errore recupero metriche.' });
  }
});

/* ── POST /api/metrics/:clientId/refresh — forza refresh immediato ── */
router.post('/:clientId/refresh', requireAuth, async (req, res) => {
  const { clientId } = req.params;
  const { from, to } = req.body;
  try {
    await fetchAndCacheMetrics(
      clientId,
      from ? new Date(from) : new Date(Date.now() - 30 * 86400000),
      to ? new Date(to) : new Date()
    );
    res.json({ success: true, refreshed_at: new Date() });
  } catch (err) {
    res.status(500).json({ error: 'Errore refresh.' });
  }
});

/* ── GET /api/metrics/:clientId/summary — KPI per overview ── */
router.get('/:clientId/summary', requireAuth, async (req, res) => {
  const { clientId } = req.params;
  const { from, to } = req.query;
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const toDate = to ? new Date(to) : new Date();
  const prevFrom = new Date(fromDate - (toDate - fromDate));

  try {
    const curr = await query(`SELECT platform, SUM((data->>'revenue')::numeric) as rev, SUM((data->>'spend')::numeric) as spend, SUM((data->>'orders')::numeric) as orders FROM metrics_cache WHERE client_id=$1 AND date BETWEEN $2 AND $3 GROUP BY platform`, [clientId, fromDate.toISOString().split('T')[0], toDate.toISOString().split('T')[0]]);
    const prev = await query(`SELECT platform, SUM((data->>'revenue')::numeric) as rev, SUM((data->>'spend')::numeric) as spend FROM metrics_cache WHERE client_id=$1 AND date BETWEEN $2 AND $3 GROUP BY platform`, [clientId, prevFrom.toISOString().split('T')[0], fromDate.toISOString().split('T')[0]]);

    res.json({ current: curr.rows, previous: prev.rows });
  } catch (err) {
    res.status(500).json({ error: 'Errore summary.' });
  }
});

module.exports = router;
