CREATE TABLE "once_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "once_keys_created_idx" ON "once_keys" USING btree ("created_at");--> statement-breakpoint
-- Офлайн-отметка получает время сканирования, а не время синхронизации, если часы устройства
-- правдоподобны: не старше 12 часов и не из будущего (2 минуты запаса на расхождение часов).
-- Время прихода - самое раннее из отметок на входе.
CREATE OR REPLACE FUNCTION check_in(
  p_ev uuid,
  p_cp int,
  p_pid bigint,
  p_staff bigint,
  p_dev text,
  p_cts timestamptz,
  p_method text,
  p_offline boolean
) RETURNS TABLE (outcome text, check_in_id bigint, checked_at timestamptz, by_staff bigint, revoked boolean)
LANGUAGE plpgsql AS $$
DECLARE
  r check_ins;
  cp_kind text;
  at_ts timestamptz := CASE
    WHEN p_offline AND p_cts IS NOT NULL AND p_cts > now() - interval '12 hours' AND p_cts <= now() + interval '2 minutes'
      THEN least(p_cts, now())
    ELSE now()
  END;
BEGIN
  FOR attempt IN 1..3 LOOP
    -- Без conflict target: срабатывает и на client_event_id, и на check_ins_once.
    INSERT INTO check_ins (client_event_id, checkpoint_id, participant_id, scanned_by, device_id, client_ts, method, offline, created_at)
    VALUES (p_ev, p_cp, p_pid, p_staff, p_dev, p_cts, p_method, p_offline, at_ts)
    ON CONFLICT DO NOTHING
    RETURNING * INTO r;

    IF FOUND THEN
      SELECT kind INTO cp_kind FROM checkpoints WHERE id = p_cp;
      IF cp_kind = 'entrance' THEN
        UPDATE participants SET arrived_at = LEAST(COALESCE(arrived_at, r.created_at), r.created_at), updated_at = now()
         WHERE id = p_pid;
      END IF;
      RETURN QUERY SELECT 'new'::text, r.id, r.created_at, r.scanned_by, false;
      RETURN;
    END IF;

    -- Каждый SELECT - новый снимок: видит строку, которую конкурент закоммитил, пока мы ждали.
    SELECT * INTO r FROM check_ins WHERE client_event_id = p_ev;
    IF FOUND THEN
      RETURN QUERY SELECT
        CASE WHEN r.checkpoint_id = p_cp AND r.participant_id = p_pid THEN 'retry' ELSE 'event_id_reused' END,
        r.id, r.created_at, r.scanned_by, r.revoked_at IS NOT NULL;
      RETURN;
    END IF;

    SELECT * INTO r FROM check_ins
     WHERE checkpoint_id = p_cp AND participant_id = p_pid AND revoked_at IS NULL;
    IF FOUND THEN
      RETURN QUERY SELECT 'duplicate'::text, r.id, r.created_at, r.scanned_by, false;
      RETURN;
    END IF;
    -- Отметку-«победителя» успели отменить между INSERT и SELECT - пробуем ещё раз.
  END LOOP;
  RAISE EXCEPTION 'check_in %: unresolved conflict', p_ev;
END $$;
--> statement-breakpoint

-- Запись на активность: блокировка участника против гонки двух записей на пересекающиеся активности.
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

  -- Блокируем человека (после активности - тот же порядок, что у switch_activity): две параллельные записи
  -- одного человека на пересекающиеся активности иначе обе проходили проверку пересечений.
  SELECT birth_date INTO v_birth FROM participants WHERE id = p_pid AND status = 'active' FOR NO KEY UPDATE;
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
       -- Скрытую тему тоже считаем: иначе, пока она скрыта, можно взять вторую тему того же блока,
       -- а после возврата человек оказался бы в двух сразу. Перейти можно кнопкой «Перейти» (switch_activity).
       AND o.status <> 'cancelled'
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
