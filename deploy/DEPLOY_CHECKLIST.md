# Deploy checklist

## Pre-deploy
- PostgreSQL database provisioned
- DATABASE_URL set
- JWT_SECRET and REFRESH_TOKEN_SECRET set to strong random values
- CORS_ORIGIN points to your final domain
- SITE_URL points to your final domain
- TRUST_PROXY=true behind Render/Railway/reverse proxy
- Stripe keys and STRIPE_WEBHOOK_SECRET configured if using live payments
- Cloudinary credentials configured if using cloud storage

## Smoke test after deploy
1. GET /api/health
2. GET /api/ready
3. Register/login
4. Provider listing and search
5. Booking create
6. Admin login
7. Upload image
8. Stripe webhook test (if enabled)

## Recommended managed services
- App hosting: Render or Railway
- Postgres: Neon, Supabase, Railway Postgres, or Render Postgres
- Media: Cloudinary
- Payments: Stripe
