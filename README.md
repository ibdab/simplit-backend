# Simplit Backend

Small Vercel backend for Simplit.

## Endpoints

- `GET /api/health`
- `POST /api/process-text`

## Environment Variables

Add these in Vercel Project Settings:

```text
SUPABASE_URL=https://wenezehwhokhzqpnkznm.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_rMZSdPy_yy7vhcyuOnHseA_jNPYNb9t
GEMINI_API_KEY=your_gemini_key
CLAUDE_API_KEY=your_claude_key
FREE_MODEL=gemini-2.5-flash-lite
PRO_MODEL=claude-3-5-haiku-latest
```

## Test Request

```bash
curl -X POST https://YOUR-VERCEL-DOMAIN/api/process-text \
  -H "Content-Type: application/json" \
  -d '{"text":"What is photosynthesis?","action":"answer_question","plan":"free"}'
```
