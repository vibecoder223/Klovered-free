# Klovered Free — pipeline backend (FastAPI)

Python backend for the free tool's document/RAG/export pipeline. The Next.js app
stays the frontend and proxies `/api/pipeline/*` here (see `next.config.mjs`).

## Local dev

```bash
cd backend
python -m venv .venv && . .venv/Scripts/activate   # macOS/Linux: . .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env.local   # fill in the same Supabase project as the web app
pytest -v
```

Run both processes from the repo root: `npm run dev:all`
(web on :3100, api on :8000; browser calls `/api/pipeline/*` and Next proxies it).
