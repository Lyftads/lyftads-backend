const axios = require('axios');
const { query, decryptToken } = require('../models/db');

/* ════════════════════════════════════════
   METRICS SERVICE
   Recupera dati reali dalle API di ogni
   piattaforma e li salva in metrics_cache.
════════════════════════════════════════ */

function isoDate(d) { return d.toISOString().split('T')[0]; }

function dateRange(from, to) {
  const dates = [];
  const cur = new Date(from);
  while (cur <= to) { dates.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
  return dates;
}

/* ── META ADS ── */
async function fetchMeta(token, accountId, from, to) {
  const access_token = decryptToken(token);
  const res = await axios.get(`https://graph.facebook.com/v18.0/${accountId}/insights`, {
    params: {
      access_token,
      level: 'account',
      fields: 'spend,impressions,clicks,actions,action_values,cpm,ctr,frequency,cost_per_action_type',
      time_range: JSON.stringify({ since: isoDate(from), until: isoDate(to) }),
      time_increment: 1,
    }
  });
  return res.data.data.map(d => {
    const purchases = d.actions?.find(a => a.action_type === 'purchase')?.value || 0;
    const revenue = d.action_values?.find(a => a.action_type === 'purchase')?.value || 0;
    const linkClicks = d.actions?.find(a => a.action_type === 'link_click')?.value || 0;
    return {
      date: d.date_start,
      spend: parseFloat(d.spend || 0),
      revenue: parseFloat(revenue),
      impressions: parseInt(d.impressions || 0),
      clicks: parseInt(d.clicks || 0),
      link_clicks: parseInt(linkClicks),
      orders: parseInt(purchases),
      roas: revenue > 0 && d.spend > 0 ? parseFloat((revenue / d.spend).toFixed(2)) : 0,
      cpm: parseFloat(d.cpm || 0),
      ctr: parseFloat(d.ctr || 0),
      ctr_link: linkClicks > 0 && d.impressions > 0 ? parseFloat((linkClicks / d.impressions * 100).toFixed(2)) : 0,
      cpc_link: linkClicks > 0 ? parseFloat((d.spend / linkClicks).toFixed(2)) : 0,
      frequency: parseFloat(d.frequency || 0),
      cpo: purchases > 0 ? parseFloat((d.spend / purchases).toFixed(2)) : 0,
    };
  });
}

/* ── GOOGLE ADS ── */
async function fetchGoogle(token, customerId, devToken, from, to) {
  const access_token = decryptToken(token);
  const cleanId = customerId.replace('-', '');
  const query_str = `
    SELECT
      segments.date,
      metrics.cost_micros,
      metrics.conversions_value,
      metrics.conversions,
      metrics.impressions,
      metrics.clicks,
      metrics.average_cpc,
      metrics.ctr
    FROM customer
    WHERE segments.date BETWEEN '${isoDate(from)}' AND '${isoDate(to)}'
  `;
  const res = await axios.post(
    `https://googleads.googleapis.com/v14/customers/${cleanId}/googleAds:search`,
    { query: query_str },
    { headers: { Authorization: `Bearer ${access_token}`, 'developer-token': devToken, 'login-customer-id': cleanId } }
  );
  return (res.data.results || []).map(r => {
    const spend = (r.metrics.costMicros || 0) / 1e6;
    const revenue = parseFloat(r.metrics.conversionsValue || 0);
    return {
      date: r.segments.date,
      spend,
      revenue,
      impressions: parseInt(r.metrics.impressions || 0),
      clicks: parseInt(r.metrics.clicks || 0),
      orders: parseFloat(r.metrics.conversions || 0),
      roas: spend > 0 ? parseFloat((revenue / spend).toFixed(2)) : 0,
      cpc: parseFloat(r.metrics.averageCpc || 0) / 1e6,
      ctr: parseFloat(r.metrics.ctr || 0) * 100,
      conv_rate: r.metrics.clicks > 0 ? parseFloat((r.metrics.conversions / r.metrics.clicks * 100).toFixed(2)) : 0,
    };
  });
}

/* ── SHOPIFY ── */
async function fetchShopify(token, shopDomain, from, to) {
  const access_token = decryptToken(token);
  const res = await axios.get(`https://${shopDomain}/admin/api/2023-10/orders.json`, {
    headers: { 'X-Shopify-Access-Token': access_token },
    params: {
      status: 'any',
      created_at_min: from.toISOString(),
      created_at_max: to.toISOString(),
      limit: 250,
      fields: 'id,created_at,total_price,line_items,financial_status',
    }
  });
  /* Aggrega per giorno */
  const byDay = {};
  res.data.orders.forEach(order => {
    if (order.financial_status === 'refunded' || order.financial_status === 'voided') return;
    const day = order.created_at.split('T')[0];
    if (!byDay[day]) byDay[day] = { revenue: 0, orders: 0 };
    byDay[day].revenue += parseFloat(order.total_price);
    byDay[day].orders++;
  });
  /* Sessioni (richiede endpoint separato analytics) */
  return Object.entries(byDay).map(([date, d]) => ({
    date, revenue: parseFloat(d.revenue.toFixed(2)), orders: d.orders,
    aov: d.orders > 0 ? parseFloat((d.revenue / d.orders).toFixed(2)) : 0,
  }));
}

/* ── KLAVIYO ── */
async function fetchKlaviyo(apiKey, from, to) {
  const access_token = decryptToken(apiKey);
  const res = await axios.get('https://a.klaviyo.com/api/campaigns/', {
    headers: { Authorization: `Klaviyo-API-Key ${access_token}`, revision: '2023-10-15' },
    params: { 'filter': `greater-or-equal(send_time,${from.toISOString()}),less-or-equal(send_time,${to.toISOString()})` }
  });
  const campaigns = res.data.data || [];
  /* Per ogni campagna, prendi le metriche */
  const metrics = [];
  for (const camp of campaigns.slice(0, 50)) {
    try {
      const mRes = await axios.get(`https://a.klaviyo.com/api/campaign-send-jobs/${camp.id}/`, {
        headers: { Authorization: `Klaviyo-API-Key ${access_token}`, revision: '2023-10-15' }
      });
      metrics.push({ campaign_id: camp.id, name: camp.attributes?.name, send_time: camp.attributes?.send_time, ...mRes.data });
    } catch (_) {}
  }
  return metrics;
}

/* ── TIKTOK ADS ── */
async function fetchTikTok(token, advertiserId, from, to) {
  const access_token = decryptToken(token);
  const res = await axios.get('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/', {
    headers: { 'Access-Token': access_token },
    params: {
      advertiser_id: advertiserId,
      report_type: 'BASIC',
      dimensions: JSON.stringify(['stat_time_day']),
      metrics: JSON.stringify(['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'conversion', 'value', 'roas']),
      start_date: isoDate(from),
      end_date: isoDate(to),
      page_size: 100,
    }
  });
  return (res.data.data?.list || []).map(d => ({
    date: d.dimensions.stat_time_day,
    spend: parseFloat(d.metrics.spend || 0),
    revenue: parseFloat(d.metrics.value || 0),
    impressions: parseInt(d.metrics.impressions || 0),
    clicks: parseInt(d.metrics.clicks || 0),
    orders: parseInt(d.metrics.conversion || 0),
    roas: parseFloat(d.metrics.roas || 0),
    ctr: parseFloat(d.metrics.ctr || 0),
    cpc: parseFloat(d.metrics.cpc || 0),
    cpm: parseFloat(d.metrics.cpm || 0),
    cpo: d.metrics.conversion > 0 ? parseFloat((d.metrics.spend / d.metrics.conversion).toFixed(2)) : 0,
  }));
}

/* ── AMAZON ADS ── */
async function fetchAmazon(token, profileId, apiBase, from, to) {
  const access_token = decryptToken(token);
  const headers = {
    Authorization: `Bearer ${access_token}`,
    'Amazon-Advertising-API-ClientId': process.env.AMAZON_CLIENT_ID,
    'Amazon-Advertising-API-Scope': profileId,
    'Content-Type': 'application/json',
  };
  /* Richiedi report asincrono */
  const reportRes = await axios.post(`${apiBase}/v2/sp/campaigns/report`, {
    reportDate: isoDate(from),
    metrics: 'cost,sales7d,purchases7d,impressions,clicks,attributedUnitsOrdered7d',
    segment: 'query',
  }, { headers });
  /* Aspetta completamento (polling) */
  let reportData = null;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusRes = await axios.get(`${apiBase}/v2/reports/${reportRes.data.reportId}`, { headers });
    if (statusRes.data.status === 'SUCCESS') {
      const dlRes = await axios.get(statusRes.data.location, { headers, responseType: 'json' });
      reportData = dlRes.data;
      break;
    }
  }
  if (!reportData) return [];
  /* Aggrega per giorno */
  const spend = reportData.reduce((s, r) => s + (r.cost || 0), 0);
  const revenue = reportData.reduce((s, r) => s + (r.sales7d || 0), 0);
  const orders = reportData.reduce((s, r) => s + (r.purchases7d || 0), 0);
  return [{ date: isoDate(from), spend, revenue, orders, roas: spend > 0 ? revenue / spend : 0, tacos: revenue > 0 ? spend / revenue * 100 : 0, acos: revenue > 0 ? spend / revenue * 100 : 0 }];
}

/* ════════════════════════════════════════
   MAIN: fetchAndCacheMetrics(clientId)
   Chiama tutte le piattaforme connesse e
   salva i risultati nella cache DB.
════════════════════════════════════════ */
async function fetchAndCacheMetrics(clientId, from, to) {
  if (!from) { from = new Date(); from.setDate(from.getDate() - 30); }
  if (!to) to = new Date();

  const { rows: tokens } = await query(
    'SELECT * FROM platform_tokens WHERE client_id = $1',
    [clientId]
  );

  for (const token of tokens) {
    try {
      let data = [];
      const extra = token.extra_data || {};

      if (token.platform === 'meta') {
        data = await fetchMeta(token.access_token, token.account_id, from, to);
      } else if (token.platform === 'google') {
        data = await fetchGoogle(token.access_token, token.account_id, extra.developer_token, from, to);
      } else if (token.platform === 'shopify') {
        data = await fetchShopify(token.access_token, extra.shop_domain, from, to);
      } else if (token.platform === 'klaviyo') {
        data = await fetchKlaviyo(token.access_token, from, to);
      } else if (token.platform === 'tiktok') {
        data = await fetchTikTok(token.access_token, token.account_id, from, to);
      } else if (token.platform === 'amazon') {
        data = await fetchAmazon(token.access_token, token.account_id, extra.api_base, from, to);
      }

      /* Salva ogni giorno in cache */
      for (const dayData of data) {
        await query(`
          INSERT INTO metrics_cache (client_id, platform, date, data)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (client_id, platform, date) DO UPDATE SET data = EXCLUDED.data, fetched_at = NOW()
        `, [clientId, token.platform, dayData.date, JSON.stringify(dayData)]);
      }

      /* Controlla alert (-15% ultimi 3gg vs media 30gg) */
      await checkAlerts(clientId, token.platform);

    } catch (err) {
      console.error(`[METRICS] ${token.platform} client ${clientId}:`, err.message);
    }
  }
}

/* ── Alert detection ── */
async function checkAlerts(clientId, platform) {
  const { rows: last3 } = await query(`
    SELECT data FROM metrics_cache WHERE client_id=$1 AND platform=$2
    AND date >= CURRENT_DATE - INTERVAL '3 days' ORDER BY date DESC
  `, [clientId, platform]);

  const { rows: last30 } = await query(`
    SELECT data FROM metrics_cache WHERE client_id=$1 AND platform=$2
    AND date >= CURRENT_DATE - INTERVAL '30 days' ORDER BY date DESC
  `, [clientId, platform]);

  if (!last3.length || !last30.length) return;

  const avg = (arr, key) => arr.reduce((s, r) => s + (r.data[key] || 0), 0) / arr.length;
  const metricsToCheck = ['roas', 'spend', 'revenue'];

  for (const metric of metricsToCheck) {
    const avg3 = avg(last3, metric);
    const avg30 = avg(last30, metric);
    if (avg30 === 0) continue;
    const drop = ((avg3 - avg30) / avg30) * 100;
    if (drop <= -15) {
      await query(`
        INSERT INTO alerts (client_id, platform, metric, drop_pct)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING
      `, [clientId, platform, metric, drop.toFixed(2)]);
    }
  }
}

module.exports = { fetchAndCacheMetrics, checkAlerts };
