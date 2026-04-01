# Čisto – frontend polish + deploy pack

Ova verzija dodatno doteruje aplikaciju na završnom nivou bez rušenja postojećeg backend-a.

## Šta je novo

- frontend session handling sa refresh token podrškom
- automatski retry API poziva posle `401` odgovora
- urednija odjava i čišćenje sesije
- loading skeleton UI za:
  - providers
  - bookings
  - messages
- paginacija u UI-u za providers i bookings
- debounce pretraga za providers i bookings
- bolji filteri i reset filtera
- responsive dorade za manji ekran
- sređen `.env.example` u root i backend folderu

## Obavezni backend `.env`

Kopiraj `backend/.env.example` u `backend/.env` i podesi bar ovo:

```env
PORT=3001
NODE_ENV=development
APP_NAME=Čisto
JWT_SECRET=cisto_super_jak_jwt_2026_abc_987
DATA_MODE=postgres
DATABASE_URL=postgresql://postgres:LOZINKA@localhost:5432/cisto
DATABASE_SSL=false
PAYMENT_MODE=simulation
STORAGE_MODE=local
REFRESH_TOKEN_SECRET=cisto_super_jak_jwt_2026_abc_987_refresh
REFRESH_TOKEN_TTL_DAYS=30
ACCESS_TOKEN_TTL=30d
CORS_ORIGIN=*
SITE_URL=http://localhost:3001
```

## Ako želiš pravi Stripe

```env
PAYMENT_MODE=stripe
STRIPE_PUBLIC_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CURRENCY=rsd
```

## Ako želiš pravi Cloudinary

```env
STORAGE_MODE=cloudinary
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_UPLOAD_PRESET=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
CLOUDINARY_FOLDER=cisto/providers
```

## Pokretanje

```bash
cd backend
npm install
npm run dev
```

Otvaranje aplikacije:
- `http://localhost:3001`

## Kratak test plan

1. `GET /api/health`
   - očekuj `dataMode: "postgres"`
   - očekuj `schemaMode: "postgres-normalized"`

2. prijava kao klijent
   - `milan@test.com / lozinka123`

3. otvori providers
   - testiraj search, verified, sort, paginaciju

4. napravi booking
   - proveri da ulazi u bookings listu

5. otvori messages
   - proveri da se učitavaju poruke i da scroll ostaje dole

6. prijava kao provider
   - `marija@test.com / lozinka123`
   - proveri bookings i profile update

7. prijava kao admin
   - `admin@test.com / admin123`
   - proveri overview, settings, audit logs, export

## Plan za dalje

1. frontend final polish
   - loading/error states na svim view-ovima
   - optimistic updates gde imaju smisla
   - pagination i search i na admin tabelama

2. auth završni sloj
   - password reset
   - email verification
   - failed-login audit

3. deploy finish
   - konkretan Render/Railway/Neon setup
   - production env
   - domen i HTTPS

4. observability
   - Sentry ili sličan error monitoring
   - SQL slow query logging
   - backup/restore rutina

5. mobile/API reuse
   - odvojeni frontend build ili mobilna aplikacija preko istog backend-a


## Production deploy vodič

U projektu sada postoje i deploy fajlovi:
- `render.yaml`
- `railway.json`
- `nixpacks.toml`
- `backend/Procfile`
- `deploy/env.production.example`
- `deploy/DEPLOY_CHECKLIST.md`

### Preporučen stack za produkciju

- backend hosting: Render ili Railway
- PostgreSQL: Neon / Railway Postgres / Supabase / Render Postgres
- storage: Cloudinary
- payments: Stripe

### Minimalni production env

Najlakše je da kreneš od `deploy/env.production.example` i popuniš:
- `DATABASE_URL`
- `JWT_SECRET`
- `REFRESH_TOKEN_SECRET`
- `CORS_ORIGIN`
- `SITE_URL`

Za hostovanje iza proxy-ja obavezno:
- `TRUST_PROXY=true`

### Render

1. poveži repo
2. Render će pročitati `render.yaml`
3. dopuni secrets/env vrednosti u Render dashboard-u
4. health check koristi:
   - `/api/ready`

### Railway

1. poveži repo
2. Railway može da koristi `railway.json` / `nixpacks.toml`
3. podesi env promenljive iz `deploy/env.production.example`
4. proveri da public domain ide u:
   - `SITE_URL`
   - `CORS_ORIGIN`

### Posle deploy-a

Uradi smoke test:
- `GET /api/health`
- `GET /api/ready`
- login
- providers
- booking
- chat
- admin
- upload slike
- Stripe webhook test ako je uključen

## Sledeći najvažniji koraci

1. password reset + email verification
2. standardizovan response format na svim rutama
3. spor SQL logging i error monitoring
4. konkretan deploy na jednu platformu sa tvojim domenom
