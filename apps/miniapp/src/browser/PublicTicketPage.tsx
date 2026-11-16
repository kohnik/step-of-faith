import { textOn, type PublicTicket } from '@sof/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { IconCircleCheck, IconQrcodeOff } from '@tabler/icons-react';
import { IconChip } from '../ui/icons.tsx';
import { api, ApiError } from '../api/client.ts';
import { DEFAULT_EVENT_NAME } from '../app/brand.ts';
import { formatTime, isToday } from '../lib/time.ts';
import { Badge, ErrorState, Notice, Spinner } from '../ui/kit.tsx';
import { TicketQr } from '../ui/TicketQr.tsx';
import { registerServiceWorker } from './sw.ts';

/**
 * QR-код для входа по секретной ссылке: работает без Telegram. Service worker кэширует страницу,
 * данные и картинку - после первого открытия QR-код виден и без интернета.
 * Статус оплаты здесь не показываем: в ответе нет признака, включена ли оплата.
 */
export default function PublicTicketPage({ token }: { token: string }) {
  const q = useQuery({
    queryKey: ['public-ticket', token],
    queryFn: () => api<PublicTicket>(`/api/public/tickets/${encodeURIComponent(token)}`, { auth: 'none' }),
    staleTime: 60_000,
  });

  useEffect(() => {
    registerServiceWorker('/t/');
  }, []);

  useEffect(() => {
    document.title = q.data ? `QR-код - ${q.data.fullName}` : `${DEFAULT_EVENT_NAME} - QR-код для входа`;
  }, [q.data]);

  const t = q.data;
  const notFound = q.error instanceof ApiError && q.error.status === 404;

  return (
    <div className="mx-auto min-h-app w-full max-w-md px-4 pb-[calc(var(--safe-bottom)+28px)] pt-[calc(var(--safe-top)+20px)]">
      {q.isPending ? (
        <div className="flex min-h-[60vh] items-center justify-center">
          <Spinner className="size-9 text-btn" />
        </div>
      ) : notFound ? (
        <div className="py-16 text-center">
          <IconChip icon={IconQrcodeOff} hue="gray" size="xl" className="mb-4" />
          <h1 className="text-xl font-bold">QR-код не найден</h1>
          <p className="mt-2 text-[15px] text-subtle">
            Ссылка устарела или регистрацию отменили. Свежий QR-код всегда есть в боте конференции «{DEFAULT_EVENT_NAME}».
          </p>
        </div>
      ) : !t ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="rounded-3xl bg-section p-5 text-center shadow-sm">
          <p className="text-[13px] font-semibold uppercase tracking-wide text-subtle">{t.eventName || DEFAULT_EVENT_NAME}</p>
          <p className="mt-1 text-[15px] text-subtle">QR-код для входа</p>
          <h1 className="mt-1 text-2xl font-bold leading-snug">{t.fullName}</h1>
          {t.arrivedAt && isToday(t.arrivedAt, t.eventTimezone) && (
            <div className="mt-2 flex justify-center">
              <Badge tone="green">
                <IconCircleCheck size={15} />
                Уже на месте с {formatTime(t.arrivedAt, t.eventTimezone)}
              </Badge>
            </div>
          )}

          {t.status === 'revoked' ? (
            <>
              <div className="relative mt-4">
                <TicketQr code={t.code} dimmed />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="rotate-[-8deg] rounded-xl border-4 border-bad px-4 py-2 text-xl font-extrabold uppercase text-bad">
                    Не действует
                  </span>
                </div>
              </div>
              <Notice tone="red" className="mt-4 text-left">
                QR-код перевыпущен и на входе не сработает. Новый есть в боте конференции.
              </Notice>
            </>
          ) : (
            <>
              <TicketQr code={t.code} className="mt-4" />
              <p className="mt-3 select-all font-mono text-[26px] font-bold tracking-wider">{t.displayCode}</p>
              {t.tier && (
                <div className="mt-3 rounded-xl px-4 py-2.5 text-[17px] font-bold" style={{ background: t.tier.color, color: textOn(t.tier.color) }}>
                  {t.tier.short}
                </div>
              )}
              <p className="mx-auto mt-2 max-w-xs text-[13px] leading-snug text-hint">
                Покажите этот QR-код на входе. После первого открытия страница работает и без интернета.
              </p>
              <a
                href={t.imageUrl}
                download={`qr-${t.code}.png`}
                target="_blank"
                rel="noopener"
                className="mt-4 flex min-h-12 w-full items-center justify-center rounded-xl bg-fill px-4 font-semibold text-accent no-underline active:opacity-80"
              >
                Сохранить картинку
              </a>
            </>
          )}
          {q.isError && <p className="mt-3 text-[13px] text-warn-fg">Нет связи. Показываем сохранённый QR-код.</p>}
        </div>
      )}
    </div>
  );
}
