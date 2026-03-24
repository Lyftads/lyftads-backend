const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

/* ── Token encryption ── */
const ENC_KEY = Buffer.from(process.env.ENCRYPTION_KEY || '0'.repeat(64), 'hex');

function encryptToken(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptToken(text) {
  const [ivHex, encHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENC_KEY, iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

/* ── DB init ── */
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS agency_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS clients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agency_user_id UUID REFERENCES agency_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        industry TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS platform_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        token_expires_at TIMESTAMPTZ,
        account_id TEXT,
        account_name TEXT,
        extra_data JSONB DEFAULT '{}',
        connected_at TIMESTAMPTZ DEFAULT NOW(),
        last_refreshed TIMESTAMPTZ,
        UNIQUE(client_id, platform)
      );

      CREATE TABLE IF NOT EXISTS metrics_cache (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        date DATE NOT NULL,
        data JSONB NOT NULL,
        fetched_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(client_id, platform, date)
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        metric TEXT NOT NULL,
        drop_pct NUMERIC NOT NULL,
        triggered_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        is_active BOOLEAN DEFAULT TRUE
      );
    `);
    console.log('[DB] Schema inizializzato.');
  } finally {
    client.release();
  }
}

const query = (text, params) => pool.query(text, params);

module.exports = { pool, query, encryptToken, decryptToken, initDB };
