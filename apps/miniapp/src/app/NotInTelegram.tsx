import { useEffect } from 'react';
import { IconBrandTelegram } from '@tabler/icons-react';
import { IconChip } from '../ui/icons.tsx';
import { Button } from '../ui/kit.tsx';
import { DEFAULT_EVENT_NAME } from './brand.ts';

/** Личный кабинет работает только внутри Telegram (вход по данным Telegram). */
export function NotInTelegram() {
  const bot = import.meta.env.VITE_BOT_USERNAME?.replace(/^@/, '');

  useEffect(() => {
    document.title = `${DEFAULT_EVENT_NAME} - откройте в Telegram`;
  }, []);

  return (
    <div className="mx-auto flex min-h-app max-w-md flex-col items-center justify-center px-6 text-center">
      <IconChip icon={IconBrandTelegram} hue="blue" size="xl" className="mb-5" />
      <h1 className="text-2xl font-bold">Откройте в Telegram</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-subtle">
        Регистрация, QR-коды и расписание конференции «{DEFAULT_EVENT_NAME}» находятся в Telegram. Откройте бота и нажмите
        «Открыть приложение».
      </p>
      {bot && (
        <Button className="mt-6" size="lg" onClick={() => window.location.assign(`https://t.me/${bot}`)}>
          Открыть @{bot}
        </Button>
      )}
      <p className="mt-8 text-[13px] text-hint">
        QR-код по ссылке из бота открывается и без Telegram. Волонтёрам: отсканируйте камерой телефона QR-код на своей
        карточке.
      </p>
    </div>
  );
}
