-- Параллельные активности: человек не может быть записан на две, идущие в одно время.
-- Вместо отказа приложение предлагает перезаписаться (switch_activity).

-- Новая сигнатура с p_ignore; старую трёхаргументную удаляем, иначе вызов станет неоднозначным.
DROP FUNCTION IF EXISTS register_activity(bigint, bigint, bigint);
--> statement-breakpoint

-- Результат: registered | waitlist | already_registered | already_waitlist | full | closed
--            | age_restricted | time_conflict | not_found
CREATE OR REPLACE FUNCTION register_activity(p_act bigint, p_pid bigint, p_by bigint, p_ignore bigint DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  a activities;
  cur text;
  taken int;
  st text;
  v_birth date;
  v_age int;
BEGIN
  SELECT * INTO a FROM activities WHERE id = p_act FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  SELECT birth_date INTO v_birth FROM participants WHERE id = p_pid AND status = 'active';
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF a.status <> 'published' OR a.registration_mode <> 'required' OR now() >= a.starts_at
     OR (a.registration_opens_at IS NOT NULL AND now() < a.registration_opens_at)
     OR (a.registration_closes_at IS NOT NULL AND now() >= a.registration_closes_at) THEN
    RETURN 'closed';
  END IF;

  IF a.min_age IS NOT NULL OR a.max_age IS NOT NULL THEN
    v_age := date_part('year', age(a.starts_at::date, v_birth));
    IF (a.min_age IS NOT NULL AND v_age < a.min_age) OR (a.max_age IS NOT NULL AND v_age > a.max_age) THEN
      RETURN 'age_restricted';
    END IF;
  END IF;

  SELECT status INTO cur FROM activity_registrations WHERE activity_id = p_act AND participant_id = p_pid;
  IF cur IN ('registered', 'waitlist') THEN
    RETURN 'already_' || cur;
  END IF;

  -- Уже записан на другую опубликованную активность, пересекающуюся по времени?
  IF EXISTS (
    SELECT 1
      FROM activity_registrations ar
      JOIN activities o ON o.id = ar.activity_id
     WHERE ar.participant_id = p_pid
       AND ar.status IN ('registered', 'waitlist')
       AND ar.activity_id <> p_act
       AND (p_ignore IS NULL OR ar.activity_id <> p_ignore)
       AND o.status = 'published'
       AND o.starts_at < a.ends_at
       AND a.starts_at < o.ends_at
  ) THEN
    RETURN 'time_conflict';
  END IF;

  SELECT count(*) INTO taken FROM activity_registrations WHERE activity_id = p_act AND status = 'registered';
  st := CASE
          WHEN a.capacity IS NULL OR taken < a.capacity THEN 'registered'
          WHEN a.waitlist_enabled THEN 'waitlist'
        END;
  IF st IS NULL THEN
    RETURN 'full';
  END IF;

  INSERT INTO activity_registrations AS r (activity_id, participant_id, status, registered_by)
  VALUES (p_act, p_pid, st, p_by)
  ON CONFLICT (activity_id, participant_id) DO UPDATE
     SET status = EXCLUDED.status,
         queued_at = clock_timestamp(),
         updated_at = now(),
         registered_by = EXCLUDED.registered_by
   WHERE r.status = 'cancelled';
  RETURN st;
END $$;
--> statement-breakpoint

-- Перезапись с p_from на p_to. Переходим только на реальное место: если в p_to мест нет,
-- ничего не меняем (иначе человек потерял бы место в p_from ради листа ожидания).
-- Обе активности блокируются в порядке id - две встречные перезаписи не взаимоблокируются.
CREATE OR REPLACE FUNCTION switch_activity(p_from bigint, p_to bigint, p_pid bigint, p_by bigint)
RETURNS TABLE (outcome text, promoted bigint[])
LANGUAGE plpgsql AS $$
DECLARE
  t activities;
  taken int;
  r text;
  prom bigint[] := '{}';
BEGIN
  PERFORM 1 FROM activities WHERE id IN (p_from, p_to) ORDER BY id FOR UPDATE;

  SELECT * INTO t FROM activities WHERE id = p_to;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, prom;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM activity_registrations
     WHERE activity_id = p_from AND participant_id = p_pid AND status IN ('registered', 'waitlist')
  ) THEN
    -- Со старой уже не записан - обычная запись.
    RETURN QUERY SELECT register_activity(p_to, p_pid, p_by), prom;
    RETURN;
  END IF;

  IF t.capacity IS NOT NULL THEN
    SELECT count(*) INTO taken FROM activity_registrations WHERE activity_id = p_to AND status = 'registered';
    IF taken >= t.capacity THEN
      RETURN QUERY SELECT 'full'::text, prom;
      RETURN;
    END IF;
  END IF;

  r := register_activity(p_to, p_pid, p_by, p_from);
  IF r = 'registered' THEN
    SELECT c.promoted INTO prom FROM cancel_activity_registration(p_from, p_pid) AS c;
  END IF;
  RETURN QUERY SELECT r, coalesce(prom, '{}');
END $$;
