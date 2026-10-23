# Aegis Legal Document Analyzer

AI-assisted contract analysis (TanStack Start + Vite + PGLite, LLM via OpenRouter).

## Setup
```bash
npm install
cp .env.example .env      # then put your OpenRouter key in .env
npm run dev               # http://localhost:8080
```

## Troubleshooting: "OPENROUTER_API_KEY is not set"
- The key must be named exactly `OPENROUTER_API_KEY` in `.env` at the project root (no `VITE_` prefix).
- Restart the dev server after editing `.env`; it is only read at startup.
- Deployed (Vercel etc.): `.env` is not uploaded. Add the variable in the host's
  Environment Variables settings and redeploy.

## Scripts
`npm run dev` · `npm run build` · `npm run typecheck` · `npm test` · `npm run db:migrate`
