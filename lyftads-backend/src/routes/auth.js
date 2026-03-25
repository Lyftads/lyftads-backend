const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { query, encryptToken } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

/* ════════════════════════════════════════
   AGENCY LOGIN / REGISTER
════════════════════════════════════════ */
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e password obbligatorie.' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await query(
      'INSERT INTO agency_users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email.toLowerCase(), hash, name]
    );
    const token = jwt.sign({ userId: rows[0].id, email: rows[0].email }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
    res.json({ token, user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email già registrata.' });
    res.status(500).json({ error: 'Errore registrazione.' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await query('SELECT * FROM agency_users WHERE email = $1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Credenziali non valide.' });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenziali non valide.' });
    const token = jwt.sign({ userId: rows[0].id, email: rows[0].email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: rows[0].id, email: rows[0].email, name: rows[0].name } });
  } catch (err) {
    console.error('[LOGIN ERROR]', err.message, err.stack);
    res.status(500).json({ error: 'Errore login.', detail: err.message });
  }
});

/* ════════════════════════════════════════
   HELPER: salva token nel DB
════════════════════════════════════════ */
async function saveToken(clientId, platform, data) {
  const { access_token, refresh_token, expires_in, account_id, account_name, extra } = data;
  const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;
  await query(`
    INSERT INTO platform_tokens (client_id, platform, access_token, refresh_token, token_expires_at, account_id, account_name, extra_data, last_refreshed)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (client_id, platform) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = COALESCE(EXCLUDED.refresh_token, platform_tokens.refresh_token),
      token_expires_at = EXCLUDED.token_expires_at,
      account_id = COALESCE(EXCLUDED.account_id, platform_tokens.account_id),
      account_name = COALESCE(EXCLUDED.account_name, platform_tokens.account_name),
      extra_data = EXCLUDED.extra_data,
      last_refreshed = NOW()
  `, [
    clientId, platform,
    encryptToken(access_token),
    refresh_token ? encryptToken(refresh_token) : null,
    expiresAt, account_id, account_name,
    JSON.stringify(extra || {})
  ]);
}

/* ════════════════════════════════════════
   META ADS — OAuth 2.0
   Scope: ads_read, ads_management, business_management
════════════════════════════════════════ */
router.get('/meta/connect', requireAuth, (req, res) => {
  const { clientId } = req.query;
  const state = Buffer.from(JSON.stringify({ userId: req.user.userId, clientId })).toString('base64');
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: process.env.META_REDIRECT_URI,
    scope: 'ads_read,ads_management,business_management',
    response_type: 'code',
    state,
  });
  res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?${params}`);
});

router.get('/meta/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${process.env.FRONTEND_URL}?error=meta_denied`);
  try {
    const { userId, clientId } = JSON.parse(Buffer.from(state, 'base64').toString());
    const tokenRes = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, redirect_uri: process.env.META_REDIRECT_URI, code }
    });
    const { access_token, expires_in } = tokenRes.data;
    /* Scambia con long-lived token (60 giorni) */
    const llRes = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: { grant_type: 'fb_exchange_token', client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, fb_exchange_token: access_token }
    });
    /* Recupera account pubblicitari */
    const adAccountsRes = await axios.get('https://graph.facebook.com/v18.0/me/adaccounts', {
      params: { access_token: llRes.data.access_token, fields: 'id,name' }
    });
    const firstAccount = adAccountsRes.data.data?.[0];
    await saveToken(clientId, 'meta', {
      access_token: llRes.data.access_token,
      expires_in: llRes.data.expires_in || 5184000,
      account_id: firstAccount?.id,
      account_name: firstAccount?.name,
    });
    res.redirect(`${process.env.FRONTEND_URL}?connected=meta&client=${clientId}`);
  } catch (err) {
    console.error('[META] Callback error:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=meta_failed`);
  }
});

