import { Button, Card, Group, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Switch, Text, Textarea, Title } from '@mantine/core';
import { gameConfigSchema, type GameAdminView, type GameConfig } from '@sof/shared';
import { IconDeviceFloppy, IconRefreshAlert, IconTrash } from '@tabler/icons-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useGameReset, useSaveGameConfig } from '../../api/game.ts';
import { ModalActions } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { EventDateTimeInput, TzHint } from '../../components/dates.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { isoToWall, wallToIso } from '../../lib/tz.ts';

const TIMES = ['signupOpensAt', 'signupClosesAt', 'distributeAt', 'startsAt', 'designUntil'] as const;
type Draft = Omit<GameConfig, (typeof TIMES)[number]> & Record<(typeof TIMES)[number], string | null>;

const toDraft = (c: GameConfig, tz: string): Draft => ({ ...c, ...Object.fromEntries(TIMES.map((k) => [k, isoToWall(c[k], tz)])) }) as Draft;
const fromDraft = (d: Draft, tz: string): GameConfig => ({ ...d, ...Object.fromEntries(TIMES.map((k) => [k, wallToIso(d[k], tz)])) }) as GameConfig;

/** Все настройки игры одной формой; применяются по «Сохранить». Запуск и тест-лист - на «Пульте». */
export function SettingsPanel({ view }: { view: GameAdminView }) {
  const tz = useEventTz();
  const save = useSaveGameConfig();
  const reset = useGameReset();
  const confirm = useConfirm();
  const doReset = async (scope: 'teams' | 'all') => {
    const ok = await confirm({
      title: scope === 'teams' ? 'Удалить все команды?' : 'Начать игру с нуля?',
      message:
        scope === 'teams'
          ? 'Удалятся все команды, капитаны, названия и голоса. Записавшиеся останутся записанными - без команд. Настройки не меняются.'
          : 'Удалятся команды, голоса и все ответы «участвую / не участвую», запись закроется. Настройки и тест-лист останутся.',
      confirmLabel: scope === 'teams' ? 'Удалить команды' : 'Начать с нуля',
      danger: true,
    });
    if (ok) reset.mutate(scope, { onSuccess: () => notifySuccess(scope === 'teams' ? 'Команды удалены' : 'Игра сброшена'), onError: (e) => notifyError(e) });
  };
  const [draft, setDraft] = useState(() => toDraft(view.config, tz));
  const server = JSON.stringify(toDraft(view.config, tz));
  // Запуск и тест-лист меняются на «Пульте» - их в черновике не сравниваем (сервер их здесь и не сохраняет).
  const dirty = JSON.stringify({ ...draft, enabled: view.config.enabled, adminsOnly: view.config.adminsOnly, testerIds: view.config.testerIds }) !== server;
  // Подтягиваем свежие настройки, только пока форму не правят.
  useEffect(() => {
    if (!dirty) setDraft(JSON.parse(server) as Draft);
  }, [server]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const sw = (k: keyof Draft) => ({ checked: Boolean(draft[k]), onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.currentTarget.checked as never) });

  const submit = async () => {
    const parsed = gameConfigSchema.safeParse(fromDraft(draft, tz));
    if (!parsed.success) return notifyError(new Error(parsed.error.issues[0]?.message ?? 'Проверьте поля'), 'Не сохранилось');
    if (parsed.data.mode !== view.config.mode && view.rounds.length > 0) {
      const ok = await confirm({
        title: 'Сменить способ голосования?',
        message: 'Голоса уже есть - старые останутся в итогах и смешаются с новыми. Для чистого старта сначала «Стереть голоса» на «Пульте».',
        confirmLabel: 'Сменить',
        danger: true,
      });
      if (!ok) return;
    }
    save.mutate(parsed.data, { onSuccess: () => notifySuccess('Настройки игры сохранены'), onError: (e) => notifyError(e, 'Не сохранилось') });
  };

  return (
    <Stack gap="md" pb={80}>
      <Section title="Голосование" description="Голосовать может любой, кто открыл бота: один голос с одного Telegram за каждую команду.">
        <SegmentedControl
          fullWidth
          value={draft.mode}
          onChange={(v) => set('mode', v as GameConfig['mode'])}
          data={[
            { value: 'per_team', label: 'После каждой команды' },
            { value: 'budget', label: 'Общий запас в конце' },
          ]}
        />
        <Text size="sm" c="dimmed">
          {draft.mode === 'per_team'
            ? 'После выступления каждой команды ведущий открывает голосование, каждый отдаёт ей от 1 до N «человек».'
            : 'Когда выступят все, у каждого есть запас «человек» - раздать между командами как угодно, но весь.'}
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
          {draft.mode === 'per_team' ? (
            <NumberInput label="«Человек» на одну команду" min={1} max={20} allowDecimal={false} value={draft.pointsPerTeam} onChange={(v) => set('pointsPerTeam', Number(v) || 1)} />
          ) : (
            <NumberInput label="Общий запас «человек»" min={1} max={500} allowDecimal={false} value={draft.budget} onChange={(v) => set('budget', Number(v) || 1)} />
          )}
          <NumberInput
            label="Длительность раунда, сек"
            description="Пусто - пока ведущий не закроет"
            min={10}
            max={3600}
            allowDecimal={false}
            value={draft.roundSeconds ?? ''}
            onChange={(v) => set('roundSeconds', v === '' ? null : Number(v))}
          />
        </SimpleGrid>
        <Switch label="За свою команду голосовать нельзя" {...sw('forbidOwnTeam')} />
        <Switch label="Показывать голосующим текущие очки" description="Иначе очки видны только на большом экране" {...sw('showResults')} />
        <Switch label="Сообщать игрокам в бот, когда открылось голосование" {...sw('notifyRounds')} />
      </Section>

      <Section title="Набор игроков">
        <SegmentedControl
          value={draft.audience}
          onChange={(v) => set('audience', v as GameConfig['audience'])}
          data={[
            { value: 'arrived_today', label: 'Отмеченным сегодня на входе' },
            { value: 'registered', label: 'Всем зарегистрированным' },
          ]}
        />
        <Text size="sm" c="dimmed">
          Кому придёт приглашение «Будешь участвовать?» и кто сможет записаться во вкладке «Игра». В тестовом запуске не действует - там записываются только люди из тест-листа, без отметки на входе.
        </Text>
        <Switch label="Можно передумать после ответа" {...sw('allowChangeAnswer')} />
      </Section>

      <Section title="Команды и капитаны">
        <Switch label="Делить парней и девушек поровну" {...sw('balanceGender')} />
        <NumberInput
          label="Максимум человек в команде"
          description="Пусто - без ограничения"
          min={1}
          max={500}
          allowDecimal={false}
          w={260}
          value={draft.maxTeamSize ?? ''}
          onChange={(v) => set('maxTeamSize', v === '' ? null : Number(v))}
        />
        <Switch label="Капитан - случайный игрок, если ведущий не выбрал заранее" {...sw('randomCaptain')} />
        <Switch label="Названия от капитанов сначала одобряет ведущий" {...sw('reviewNames')} />
        <Select
          label="Страну команде даёт"
          allowDeselect={false}
          data={[
            { value: 'host', label: 'Ведущий (вместе с заданием) - до «Показать задания» команда её не видит' },
            { value: 'captain', label: 'Капитан - из стран свободных заданий (или любую, если у заданий нет стран)' },
          ]}
          value={draft.countryBy}
          onChange={(v) => v && set('countryBy', v as 'host' | 'captain')}
        />
        <Switch label="«Показать задания» - присылать каждой команде её задание в бот" {...sw('notifyTasks')} />
      </Section>

      <Section title="Расписание" description="Всё можно делать и кнопками на «Пульте» - время просто делает это само.">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <EventDateTimeInput label="Запись открывается" clearable value={draft.signupOpensAt} onChange={(v) => set('signupOpensAt', v)} />
          <EventDateTimeInput label="Запись закрывается" clearable value={draft.signupClosesAt} onChange={(v) => set('signupClosesAt', v)} />
          <EventDateTimeInput label="Распределить по командам" description="Обычно за 15 минут до начала" clearable value={draft.distributeAt} onChange={(v) => set('distributeAt', v)} />
          <EventDateTimeInput label="Начало игры" clearable value={draft.startsAt} onChange={(v) => set('startsAt', v)} />
          <EventDateTimeInput label="Капитаны оформляют команду до" clearable value={draft.designUntil} onChange={(v) => set('designUntil', v)} />
        </SimpleGrid>
        <TzHint tz={tz} />
      </Section>

      <Section title="Сообщения в бот" description="{team} заменится на команду: флаг, название и страна. Жирный - через <b>…</b>. Пустое поле - текст по умолчанию.">
        <Textarea label="Приглашение «Будешь участвовать?»" autosize minRows={3} maxLength={1000} value={draft.inviteText} onChange={(e) => set('inviteText', e.currentTarget.value)} />
        <Textarea label="«Ты в команде»" autosize minRows={3} maxLength={1000} value={draft.assignedText} onChange={(e) => set('assignedText', e.currentTarget.value)} />
        <Textarea label="Капитану" autosize minRows={3} maxLength={1000} value={draft.captainText} onChange={(e) => set('captainText', e.currentTarget.value)} />
        <Textarea
          label="Открылось голосование за команду"
          description="Уходит игрокам, если включено «Сообщать игрокам в бот, когда открылось голосование»"
          autosize
          minRows={2}
          maxLength={500}
          value={draft.roundText}
          onChange={(e) => set('roundText', e.currentTarget.value)}
        />
        <Textarea label="Открылось общее голосование (общий запас)" autosize minRows={2} maxLength={500} value={draft.budgetRoundText} onChange={(e) => set('budgetRoundText', e.currentTarget.value)} />
      </Section>

      <Section title="Мини-апка и большой экран" description="Тексты вкладки «Игра» и большого экрана. Пустое поле - строку не показываем.">
        <Textarea
          label="Описание игры - «после каждой команды»"
          description="Вверху вкладки «Игра»"
          autosize
          minRows={2}
          maxLength={500}
          value={draft.introPerTeam}
          onChange={(e) => set('introPerTeam', e.currentTarget.value)}
        />
        <Textarea
          label="Описание игры - «общий запас»"
          description="{budget} заменится на запас «человек»"
          autosize
          minRows={2}
          maxLength={500}
          value={draft.introBudget}
          onChange={(e) => set('introBudget', e.currentTarget.value)}
        />
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <Textarea label="Запись: заголовок" autosize minRows={1} maxLength={120} value={draft.signupTitle} onChange={(e) => set('signupTitle', e.currentTarget.value)} />
          <Textarea label="Запись: подпись" autosize minRows={1} maxLength={300} value={draft.signupText} onChange={(e) => set('signupText', e.currentTarget.value)} />
        </SimpleGrid>
        <Textarea
          label="Пока голосования нет"
          description="Под «Голосование откроется после выступления команды»"
          autosize
          minRows={1}
          maxLength={300}
          value={draft.waitHint}
          onChange={(e) => set('waitHint', e.currentTarget.value)}
        />
        <Textarea
          label="Большой экран: подсказка"
          description="Под названием команды, пока идёт голосование"
          autosize
          minRows={1}
          maxLength={200}
          value={draft.screenHint}
          onChange={(e) => set('screenHint', e.currentTarget.value)}
        />
      </Section>

      <Section title="Начать заново" description="Для репетиции и перед настоящей игрой. Настройки игры не меняются.">
        <Group gap="sm">
          <Button variant="light" color="red" leftSection={<IconTrash size={16} />} loading={reset.isPending && reset.variables === 'teams'} onClick={() => void doReset('teams')}>
            Удалить все команды
          </Button>
          <Button variant="light" color="red" leftSection={<IconRefreshAlert size={16} />} loading={reset.isPending && reset.variables === 'all'} onClick={() => void doReset('all')}>
            Сбросить всю игру
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          «Удалить все команды» - записавшиеся остаются, команды создадите заново на вкладке «Команды». «Сбросить всю игру» - ещё и все ответы на приглашение.
        </Text>
      </Section>

      <ModalActions justify="space-between">
        <Text size="sm" c={dirty ? 'yellow' : 'dimmed'}>
          {dirty ? 'Есть несохранённые изменения' : 'Всё сохранено'}
        </Text>
        <Group gap="sm">
          <Button variant="default" disabled={!dirty} onClick={() => setDraft(JSON.parse(server) as Draft)}>
            Отменить
          </Button>
          <Button leftSection={<IconDeviceFloppy size={16} />} disabled={!dirty} loading={save.isPending} onClick={() => void submit()}>
            Сохранить
          </Button>
        </Group>
      </ModalActions>
    </Stack>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <Stack gap="sm">
        <div>
          <Title order={4} fz="md">
            {title}
          </Title>
          {description && (
            <Text size="sm" c="dimmed">
              {description}
            </Text>
          )}
        </div>
        {children}
      </Stack>
    </Card>
  );
}
