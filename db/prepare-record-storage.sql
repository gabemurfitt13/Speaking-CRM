-- Deployment prerequisite. Apply only after checking the target project's
-- progress table and existing owner-based RLS policies. No live DDL was run.
-- Existing columns remain for compatibility; record preserves the full school.
ALTER TABLE public.progress ADD COLUMN IF NOT EXISTS record jsonb;
