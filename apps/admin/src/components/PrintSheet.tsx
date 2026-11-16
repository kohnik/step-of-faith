import { Badge, Group, Stack, Text } from '@mantine/core';
import { CATEGORY_LABELS, type Category } from '@sof/shared';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formatTicket } from '../lib/format.ts';
import { QrCode } from './QrCode.tsx';

/**
 * Лист для печати: рендерится прямо в <body>, на экране скрыт. На время
 * `printSheet()` всё остальное прячется стилями `body.sof-printing`.
 */
export function PrintSheet({ children }: { children: ReactNode }) {
  return createPortal(<div className="sof-print-root">{children}</div>, document.body);
}

export function printSheet(): void {
  const body = document.body;
  const cleanup = () => {
    body.classList.remove('sof-printing');
    window.removeEventListener('afterprint', cleanup);
  };
  body.classList.add('sof-printing');
  window.addEventListener('afterprint', cleanup);
  window.print();
  // В большинстве браузеров print() блокирующий; на всякий случай снимаем класс чуть позже.
  window.setTimeout(cleanup, 1500);
}

/** Бумажный QR-код для человека без Telegram: тот же QR, что в боте (код, уровень Q). */
export function QrPrintCard({
  eventName,
  fullName,
  code,
  category,
}: {
  eventName: string;
  fullName: string;
  code: string;
  category?: Category;
}) {
  return (
    <div className="sof-volunteer-card">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Text size="xs" tt="uppercase" fw={700} c="gray.7">
            {eventName} · QR-код для входа
          </Text>
          <Text fw={800} fz={20} lh={1.2}>
            {fullName}
          </Text>
          {category && (
            <Badge variant="outline" color="dark" size="sm">
              {CATEGORY_LABELS[category]}
            </Badge>
          )}
          <Text className="sof-mono" fw={700} fz={18} mt="sm">
            {formatTicket(code)}
          </Text>
          <Text size="xs" c="gray.7">
            Покажите этот QR-код на входе. Если камера не читает - просто назовите код под ним.
          </Text>
        </Stack>
        <QrCode value={code} level="Q" size={150} margin={2} label={`QR-код для входа ${code}`} />
      </Group>
    </div>
  );
}
