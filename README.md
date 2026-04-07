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

## Demo Accounts

- Admin: `admin@college.local` / `admin123`
- Student: `student@college.local` / `student123`

## Notes

- Local development stores data in `data/db.json`.
- On Vercel, the app now runs through `api/index.js` as a serverless function entrypoint.
- Vercel does not provide persistent writable local disk for app state, so the deployment falls back to in-memory seeded data unless you connect a real database.
- The browser camera scanner uses the `html5-qrcode` script loaded from a CDN.
- For real production use, replace the simple cookie/token setup and temporary Vercel memory fallback with a proper database and hardened auth flow.
