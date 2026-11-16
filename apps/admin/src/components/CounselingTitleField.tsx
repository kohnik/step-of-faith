import { Button, Card, Group, Text, TextInput } from '@mantine/core';
import { IconDeviceFloppy } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useSaveSettings, useSettingsQuery } from '../api/settings.ts';
import { notifyError, notifySuccess } from '../lib/notify.tsx';
import { useCan } from './SessionProvider.tsx';

/** Как душепопечение называется у участников (расписание, главная, бот). В админке оно остаётся «Душепопечением». */
export function CounselingTitleField() {
  const can = useCan();
  const editable = can('settings:write');
  const settings = useSettingsQuery();
  const save = useSaveSettings();
  const current = settings.data?.counselingTitle ?? '';
  const [value, setValue] = useState(current);
  useEffect(() => setValue(current), [current]);
  if (!settings.data) return null;
  const next = value.trim();
  const changed = next !== current;
  const submit = () =>
    save.mutate(
      { counselingTitle: next },
      { onSuccess: (s) => notifySuccess(`Участники видят «${s.counselingTitle}»`, 'Название сохранено'), onError: (err) => notifyError(err) },
    );
  return (
    <Card padding="md">
      <Group align="flex-end" gap="sm" wrap="wrap">
        <TextInput
          label="Название у участников"
          description="Так это называется в расписании, на главной мини-приложения и в сообщениях бота"
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && changed && next && submit()}
          maxLength={60}
          disabled={!editable}
          error={changed && !next ? 'Укажите название' : undefined}
          style={{ flex: '1 1 260px' }}
        />
        {changed && (
          <Button leftSection={<IconDeviceFloppy size={16} />} loading={save.isPending} disabled={!next} onClick={submit}>
            Сохранить
          </Button>
        )}
      </Group>
      {!editable && (
        <Text size="xs" c="dimmed" mt={6}>
          Менять название могут админ и суперадмин.
        </Text>
      )}
    </Card>
  );
}
