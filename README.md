# College Event Manager

A lightweight college event management app with:

- Student login and self-registration
- Admin login and event creation panel
- Event descriptions, scheduling, and capacity tracking
- Event registration with generated QR pass
- Admin attendance marking using QR scanning

## Run

1. Install dependencies:

```bash
npm install
```

2. Start the app:

```bash
npm start
```

3. Open `http://localhost:3000`

## Database Setup For Vercel

1. Create a Postgres database.
   Vercel Postgres, Neon, Supabase, or any standard PostgreSQL host will work.
2. Add `DATABASE_URL` in your Vercel project environment variables.
3. Redeploy.

On first boot, the app will automatically:

- create the `users`, `events`, and `registrations` tables
- seed demo admin/student accounts
- seed one sample event if the database is empty

## Demo Accounts

- Admin: `admin@college.local` / `admin123`
- Student: `student@college.local` / `student123`

## Notes

- Local development stores data in `data/db.json`.
- On Vercel, the app now runs through `api/index.js` as a serverless function entrypoint.
- Persistent production storage on Vercel requires `DATABASE_URL`.
- If `DATABASE_URL` is missing on Vercel, requests will fail with a clear storage configuration error instead of silently pretending data is durable.
- The browser camera scanner uses the `html5-qrcode` script loaded from a CDN.
- The current app auto-initializes its database schema, but the auth/session flow is still intentionally lightweight and should be hardened before serious production use.
