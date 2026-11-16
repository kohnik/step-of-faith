-- Тексты игры без длинных тире: «-» → «-» в уже сохранённых сообщениях бота. Ключ правим, только если он есть,
-- иначе в настройках появился бы null и они не прошли бы проверку.
UPDATE game_state SET config = jsonb_set(config, '{inviteText}', to_jsonb(replace(config->>'inviteText', '-', '-'))) WHERE config ? 'inviteText';--> statement-breakpoint
UPDATE game_state SET config = jsonb_set(config, '{assignedText}', to_jsonb(replace(config->>'assignedText', '-', '-'))) WHERE config ? 'assignedText';--> statement-breakpoint
UPDATE game_state SET config = jsonb_set(config, '{captainText}', to_jsonb(replace(config->>'captainText', '-', '-'))) WHERE config ? 'captainText';
