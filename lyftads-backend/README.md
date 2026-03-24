# Lyft Ads Dashboard — Backend

API backend per il dashboard di performance marketing di Lyft Ads.

## Stack
- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: PostgreSQL (Supabase / Railway / Render)
- **Auth**: JWT + bcrypt
- **Cron**: node-cron (refresh ogni 15 min)
- **Piattaforme**: Meta Ads, Google Ads, Shopify, Klaviyo, TikTok Ads, Amazon Ads

---

## Setup in 10 minuti (Render.com — gratis)

### 1. Database — Supabase (gratis)
1. Vai su https://supabase.com → New Project
2. Copia la `DATABASE_URL` da Settings > Database > Connection String (URI mode)

### 2. Backend — Render.com
1. Vai su https://render.com → New Web Service
2. Collega il tuo repo GitHub con questa cartella
3. Imposta:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Node version**: 18
4. Aggiungi le variabili d'ambiente (vedi sotto)

### 3. Frontend
Il frontend è una Single Page App HTML/JS.
- Hostala su Vercel (https://vercel.com) o Netlify (https://netlify.com)
- Punta `FRONTEND_URL` al tuo dominio

---

## Variabili d'ambiente obbligatorie

```
PORT=3001
NODE_ENV=production
FRONTEND_URL=https://dashboard.lyftads.agency
JWT_SECRET=<openssl rand -hex 64>
DATABASE_URL=postgresql://...
ENCRYPTION_KEY=<openssl rand -hex 32>
```

### Meta Ads
```
META_APP_ID=
META_APP_SECRET=
META_REDIRECT_URI=https://api.lyftads.agency/auth/meta/callback
```
➜ Crea app su https://developers.facebook.com
➜ Aggiungi prodotto "Marketing API"
➜ Permessi: `ads_read`, `ads_management`, `business_management`

### Google Ads
```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://api.lyftads.agency/auth/google/callback
GOOGLE_DEVELOPER_TOKEN=
```
➜ Crea credenziali OAuth su https://console.cloud.google.com
➜ Abilita "Google Ads API"
➜ Developer Token: richiedi su Google Ads > Tools > API Center

### Shopify
```
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_REDIRECT_URI=https://api.lyftads.agency/auth/shopify/callback
```
➜ Crea Partner App su https://partners.shopify.com
➜ Scope: `read_orders,read_analytics,read_reports`

### Klaviyo
```
(nessuna variabile richiesta — usa API Key del cliente)
```
➜ Il cliente incolla la sua Private API Key nel dashboard

### TikTok Ads
```
TIKTOK_APP_ID=
TIKTOK_APP_SECRET=
TIKTOK_REDIRECT_URI=https://api.lyftads.agency/auth/tiktok/callback
```
➜ Crea app su https://ads.tiktok.com/marketing_api/apps/
➜ Scope: `ad.read`, `report.read`

### Amazon Ads
```
AMAZON_CLIENT_ID=
AMAZON_CLIENT_SECRET=
AMAZON_REDIRECT_URI=https://api.lyftads.agency/auth/amazon/callback
AMAZON_REGION=EU
```
➜ Registra su https://advertising.amazon.com/API/docs
➜ Regioni: NA (USA/CA), EU (Europa), FE (Far East)

---

## Architettura

```
Frontend (HTML/JS)
       │
       │  HTTPS + JWT
       ▼
   Express API  :3001
       │
   ┌───┼───────────────────┐
   │   │                   │
  Auth  Metrics           Cron
  JWT   Cache             15min
   │     │                 │
   └─────┴─────────────────┘
              │
         PostgreSQL
              │
   ┌──────────┼──────────────────┐
   │  Meta    │  Google  Shopify │
   │  Klaviyo │  TikTok  Amazon  │
   └──────────┴──────────────────┘
```

## Endpoints principali

| Method | Path | Descrizione |
|--------|------|-------------|
| POST | /auth/login | Login agenzia |
| POST | /auth/register | Registrazione |
| GET | /auth/meta/connect?clientId= | Avvia OAuth Meta |
| GET | /auth/google/connect?clientId= | Avvia OAuth Google |
| GET | /auth/shopify/connect?clientId=&shop= | Avvia OAuth Shopify |
| POST | /auth/klaviyo/connect | Salva API Key Klaviyo |
| GET | /auth/tiktok/connect?clientId= | Avvia OAuth TikTok |
| GET | /auth/amazon/connect?clientId= | Avvia OAuth Amazon |
| GET | /api/clients | Lista clienti |
| POST | /api/clients | Crea cliente |
| GET | /api/metrics/:clientId?from=&to= | Metriche per range date |
| POST | /api/metrics/:clientId/refresh | Forza refresh |
| GET | /api/alerts | Alert attivi |
| GET | /health | Health check |

## Token refresh automatico
Il backend refresha automaticamente tutti i token ogni 15 minuti tramite node-cron.
- Meta: rinnova il long-lived token (60 giorni)
- Google: usa refresh_token per nuovo access_token
- TikTok: usa refresh_token
- Amazon: usa refresh_token
- Shopify: token permanente (nessun refresh necessario)
- Klaviyo: API key permanente (nessun refresh necessario)

I token sono cifrati nel DB con AES-256-CBC.
