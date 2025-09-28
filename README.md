# Hockey Match Voting — Railway

Single-service Node/Express + MongoDB + static React SPA (same origin).

## Local
cp .env.example .env   # set MONGO_URI
npm install
npm run dev
# http://localhost:8080

## Deploy (Railway)
- Push to GitHub, then New Project → Deploy from GitHub
- Add env var: MONGO_URI
- Done. Frontend `/`, API `/api/*`.
