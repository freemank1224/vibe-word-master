-- Additive rollout: old clients ignore this column; old words initialize lazily.
-- Existing words ownership/RLS policies remain in force. No privileged function.
alter table public.words add column if not exists review_state jsonb;
comment on column public.words.review_state is
  'Versioned client review schedule: dueAt/lastReviewedAt in epoch milliseconds. Heuristic model, not a calibrated recall probability.';
