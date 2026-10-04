# prepare-ai-action

Authenticated Phase 2 worker that prepares drafts/classification/recommended next steps for `ai_actions`. It never sends email or executes CRM actions. Requires server-side `OPENAI_API_KEY` in Supabase Edge Function secrets.
