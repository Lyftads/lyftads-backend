require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const authRoutes = require('./routes/auth');
const metricsRoutes = require('./routes/metrics');
const clientsRoutes = require('./routes/clients');
const alertsRoutes = require('./routes/alerts');
const { runAllRefreshes } = require('./services/refreshService');
const { initDB } = require('./models/db');

const app = express();
const PORT = process.env.PORT || 3001;

/* ── Security ── */
app.use(helmet());
app.set('trust proxy', 1);
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));

/* ── Rate limiting ── */
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 100, skip: () => false }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 500, skip: () => false }));

/* ── Parsing ── */
app.use(express.json());
app.use(morgan('combined'));

/* ── Routes ── */
app.use('/auth', authRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/alerts', alertsRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

/* ── Auto-refresh ogni 15 minuti ── */
cron.schedule('*/15 * * * *', async () => {
  console.log('[CRON] Avvio refresh automatico piattaforme...');
  try {
    await runAllRefreshes();
    console.log('[CRON] Refresh completato.');
  } catch (err) {
    console.error('[CRON] Errore refresh:', err.message);
  }
});

/* ── Start ── */
async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`\n Lyft Ads Backend in ascolto su porta ${PORT}`);
    console.log(` Ambiente: ${process.env.NODE_ENV || 'development'}\n`);
  });
}

start();
