ALTER TABLE inference_records
  ADD COLUMN IF NOT EXISTS diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE generation_records
  ADD COLUMN IF NOT EXISTS diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb;