/* ════════════════════════════════════════
   GOOGLE ADS — OAuth 2.0
   Scope: Google Ads API
════════════════════════════════════════ */
router.get('/google/connect', requireAuth, (req, res) => {
  const { clientId } = req.query;
  const state = Buffer.from(JSON.stringify({ userId: req.user.userId, clientId })).toString('base64');
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    scope: 'https://www.googleapis.com/auth/adwords',
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${process.env.FRONTEND_URL}?error=google_denied`);
  try {
    const { userId, clientId } = JSON.parse(Buffer.from(state, 'base64').toString());
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code, client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    });
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    /* Lista customer ID Google Ads */
    const cusRes = await axios.get('https://googleads.googleapis.com/v14/customers:listAccessibleCustomers', {
      headers: { Authorization: `Bearer ${access_token}`, 'developer-token': process.env.GOOGLE_DEVELOPER_TOKEN }
    });
    const firstCustomer = cusRes.data.resourceNames?.[0]?.replace('customers/', '');
    await saveToken(clientId, 'google', { access_token, refresh_token, expires_in, account_id: firstCustomer, extra: { developer_token: process.env.GOOGLE_DEVELOPER_TOKEN } });
    res.redirect(`${process.env.FRONTEND_URL}?connected=google&client=${clientId}`);
  } catch (err) {
    console.error('[GOOGLE] Callback error:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=google_failed`);
  }
});

/* ════════════════════════════════════════
   SHOPIFY — OAuth 2.0
   Scope: read_orders, read_analytics, read_reports
════════════════════════════════════════ */
router.get('/shopify/connect', requireAuth, (req, res) => {
  const { clientId, shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'Parametro "shop" obbligatorio (es. mio-negozio.myshopify.com)' });
  const state = Buffer.from(JSON.stringify({ userId: req.user.userId, clientId, shop })).toString('base64');
  const params = new URLSearchParams({
    client_id: process.env.SHOPIFY_CLIENT_ID,
    scope: 'read_orders,read_analytics,read_reports,read_products',
    redirect_uri: process.env.SHOPIFY_REDIRECT_URI,
    state,
  });
  res.redirect(`https://${shop}/admin/oauth/authorize?${params}`);
});

router.get('/shopify/callback', async (req, res) => {
  const { code, state, hmac, shop } = req.query;
  try {
    const { userId, clientId } = JSON.parse(Buffer.from(state, 'base64').toString());
    const tokenRes = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      code,
    });
    const { access_token } = tokenRes.data;
    /* Recupera info negozio */
    const shopRes = await axios.get(`https://${shop}/admin/api/2023-10/shop.json`, {
      headers: { 'X-Shopify-Access-Token': access_token }
    });
    await saveToken(clientId, 'shopify', {
      access_token,
      account_id: shopRes.data.shop?.id?.toString(),
      account_name: shopRes.data.shop?.name,
      extra: { shop_domain: shop, shop_email: shopRes.data.shop?.email }
    });
    res.redirect(`${process.env.FRONTEND_URL}?connected=shopify&client=${clientId}`);
  } catch (err) {
    console.error('[SHOPIFY] Callback error:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=shopify_failed`);
  }
});

/* ════════════════════════════════════════
   KLAVIYO — API Key diretta (no OAuth)
   L'utente incolla la sua API Key privata
════════════════════════════════════════ */
router.post('/klaviyo/connect', requireAuth, async (req, res) => {
  const { clientId, apiKey } = req.body;
  if (!clientId || !apiKey) return res.status(400).json({ error: 'clientId e apiKey obbligatorie.' });
  try {
    /* Verifica chiave chiamando /api/accounts */
    const verRes = await axios.get('https://a.klaviyo.com/api/accounts/', {
      headers: { Authorization: `Klaviyo-API-Key ${apiKey}`, revision: '2023-10-15' }
    });
    const account = verRes.data.data?.[0];
    await saveToken(clientId, 'klaviyo', {
      access_token: apiKey,
      account_id: account?.id,
      account_name: account?.attributes?.contact_information?.organization_name,
    });
    res.json({ success: true, account_name: account?.attributes?.contact_information?.organization_name });
  } catch (err) {
    res.status(400).json({ error: 'API Key Klaviyo non valida.' });
  }
});

/* ════════════════════════════════════════
   TIKTOK ADS — OAuth 2.0
   Scope: ad.read, report.read
════════════════════════════════════════ */
router.get('/tiktok/connect', requireAuth, (req, res) => {
  const { clientId } = req.query;
  const state = Buffer.from(JSON.stringify({ userId: req.user.userId, clientId })).toString('base64');
  const params = new URLSearchParams({
    app_id: process.env.TIKTOK_APP_ID,
    redirect_uri: process.env.TIKTOK_REDIRECT_URI,
    state,
  });
  res.redirect(`https://ads.tiktok.com/marketing_api/auth?${params}`);
});

