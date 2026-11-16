import { ActionIcon, Group, Tooltip } from '@mantine/core';
import type { ActivityView, CounselorAdminView, SeminarBlockView } from '@sof/shared';
import { IconEye, IconEyeOff, IconPencil, IconTrash, IconUsers } from '@tabler/icons-react';
import { useState, type MouseEvent } from 'react';
import { useDeleteActivity } from '../../api/activities.ts';
import { useSaveCounselor, useDeleteCounselor } from '../../api/counseling.ts';
import { useDeleteBlock, useSaveBlock } from '../../api/seminars.ts';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { capitalizeFirst, countLabel } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';

const PEOPLE: [string, string, string] = ['человек', 'человека', 'человек'];
const BOOKINGS: [string, string, string] = ['запись', 'записи', 'записей'];

/** Кому уйдёт сообщение об отмене, переносе или удалении: записавшиеся, очередь и отметившие «Пойду». */
export function activityAudience(a: ActivityView): string | null {
  const people = a.registeredCount + a.waitlistCount;
  const parts: string[] = [];
  if (people) parts.push(`записавшиеся (${countLabel(people, PEOPLE)})`);
  if (a.interestCount) parts.push(`отметившие «Пойду» (${a.interestCount})`);
  return parts.length ? capitalizeFirst(parts.join(' и ')) : null;
}

