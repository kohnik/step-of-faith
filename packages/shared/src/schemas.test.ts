import { describe, expect, it } from 'vitest';
import {
  activityUpdateSchema,
  counselorInputSchema,
  counselorUpdateSchema,
  roomUpdateSchema,
  seminarBlockInputSchema,
  seminarBlockUpdateSchema,
  seminarTopicUpdateSchema,
} from './schemas.ts';

describe('схемы правки', () => {
  it('не подставляют значения по умолчанию: правка одного поля не трогает остальные', () => {
    // Переключатель «Запись открыта» не должен стирать залы блока.
    expect(seminarBlockUpdateSchema.parse({ registrationOpen: true })).toEqual({ registrationOpen: true });
    expect(activityUpdateSchema.parse({ status: 'draft' })).toEqual({ status: 'draft' });
    expect(counselorUpdateSchema.parse({ name: 'Кот Евгений' })).toEqual({ name: 'Кот Евгений' });
    expect(seminarTopicUpdateSchema.parse({ title: 'Тема' })).toEqual({ title: 'Тема' });
    expect(roomUpdateSchema.parse({ name: 'Зал' })).toEqual({ name: 'Зал' });
  });

  it('при создании значения по умолчанию на месте', () => {
    const at = '2026-11-07T14:00:00.000Z';
    expect(seminarBlockInputSchema.parse({ title: 'Семинар 1', startsAt: at, endsAt: at })).toMatchObject({ roomIds: [], registrationOpen: false });
    expect(counselorInputSchema.parse({ name: 'Кот', startsAt: at, endsAt: at })).toMatchObject({ slotMinutes: 20 });
  });
});
