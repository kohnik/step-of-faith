import type { StaffSessionResponse } from '@sof/shared';
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { IconScan } from '@tabler/icons-react';
import { IconChip } from '../ui/icons.tsx';
import { api, errorMessage } from '../api/client.ts';
import { DEFAULT_EVENT_NAME } from '../app/brand.ts';
import { hasBrowserSession, saveBrowserSession } from '../staff/session.ts';
import { Button, Notice, Spinner } from '../ui/kit.tsx';
import { injectStaffManifest, registerServiceWorker } from './sw.ts';

type State = { kind: 'working' } | { kind: 'error'; message: string } | { kind: 'no-token' };

/** Токен одноразово обменивается на сессию; защищаемся от повторного вызова эффекта. */
let exchanging: string | null = null;

/**
 * Вход по карточке сканера: `/staff/login#token=…` → `POST /api/auth/login-token {mode:'bearer'}`
 * → Bearer-токен в localStorage → браузерный сканер.
 */
export default function StaffLoginPage() {
  const [, navigate] = useLocation();
  const [state, setState] = useState<State>({ kind: 'working' });

  useEffect(() => {
    document.title = `${DEFAULT_EVENT_NAME} - вход для команды`;
    injectStaffManifest();
    registerServiceWorker('/staff');
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    const fromQuery = new URLSearchParams(window.location.search).get('token');
    const token = fromHash ?? fromQuery;
    // Токен не должен оставаться в адресной строке и истории.
    if (token) window.history.replaceState(null, '', '/staff/login');
    if (!token) {
      if (exchanging) return;
      if (hasBrowserSession()) navigate('/staff/scan', { replace: true });
      else setState({ kind: 'no-token' });
      return;
    }
    if (exchanging === token) return;
    exchanging = token;
    api<StaffSessionResponse>('/api/auth/login-token', {
      method: 'POST',
      body: { token, mode: 'bearer' },
      auth: 'none',
      timeoutMs: 15_000,
    })
      .then((res) => {
        saveBrowserSession(res);
        navigate('/staff/scan', { replace: true });
      })
      .catch((err: unknown) => {
        exchanging = null;
        setState({ kind: 'error', message: errorMessage(err) });
      });
  }, [navigate]);

  return (
    <div className="mx-auto flex min-h-app max-w-md flex-col justify-center px-5 pb-[calc(var(--safe-bottom)+24px)] pt-[calc(var(--safe-top)+24px)]">
      <div className="mb-4 flex justify-center">
        <IconChip icon={IconScan} hue="blue" size="xl" />
      </div>
      <h1 className="text-center text-2xl font-bold">Сканер «{DEFAULT_EVENT_NAME}»</h1>
      {state.kind === 'working' && (
        <div className="mt-6 flex items-center justify-center gap-3 text-subtle">
          <Spinner className="text-btn" />
          Входим…
        </div>
      )}
      {state.kind === 'error' && (
        <>
          <Notice tone="red" className="mt-6">
            {state.message}
          </Notice>
          <p className="mt-3 text-center text-[15px] text-subtle">
            Если ссылка устарела, попросите у организаторов новую карточку.
          </p>
        </>
      )}
      {state.kind === 'no-token' && (
        <>
          <p className="mt-4 text-center text-[15px] leading-relaxed text-subtle">
            Отсканируйте камерой телефона QR-код на своей карточке волонтёра - и сразу попадёте в сканер.
          </p>
          {hasBrowserSession() && (
            <Button className="mt-6" size="lg" block onClick={() => navigate('/staff/scan')}>
              Открыть сканер
            </Button>
          )}
        </>
      )}
    </div>
  );
}