router.get('/tiktok/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const { userId, clientId } = JSON.parse(Buffer.from(state, 'base64').toString());
    const tokenRes = await axios.post('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
      app_id: process.env.TIKTOK_APP_ID,
      secret: process.env.TIKTOK_APP_SECRET,
      auth_code: code,
      grant_type: 'authorization_code',
    });
    const { access_token, refresh_token, expires_in, advertiser_ids } = tokenRes.data.data;
    await saveToken(clientId, 'tiktok', {
      access_token, refresh_token, expires_in,
      account_id: advertiser_ids?.[0]?.toString(),
      extra: { all_advertiser_ids: advertiser_ids }
    });
    res.redirect(`${process.env.FRONTEND_URL}?connected=tiktok&client=${clientId}`);
  } catch (err) {
    console.error('[TIKTOK] Callback error:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=tiktok_failed`);
  }
});

/* ════════════════════════════════════════
   AMAZON ADS — OAuth 2.0 (Login with Amazon)
   Scope: advertising::campaign_management
════════════════════════════════════════ */
router.get('/amazon/connect', requireAuth, (req, res) => {
  const { clientId } = req.query;
  const state = Buffer.from(JSON.stringify({ userId: req.user.userId, clientId })).toString('base64');
  const params = new URLSearchParams({
    client_id: process.env.AMAZON_CLIENT_ID,
    scope: 'advertising::campaign_management',
    response_type: 'code',
    redirect_uri: process.env.AMAZON_REDIRECT_URI,
    state,
  });
  res.redirect(`https://www.amazon.com/ap/oa?${params}`);
});

router.get('/amazon/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const { userId, clientId } = JSON.parse(Buffer.from(state, 'base64').toString());
    const tokenRes = await axios.post('https://api.amazon.com/auth/o2/token', new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.AMAZON_REDIRECT_URI,
      client_id: process.env.AMAZON_CLIENT_ID,
      client_secret: process.env.AMAZON_CLIENT_SECRET,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    /* Lista profili Amazon Ads */
    const region = process.env.AMAZON_REGION || 'EU';
    const apiBase = region === 'NA' ? 'https://advertising-api.amazon.com' : region === 'FE' ? 'https://advertising-api-fe.amazon.com' : 'https://advertising-api-eu.amazon.com';
    const profilesRes = await axios.get(`${apiBase}/v2/profiles`, {
      headers: { Authorization: `Bearer ${access_token}`, 'Amazon-Advertising-API-ClientId': process.env.AMAZON_CLIENT_ID }
    });
    const firstProfile = profilesRes.data?.[0];
    await saveToken(clientId, 'amazon', {
      access_token, refresh_token, expires_in,
      account_id: firstProfile?.profileId?.toString(),
      account_name: firstProfile?.accountInfo?.name,
      extra: { region, api_base: apiBase, marketplace_id: firstProfile?.accountInfo?.marketplaceStringId }
    });
    res.redirect(`${process.env.FRONTEND_URL}?connected=amazon&client=${clientId}`);
  } catch (err) {
    console.error('[AMAZON] Callback error:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=amazon_failed`);
  }
});

/* ── Disconnetti piattaforma ── */
router.delete('/disconnect', requireAuth, async (req, res) => {
  const { clientId, platform } = req.body;
  try {
    await query('DELETE FROM platform_tokens WHERE client_id = $1 AND platform = $2', [clientId, platform]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Errore disconnessione.' });
  }
});

/* ── Stato connessioni ── */
router.get('/status/:clientId', requireAuth, async (req, res) => {
  const { rows } = await query(
    'SELECT platform, account_name, connected_at, last_refreshed, token_expires_at FROM platform_tokens WHERE client_id = $1',
    [req.params.clientId]
  );
  const status = {};
  rows.forEach(r => {
    status[r.platform] = {
      connected: true,
      account_name: r.account_name,
      connected_at: r.connected_at,
      last_refreshed: r.last_refreshed,
      expires_at: r.token_expires_at,
    };
  });
  res.json(status);
});

module.exports = router;
