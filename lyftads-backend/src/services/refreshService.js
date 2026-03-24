const axios = require('axios');
const { query, encryptToken, decryptToken } = require('../models/db');

/* ════════════════════════════════════════
   TOKEN REFRESH SERVICE
   Eseguito ogni 15 minuti dal cron job.
   Refresha i token in scadenza (<24h) e
   aggiorna la cache delle metriche.
════════════════════════════════════════ */

async function refreshMetaToken(token) {
  const res = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: decryptToken(token.access_token),
    }
  });
  return { access_token: res.data.access_token, expires_in: res.data.expires_in || 5184000 };
}

async function refreshGoogleToken(token) {
  const res = await axios.post('https://oauth2.googleapis.com/token', {
    grant_type: 'refresh_token',
    refresh_token: decryptToken(token.refresh_token),
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
  });
  return { access_token: res.data.access_token, expires_in: res.data.expires_in };
}

async function refreshTikTokToken(token) {
  const res = await axios.post('https://business-api.tiktok.com/open_api/v1.3/oauth2/refresh_token/', {
    app_id: process.env.TIKTOK_APP_ID,
    secret: process.env.TIKTOK_APP_SECRET,
    refresh_token: decryptToken(token.refresh_token),
    grant_type: 'refresh_token',
  });
  return { access_token: res.data.data.access_token, refresh_token: res.data.data.refresh_token, expires_in: res.data.data.expires_in };
}

async function refreshAmazonToken(token) {
  const res = await axios.post('https://api.amazon.com/auth/o2/token', new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: decryptToken(token.refresh_token),
    client_id: process.env.AMAZON_CLIENT_ID,
    client_secret: process.env.AMAZON_CLIENT_SECRET,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return { access_token: res.data.access_token, expires_in: res.data.expires_in };
}

async function updateToken(id, platform, data) {
  const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
  await query(`
    UPDATE platform_tokens SET
      access_token = $1,
      refresh_token = COALESCE($2, refresh_token),
      token_expires_at = $3,
      last_refreshed = NOW()
    WHERE id = $4
  `, [
    encryptToken(data.access_token),
    data.refresh_token ? encryptToken(data.refresh_token) : null,
    expiresAt, id
  ]);
}

async function runAllRefreshes() {
  /* Prendi tutti i token che scadono entro 24 ore o sono già scaduti */
  const { rows: tokens } = await query(`
    SELECT id, client_id, platform, access_token, refresh_token, token_expires_at, extra_data
    FROM platform_tokens
    WHERE token_expires_at IS NULL
       OR token_expires_at < NOW() + INTERVAL '24 hours'
  `);

  for (const token of tokens) {
    try {
      let newTokenData = null;
      if (token.platform === 'meta' && token.access_token) {
        newTokenData = await refreshMetaToken(token);
      } else if (token.platform === 'google' && token.refresh_token) {
        newTokenData = await refreshGoogleToken(token);
      } else if (token.platform === 'tiktok' && token.refresh_token) {
        newTokenData = await refreshTikTokToken(token);
      } else if (token.platform === 'amazon' && token.refresh_token) {
        newTokenData = await refreshAmazonToken(token);
      }
      /* Shopify e Klaviyo non hanno refresh (token permanenti) */
      if (newTokenData) {
        await updateToken(token.id, token.platform, newTokenData);
        console.log(`[REFRESH] ${token.platform} token aggiornato per client ${token.client_id}`);
      }
    } catch (err) {
      console.error(`[REFRESH] Errore ${token.platform} client ${token.client_id}:`, err.message);
    }
  }

  /* Aggiorna metriche per tutti i client connessi */
  await refreshAllMetrics();
}

async function refreshAllMetrics() {
  const { rows: allTokens } = await query('SELECT DISTINCT client_id FROM platform_tokens');
  const { fetchAndCacheMetrics } = require('./metricsService');
  for (const { client_id } of allTokens) {
    await fetchAndCacheMetrics(client_id).catch(err =>
      console.error(`[METRICS] Errore fetch client ${client_id}:`, err.message)
    );
  }
}

module.exports = { runAllRefreshes };
