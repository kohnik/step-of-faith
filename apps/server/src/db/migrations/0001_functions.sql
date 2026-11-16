-- Инварианты, которые не должен обойти ни один путь записи (API, админка, скрипт).
-- Все функции рассчитаны на READ COMMITTED (уровень по умолчанию).

-- Отметка на точке. Идемпотентна по client_event_id, не допускает двух активных
-- отметок одного человека на одной точке, даже если сканируют одновременно.
-- outcome: new | retry | event_id_reused | duplicate
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
BEGIN
  FOR attempt IN 1..3 LOOP
    -- Без conflict target: срабатывает и на client_event_id, и на check_ins_once.
    INSERT INTO check_ins (client_event_id, checkpoint_id, participant_id, scanned_by, device_id, client_ts, method, offline)
    VALUES (p_ev, p_cp, p_pid, p_staff, p_dev, p_cts, p_method, p_offline)
    ON CONFLICT DO NOTHING
    RETURNING * INTO r;

    IF FOUND THEN
      SELECT kind INTO cp_kind FROM checkpoints WHERE id = p_cp;
      IF cp_kind = 'entrance' THEN
        UPDATE participants SET arrived_at = COALESCE(arrived_at, r.created_at), updated_at = now()
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

-- Мягкая отмена отметки. Пересчитывает arrived_at, если это вход.
CREATE OR REPLACE FUNCTION revoke_check_in(p_id bigint, p_staff bigint)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  r check_ins;
  cp_kind text;
BEGIN
  UPDATE check_ins SET revoked_at = now(), revoked_by = p_staff
   WHERE id = p_id AND revoked_at IS NULL
  RETURNING * INTO r;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT kind INTO cp_kind FROM checkpoints WHERE id = r.checkpoint_id;
  IF cp_kind = 'entrance' THEN
    UPDATE participants p SET
      arrived_at = (
        SELECT min(ci.created_at)
          FROM check_ins ci JOIN checkpoints c ON c.id = ci.checkpoint_id
         WHERE ci.participant_id = p.id AND ci.revoked_at IS NULL AND c.kind = 'entrance'
      ),
      updated_at = now()
     WHERE p.id = r.participant_id;
  END IF;
  RETURN true;
END $$;
--> statement-breakpoint

-- Запись на активность. Блокировка строки активности выстраивает в очередь все записи,
-- отмены и продвижения по ней, а живой count(*) не даёт переполнить лимит.
-- Результат: registered | waitlist | already_registered | already_waitlist | full | closed | age_restricted | not_found
CREATE OR REPLACE FUNCTION register_activity(p_act bigint, p_pid bigint, p_by bigint)
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

-- Продвигает первых из листа ожидания на освободившиеся места. Вызывать после отмены
-- и после увеличения лимита. Возвращает id продвинутых участников.
CREATE OR REPLACE FUNCTION promote_waitlist(p_act bigint)
RETURNS SETOF bigint
LANGUAGE plpgsql AS $$
DECLARE
  a activities;
  free int;
BEGIN
  SELECT * INTO a FROM activities WHERE id = p_act FOR UPDATE;
  IF NOT FOUND OR a.status <> 'published' OR now() >= a.starts_at THEN
    RETURN;
  END IF;

  IF a.capacity IS NULL THEN
    free := 2147483647;
  ELSE
    SELECT a.capacity - count(*) INTO free
      FROM activity_registrations WHERE activity_id = p_act AND status = 'registered';
  END IF;
  IF free <= 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
    WITH picked AS (
      SELECT ar.id FROM activity_registrations ar
       WHERE ar.activity_id = p_act AND ar.status = 'waitlist'
       ORDER BY ar.queued_at, ar.id
       LIMIT free
    ), promoted AS (
      UPDATE activity_registrations ar SET status = 'registered', updated_at = now()
        FROM picked
       WHERE ar.id = picked.id
      RETURNING ar.participant_id
    )
    SELECT promoted.participant_id FROM promoted;
END $$;
--> statement-breakpoint

-- Отмена записи (и из листа ожидания) под той же блокировкой + продвижение очереди.
CREATE OR REPLACE FUNCTION cancel_activity_registration(p_act bigint, p_pid bigint)
RETURNS TABLE (was_cancelled boolean, promoted bigint[])
LANGUAGE plpgsql AS $$
DECLARE
  n int;
  prom bigint[];
BEGIN
  PERFORM 1 FROM activities WHERE id = p_act FOR UPDATE;
  UPDATE activity_registrations SET status = 'cancelled', updated_at = now()
   WHERE activity_id = p_act AND participant_id = p_pid AND status IN ('registered', 'waitlist');
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT coalesce(array_agg(x.pid), '{}') INTO prom FROM promote_waitlist(p_act) AS x(pid);
  RETURN QUERY SELECT n > 0, prom;
END $$;
