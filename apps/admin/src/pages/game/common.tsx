import { Group, Select, Text, type SelectProps } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { COUNTRY_CODES, countryName, flagEmoji, type GameAdminView, type GameCandidate, type GameTeamView } from '@sof/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useGameCandidates } from '../../api/game.ts';

/** Цветная точка, флаг и название: «● 🇰🇪 Надежда». */
export function TeamLabel({ team, size = 'sm' }: { team: Pick<GameTeamView, 'title' | 'flag' | 'color' | 'placeholder' | 'countryName'>; size?: 'sm' | 'md' | 'lg' }) {
  const fz = size === 'lg' ? 'lg' : size === 'md' ? 'md' : 'sm';
  return (
    <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
      <span style={{ width: 12, height: 12, borderRadius: 99, background: team.color, flexShrink: 0 }} />
      {team.flag && <span style={{ fontSize: size === 'lg' ? 22 : 18, lineHeight: 1 }}>{team.flag}</span>}
      <div style={{ minWidth: 0 }}>
        <Text fz={fz} fw={700} truncate>
          {team.title}
        </Text>
        {team.countryName && (
          <Text size="xs" c="dimmed" truncate>
            {team.countryName}
          </Text>
        )}
      </div>
    </Group>
  );
}

/** Страны по-русски, по алфавиту, с флагами - для выбора в форме. */
export function useCountryOptions() {
  return useMemo(
    () =>
      COUNTRY_CODES.map((code) => ({ value: code, label: `${flagEmoji(code)} ${countryName(code)}` })).sort((a, b) =>
        a.label.slice(3).localeCompare(b.label.slice(3), 'ru'),
      ),
    [],
  );
}

export function CountrySelect(props: Omit<SelectProps, 'data'>) {
  const data = useCountryOptions();
  return <Select searchable clearable nothingFoundMessage="Нет такой страны" placeholder="Страна" {...props} data={data} />;
}

/** Секунд до `closesAt` (по часам устройства, с поправкой на часы сервера). */
export function useCountdown(closesAt: string | null, serverOffsetMs = 0): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!closesAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [closesAt]);
  if (!closesAt) return null;
  return Math.max(0, Math.ceil((Date.parse(closesAt) - (now + serverOffsetMs)) / 1000));
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * Выбор участника: сначала `preferred` (например, игроки команды), дальше - все записавшиеся,
 * а поиск по ФИО находит любого участника конференции (даже если он ещё не ответил на приглашение).
 */
export function PersonPicker({
  view,
  value,
  onChange,
  preferred = [],
  ...props
}: Omit<SelectProps, 'data' | 'value' | 'onChange' | 'searchValue' | 'onSearchChange'> & {
  view: GameAdminView;
  value: number | null;
  onChange: (id: number | null) => void;
  preferred?: number[];
}) {
  const [search, setSearch] = useState('');
  // Выбранного из поиска помним: после выбора в поле - его подпись, и поиск по ней его уже не вернёт.
  const [picked, setPicked] = useState<GameCandidate[]>([]);
  const labelOf = useRef(new Map<string, string>());
  const typed = search.trim();
  const [q] = useDebouncedValue([...labelOf.current.values()].includes(typed) ? '' : typed, 250);
  const found = useGameCandidates(q);
  const teamName = (id: number | null) => (id ? (view.teams.find((t) => t.id === id)?.title ?? '') : '');
  const data = useMemo(() => {
    const seen = new Set<string>();
    const out: { group: string; items: { value: string; label: string }[] }[] = [];
    const push = (group: string, list: { participantId: number; fullName: string; teamId: number | null; answer?: string | null }[]) => {
      const items = list
        .filter((p) => !seen.has(String(p.participantId)))
        .map((p) => {
          seen.add(String(p.participantId));
          const note = p.teamId ? teamName(p.teamId) : p.answer === 'yes' ? 'без команды' : p.answer === 'no' ? 'отказался(ась)' : 'не отвечал(а)';
          const label = `${p.fullName} · ${note}`;
          labelOf.current.set(String(p.participantId), label);
          return { value: String(p.participantId), label };
        });
      if (items.length) out.push({ group, items });
    };
    const yes = view.players.filter((p) => p.answer === 'yes');
    push('Команда', yes.filter((p) => preferred.includes(p.participantId)));
    if (q.length >= 2) push('Найдены', found.data ?? []);
    push('Записались', yes);
    // Выбранный должен быть в списке, иначе поле покажется пустым.
    const current = value ? (view.players.find((p) => p.participantId === value) ?? picked.find((p) => p.participantId === value)) : null;
    if (current) push('Выбран', [current]);
    return out;
  }, [view, preferred.join(','), q, found.data, value, picked]);

  return (
    <Select
      searchable
      clearable
      nothingFoundMessage={q.length >= 2 ? (found.isFetching ? 'Ищем…' : 'Никого не нашли') : 'Начните вводить фамилию'}
      {...props}
      data={data}
      value={value ? String(value) : null}
      onChange={(v) => {
        const hit = found.data?.find((p) => String(p.participantId) === v);
        if (hit) setPicked((list) => [hit, ...list.filter((p) => p.participantId !== hit.participantId)]);
        onChange(v ? Number(v) : null);
      }}
      searchValue={search}
      onSearchChange={setSearch}
    />
  );
}
