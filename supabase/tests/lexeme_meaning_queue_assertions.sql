CREATE TRIGGER test_sync_word_meaning AFTER INSERT OR UPDATE OF definition_cn, lexeme_id ON public.words
FOR EACH ROW EXECUTE FUNCTION public.sync_word_meaning_after_write();
CREATE TRIGGER test_sync_missing AFTER INSERT OR UPDATE OF definition_cn, lexeme_id ON public.words
FOR EACH ROW EXECUTE FUNCTION public.sync_missing_lexeme_backfill_job();

DO $$
DECLARE count_claimed integer; count_found integer;
BEGIN
  IF public.is_valid_chinese_meaning('sabertooth') OR public.is_valid_chinese_meaning('暂无中文释义')
    OR public.is_valid_chinese_meaning(NULL) OR NOT public.is_valid_chinese_meaning('剑齿虎')
    OR NOT public.is_valid_chinese_meaning('𠀀') OR NOT public.is_valid_chinese_meaning('々') THEN
    RAISE EXCEPTION 'Chinese validation disagrees with expected cases';
  END IF;
  IF (SELECT status FROM public.lexeme_meaning_backfill_jobs WHERE normalized_text = 'sabertooth') <> 'pending'
    OR (SELECT attempts FROM public.lexeme_meaning_backfill_jobs WHERE normalized_text = 'sabertooth') <> 0
    OR (SELECT status FROM public.lexeme_meaning_backfill_jobs WHERE normalized_text = 'bank') <> 'done' THEN
    RAISE EXCEPTION 'Failed jobs not requeued safely';
  END IF;
  IF NOT EXISTS (SELECT FROM public.lexeme_meanings WHERE meaning_zh = 'sabertooth')
    OR NOT EXISTS (SELECT FROM public.user_word_meaning_preferences WHERE word_id = '10000000-0000-0000-0000-000000000002' AND is_primary)
    OR (SELECT definition_cn FROM public.words WHERE id = '10000000-0000-0000-0000-000000000002') <> 'sabertooth' THEN
    RAISE EXCEPTION 'Historical meaning was removed';
  END IF;
  PERFORM public.enqueue_missing_lexeme_backfills(20, false);
  IF (SELECT status FROM public.lexeme_meaning_backfill_jobs WHERE normalized_text = 'scanword') <> 'pending' THEN
    RAISE EXCEPTION 'Scan skipped a word with only placeholder meanings';
  END IF;
  UPDATE public.lexeme_meaning_backfill_jobs SET status = 'processing', last_processed_at = now() - interval '10 minutes'
    WHERE normalized_text IN ('sabertooth', 'bank');
  PERFORM public.requeue_stale_lexeme_meaning_backfill_jobs(300);
  IF (SELECT status FROM public.lexeme_meaning_backfill_jobs WHERE normalized_text = 'sabertooth') <> 'pending'
    OR (SELECT status FROM public.lexeme_meaning_backfill_jobs WHERE normalized_text = 'bank') <> 'done' THEN
    RAISE EXCEPTION 'Stale job recovery failed to distinguish valid and invalid meanings';
  END IF;
  UPDATE public.lexeme_meaning_backfill_jobs SET priority = 1 WHERE normalized_text = 'sabertooth';
  SELECT count(*) INTO count_claimed FROM public.claim_lexeme_meaning_backfill_jobs(1)
    WHERE normalized_text = 'sabertooth';
  IF count_claimed <> 1 THEN RAISE EXCEPTION 'Failed option blocked claim'; END IF;
  UPDATE public.lexeme_meaning_backfill_jobs SET status = 'cancelled' WHERE normalized_text IN ('newword', 'scanword');
  PERFORM public.enqueue_lexeme_meaning_backfill('00000000-0000-0000-0000-000000000002', 5::smallint, true);
  SELECT count(*) INTO count_claimed FROM public.claim_lexeme_meaning_backfill_jobs(1)
    WHERE normalized_text = 'bank';
  IF count_claimed <> 0 THEN RAISE EXCEPTION 'Valid Chinese should block claim'; END IF;

  INSERT INTO public.words VALUES ('10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 'newword');
  SELECT count(*) INTO count_found FROM public.lexeme_meanings WHERE lexeme_id = '00000000-0000-0000-0000-000000000003';
  IF count_found <> 0 THEN RAISE EXCEPTION 'Trigger saved English as Chinese'; END IF;
  IF (SELECT status FROM public.lexeme_meaning_backfill_jobs WHERE normalized_text = 'newword') <> 'pending' THEN
    RAISE EXCEPTION 'Invalid definition did not enqueue missing word';
  END IF;
  UPDATE public.words SET definition_cn = '新词' WHERE id = '10000000-0000-0000-0000-000000000001';
  IF NOT EXISTS (SELECT FROM public.lexeme_meanings WHERE meaning_zh = '新词')
    OR (SELECT status FROM public.lexeme_meaning_backfill_jobs WHERE normalized_text = 'newword') <> 'done' THEN
    RAISE EXCEPTION 'Trigger did not retain valid user meaning';
  END IF;
END;
$$;
