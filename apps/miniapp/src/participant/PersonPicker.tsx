import type { MyParticipant } from '@sof/shared';
import { useState } from 'react';
import { session } from '../lib/storage.ts';
import { cx } from '../ui/kit.tsx';

/** Тот же ключ, что у расписания: выбранный человек переходит между экранами. */
const PERSON_KEY = 'sof:schedule-person';

/** Кого записываем: выбор запоминается на время сессии. */
export function usePerson(family: MyParticipant[]) {
  const [personId, setPersonId] = useState<number | null>(() => Number(session.get(PERSON_KEY)) || null);
  const person = family.find((p) => p.id === personId) ?? family[0];
  const choose = (id: number) => {
    setPersonId(id);
    session.set(PERSON_KEY, String(id));
  };
  return { person, choose };
}

export function PersonPicker({
  family,
  person,
  onChoose,
  label = 'Кого записываем:',
}: {
  family: MyParticipant[];
  person: MyParticipant | undefined;
  onChoose: (id: number) => void;
  label?: string;
}) {
  if (family.length <= 1 || !person) return null;
  return (
    <div className="mb-4 rounded-2xl bg-section px-3 py-2.5">
      <p className="mb-2 text-[13px] text-subtle">{label}</p>
      <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1">
        {family.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChoose(p.id)}
            className={cx(
              'min-h-10 shrink-0 rounded-full px-4 text-[15px] font-semibold transition',
              p.id === person.id ? 'bg-btn text-btn-fg' : 'bg-fill text-fg',
            )}
          >
            {p.firstName}
          </button>
        ))}
      </div>
    </div>
  );
}