/** Удалить мероприятие из строки расписания или из формы: подтверждение с теми, кому придёт сообщение. */
export function useActivityDelete() {
  const remove = useDeleteActivity();
  const confirm = useConfirm();
  const run = async (a: ActivityView, onDone?: () => void) => {
    const audience = activityAudience(a);
    const ok = await confirm({
      title: 'Удалить мероприятие?',
      message: audience ? `«${a.title}» исчезнет из программы. ${audience} получат сообщение.` : `«${a.title}» исчезнет из программы.`,
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    remove.mutate(a.id, {
      onSuccess: () => {
        notifySuccess('Мероприятие удалено', a.title);
        onDone?.();
      },
      onError: (err) => notifyError(err),
    });
  };
  return { run, pending: remove.isPending };
}

/** Блок семинаров: удалить целиком и скрыть/показать участникам (темы сохраняют свой статус). */
export function useBlockActions(block: SeminarBlockView) {
  const remove = useDeleteBlock();
  const save = useSaveBlock();
  const confirm = useConfirm();
  const registered = block.topics.reduce((s, t) => s + t.registered, 0);
  const del = async (onDone?: () => void) => {
    const ok = await confirm({
      title: 'Удалить поток?',
      message: registered ? `Сеансы потока удалятся, распределённым (${countLabel(registered, PEOPLE)}) придёт сообщение.` : 'Поток и его сеансы удалятся.',
      confirmLabel: 'Удалить поток',
      danger: true,
    });
    if (!ok) return;
    remove.mutate(block.id, {
      onSuccess: () => {
        notifySuccess('Поток удалён', block.title);
        onDone?.();
      },
      onError: (err) => notifyError(err),
    });
  };
  const toggleHidden = async () => {
    if (!block.hidden && registered > 0) {
      const ok = await confirm({
        title: 'Выключить поток?',
        message: `В потоке распределено ${countLabel(registered, PEOPLE)}. Поток пропадёт у них из расписания, сообщения не будет. Места сохранятся - включите поток, и всё вернётся.`,
        confirmLabel: 'Выключить',
      });
      if (!ok) return;
    }
    save.mutate(
      { id: block.id, input: { hidden: !block.hidden } },
      {
        onSuccess: () => notifySuccess(block.hidden ? 'Поток снова участвует' : 'Поток выключен', block.title),
        onError: (err) => notifyError(err),
      },
    );
  };
  return { del, toggleHidden, deleting: remove.isPending, toggling: save.isPending };
}

/** Душепопечение дня - это служители этого дня: удалить всех или скрыть/показать всех. */
export function useCounselingDayActions(counselors: CounselorAdminView[]) {
  const remove = useDeleteCounselor();
  const save = useSaveCounselor();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<'delete' | 'toggle' | null>(null);
  const booked = counselors.reduce((s, c) => s + c.bookings.length, 0);
  const hidden = counselors.length > 0 && counselors.every((c) => c.hidden);

  const del = async () => {
    const ok = await confirm({
      title: 'Удалить душепопечение этого дня?',
      message: booked
        ? `Удалятся служители (${counselors.length}). ${capitalizeFirst(countLabel(booked, BOOKINGS))} отменятся - людям придёт сообщение.`
        : `Удалятся служители (${counselors.length}): ${counselors.map((c) => c.name).join(', ')}.`,
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    setBusy('delete');
    try {
      for (const c of counselors) await remove.mutateAsync(c.id);
      notifySuccess('Душепопечение дня удалено');
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(null);
    }
  };

  const toggleHidden = async () => {
    if (!hidden && booked > 0) {
      const ok = await confirm({
        title: 'Скрыть душепопечение от участников?',
        message: `${capitalizeFirst(countLabel(booked, BOOKINGS))} сохранятся, но участники перестанут видеть служителей этого дня, сообщения не будет.`,
        confirmLabel: 'Скрыть',
      });
      if (!ok) return;
    }
    setBusy('toggle');
    try {
      for (const c of counselors) if (c.hidden === hidden) await save.mutateAsync({ id: c.id, input: { hidden: !hidden } });
      notifySuccess(hidden ? 'Душепопечение снова видно участникам' : 'Душепопечение скрыто от участников');
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(null);
    }
  };
  return { del, toggleHidden, hidden, deleting: busy === 'delete', toggling: busy === 'toggle' };
}

/**
 * Кнопки строки расписания - у мероприятий, блоков семинаров и душепопечения одинаково:
 * Удалить · Скрыть/Показать · Люди · Изменить. Нажатие не открывает строку (у строк блока это настройка).
 */
export function RowActions({
  label,
  hidden,
  onDelete,
  deleting,
  onToggle,
  toggling,
  onPeople,
  onEdit,
  size,
}: {
  label: string;
  /** null - глазка нет (например, отменённое мероприятие). */
  hidden: boolean | null;
  onDelete?: () => void;
  deleting?: boolean;
  onToggle?: () => void;
  toggling?: boolean;
  onPeople?: () => void;
  onEdit?: () => void;
  size?: 'md' | 'lg';
}) {
  const icon = size === 'lg' ? 18 : 16;
  const stop = (fn?: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn?.();
  };
  return (
    <Group gap={size === 'lg' ? 2 : 4} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
      {onDelete && (
        <Tooltip label="Удалить">
          <ActionIcon size={size} color="red" variant="subtle" loading={deleting} onClick={stop(onDelete)} aria-label={`Удалить: ${label}`}>
            <IconTrash size={icon} />
          </ActionIcon>
        </Tooltip>
      )}
      {onToggle && hidden !== null && (
        <Tooltip label={hidden ? 'Скрыто от участников - показать' : 'Видно участникам - скрыть'}>
          <ActionIcon
            size={size}
            color={hidden ? 'gray' : undefined}
            loading={toggling}
            onClick={stop(onToggle)}
            aria-label={hidden ? `Показать участникам: ${label}` : `Скрыть от участников: ${label}`}
          >
            {hidden ? <IconEyeOff size={icon} /> : <IconEye size={icon} />}
          </ActionIcon>
        </Tooltip>
      )}
      {onPeople && (
        <Tooltip label="Кто записан">
          <ActionIcon size={size} onClick={stop(onPeople)} aria-label={`Кто записан: ${label}`}>
            <IconUsers size={icon} />
          </ActionIcon>
        </Tooltip>
      )}
      {onEdit && (
        <Tooltip label="Изменить">
          <ActionIcon size={size} onClick={stop(onEdit)} aria-label={`Изменить: ${label}`}>
            <IconPencil size={icon} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}
