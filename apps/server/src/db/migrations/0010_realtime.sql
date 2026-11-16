-- Живые обновления Mini App: любое изменение в базе (из API, из бота, массовой правкой) шлёт подсказку
-- «что устарело» в канал sof_events. API слушает канал и пересылает подсказки открытым приложениям,
-- а те сами перезапрашивают данные. pg_notify в транзакции уходит только после коммита; одинаковые
-- уведомления одной транзакции Postgres склеивает.

-- {"k": вид, "u": [кому]}; без "u" - всем. Слишком длинный список получателей - тоже всем.
CREATE OR REPLACE FUNCTION sof_notify(p_kind text, p_users bigint[] DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  u bigint[];
  payload text;
BEGIN
  IF p_users IS NOT NULL THEN
    SELECT array_agg(DISTINCT x ORDER BY x) INTO u FROM unnest(p_users) AS x WHERE x IS NOT NULL;
    IF u IS NULL THEN
      RETURN;
    END IF;
  END IF;
  payload := json_strip_nulls(json_build_object('k', p_kind, 'u', u))::text;
  IF length(payload) > 7900 THEN
    payload := json_build_object('k', p_kind)::text;
  END IF;
  PERFORM pg_notify('sof_events', payload);
END $$;
--> statement-breakpoint

-- Широковещательные подсказки на уровне оператора: массовая правка - одно уведомление, а не по строке.
CREATE OR REPLACE FUNCTION sof_broadcast_trg()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  kind text;
BEGIN
  FOREACH kind IN ARRAY TG_ARGV LOOP
    PERFORM sof_notify(kind);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- Участник: оплата, статус, вариант, приход, кому принадлежит - владельцу и держателю (старым и новым).
CREATE OR REPLACE FUNCTION sof_participants_trg()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM sof_notify('me', ARRAY[NEW.owner_user_id, NEW.holder_user_id]);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM sof_notify('me', ARRAY[OLD.owner_user_id, OLD.holder_user_id]);
  ELSIF (NEW.payment_status, NEW.amount_paid, NEW.amount_due, NEW.status, NEW.tier, NEW.payment_method, NEW.arrived_at,
         NEW.owner_user_id, NEW.holder_user_id, NEW.last_name, NEW.first_name, NEW.middle_name, NEW.category)
        IS DISTINCT FROM
        (OLD.payment_status, OLD.amount_paid, OLD.amount_due, OLD.status, OLD.tier, OLD.payment_method, OLD.arrived_at,
         OLD.owner_user_id, OLD.holder_user_id, OLD.last_name, OLD.first_name, OLD.middle_name, OLD.category) THEN
    PERFORM sof_notify('me', ARRAY[NEW.owner_user_id, NEW.holder_user_id, OLD.owner_user_id, OLD.holder_user_id]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- Билет (перевыпуск) и отметка на входе («на месте с …» на 2-й и 3-й день) - владельцу и держателю участника.
CREATE OR REPLACE FUNCTION sof_participant_child_trg()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pid bigint;
  users bigint[];
BEGIN
  pid := CASE WHEN TG_OP = 'DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
  SELECT ARRAY[owner_user_id, holder_user_id] INTO users FROM participants WHERE id = pid;
  IF users IS NOT NULL THEN
    PERFORM sof_notify('me', users);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- Ответ на вопрос - автору.
CREATE OR REPLACE FUNCTION sof_questions_trg()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM sof_notify('questions', ARRAY[NEW.user_id]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

CREATE TRIGGER sof_participants_notify AFTER INSERT OR UPDATE OR DELETE ON participants
  FOR EACH ROW EXECUTE FUNCTION sof_participants_trg();
--> statement-breakpoint
CREATE TRIGGER sof_tickets_notify AFTER INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION sof_participant_child_trg();
--> statement-breakpoint
CREATE TRIGGER sof_check_ins_notify AFTER INSERT OR UPDATE ON check_ins
  FOR EACH ROW EXECUTE FUNCTION sof_participant_child_trg();
--> statement-breakpoint
CREATE TRIGGER sof_questions_notify AFTER UPDATE ON questions
  FOR EACH ROW EXECUTE FUNCTION sof_questions_trg();
--> statement-breakpoint
CREATE TRIGGER sof_activity_registrations_notify AFTER INSERT OR UPDATE OR DELETE ON activity_registrations
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('schedule', 'seminars');
--> statement-breakpoint
CREATE TRIGGER sof_activity_interest_notify AFTER INSERT OR UPDATE OR DELETE ON activity_interest
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('schedule');
--> statement-breakpoint
CREATE TRIGGER sof_activities_notify AFTER INSERT OR UPDATE OR DELETE ON activities
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('schedule', 'seminars');
--> statement-breakpoint
CREATE TRIGGER sof_seminar_blocks_notify AFTER INSERT OR UPDATE OR DELETE ON seminar_blocks
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('seminars', 'schedule');
--> statement-breakpoint
CREATE TRIGGER sof_seminar_block_rooms_notify AFTER INSERT OR UPDATE OR DELETE ON seminar_block_rooms
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('seminars');
--> statement-breakpoint
CREATE TRIGGER sof_counselors_notify AFTER INSERT OR UPDATE OR DELETE ON counselors
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('counseling');
--> statement-breakpoint
CREATE TRIGGER sof_counseling_bookings_notify AFTER INSERT OR UPDATE OR DELETE ON counseling_bookings
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('counseling');
--> statement-breakpoint
CREATE TRIGGER sof_settings_notify AFTER INSERT OR UPDATE ON settings
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('settings');
--> statement-breakpoint
CREATE TRIGGER sof_info_pages_notify AFTER INSERT OR UPDATE OR DELETE ON info_pages
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('info');
--> statement-breakpoint
CREATE TRIGGER sof_announcements_notify AFTER INSERT OR UPDATE OR DELETE ON announcements
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('info');
