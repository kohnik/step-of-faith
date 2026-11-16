-- Ответы на запись в игру (сотни за минуты) будили и «me» у всех открытых приложений. Теперь «game» - только состояние игры;
-- включение и выключение игры (game_state) дополнительно шлёт «settings», чтобы на главной появился или пропал пункт «Игра».
DROP TRIGGER IF EXISTS sof_game_state_notify ON game_state;--> statement-breakpoint
CREATE TRIGGER sof_game_state_notify AFTER INSERT OR UPDATE OR DELETE ON game_state
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('game', 'settings');
