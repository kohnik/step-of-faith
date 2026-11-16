import type { ClaimableResponse, ClaimResponse } from '@sof/shared';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { errorMessage } from '../api/client.ts';
import { refreshMe } from '../api/queries.ts';
import { haptic } from '../lib/feedback.ts';
import { canRequestContact, requestContactFromTelegram, type TelegramContact } from '../telegram/actions.ts';
import { Button } from '../ui/kit.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { toast } from '../ui/toast.tsx';
import { hasSelf, participantApi, useMeData } from './api.ts';

/** `+375291112233` → `+375 29 111-22-33`; остальные номера - как есть. */
function displayPhone(phone: string): string {
  const m = /^\+375(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return m ? `+375 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : phone;
}

/**
 * «Меня уже зарегистрировали»: друга записали с чужого аккаунта без ника. Он делится номером -
 * Telegram подписывает его, сервер проверяет подпись и находит регистрации на этот номер.
 */
export function useClaim({ onClaimed }: { onClaimed?: (claimed: ClaimResponse['claimed']) => void } = {}) {
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<ClaimableResponse | null>(null);

  /** Номер уже пришёл из Telegram (например, в анкете «Я»). quiet - если ничего не нашли, молчим. */
  const check = async (contact: TelegramContact, quiet = false) => {
    setBusy(true);
    try {
      const res = await participantApi.verifyPhone(contact.signed);
      // После сбоя хостинга: семью из восстановленной выгрузки уже перенесли на этот аккаунт.
      if (res.adopted) {
        await refreshMe();
        haptic('success');
        toast.success('Нашли вашу регистрацию. QR-коды пришлём в чат с ботом');
        // Регистрация «Я» уже есть - форма убирает свой черновик «Я» так же, как после «Это я».
        onClaimed?.([]);
        if (res.candidates.length > 0) setFound(res);
        return;
      }
      if (res.candidates.length > 0 || !quiet) setFound(res);
    } catch (err) {
      if (!quiet) toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (busy) return;
    setBusy(true);
    const contact = await requestContactFromTelegram();
    setBusy(false);
    if (!contact) {
      toast.info('Номер не пришёл. Попробуйте ещё раз');
      return;
    }
    await check(contact);
  };

  const sheet = (
    <ClaimSheet
      data={found}
      onClose={() => setFound(null)}
      onClaimed={(claimed) => {
        setFound(null);
        onClaimed?.(claimed);
      }}
    />
  );
  return { available: canRequestContact(), busy, start, check, sheet };
}

function ClaimSheet({ data, onClose, onClaimed }: { data: ClaimableResponse | null; onClose: () => void; onClaimed: (claimed: ClaimResponse['claimed']) => void }) {
  const me = useMeData();
  const [, navigate] = useLocation();
  const [saving, setSaving] = useState(false);
  const list = data?.candidates ?? [];
  const one = list.length === 1;

  const confirm = async () => {
    setSaving(true);
    try {
      const res = await participantApi.claim(list.map((c) => c.id));
      await refreshMe();
      haptic('success');
      toast.success(res.claimed.length > 1 ? 'Готово. QR-коды - в «Мои QR-коды»' : 'Готово. QR-код - в «Мои QR-коды»');
      onClaimed(res.claimed);
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={data !== null} onClose={onClose} title={list.length === 0 ? 'Никто другой вас не записывал' : one ? 'Это вы?' : 'Это вы и ваши близкие?'}>
      {list.length > 0 ? (
        <>
          <p className="mb-3 px-1 text-[15px] text-subtle">{one ? 'На ваш номер есть регистрация:' : 'На ваш номер есть регистрации:'}</p>
          <div className="mb-4 overflow-hidden rounded-2xl bg-fill px-4">
            {list.map((c) => (
              <div key={c.id} className="border-b border-line py-3 last:border-b-0">
                <p className="text-[17px] font-semibold leading-snug">{c.fullName}</p>
                <p className="text-[14px] text-subtle">записал(а) {c.registeredBy}</p>
              </div>
            ))}
          </div>
          <Button size="lg" block loading={saving} onClick={() => void confirm()}>
            {one ? 'Да, это я' : 'Да, это мы'}
          </Button>
          <Button variant="plain" block className="mt-2" disabled={saving} onClick={onClose}>
            Нет
          </Button>
          <p className="mt-2 px-1 text-center text-[13px] leading-snug text-hint">У того, кто записывал, регистрация тоже останется.</p>
        </>
      ) : (
        <>
          <p className="px-1 text-[15px] leading-snug">
            С других аккаунтов на номер {data?.phone ? displayPhone(data.phone) : 'из Telegram'} никого не записывали.
          </p>
          {me.registration.restored && (
            <p className="mt-2 px-1 text-[15px] leading-snug">
              🙏 Если вы регистрировались после 29 октября, просим прощения: из-за сбоя сервиса эти регистрации не сохранились. Пожалуйста,
              зарегистрируйтесь ещё раз.
            </p>
          )}
          <p className="mt-2 px-1 text-[15px] leading-snug text-subtle">
            Если вас записали на другой номер, попросите того, кто записывал, передать вам QR-код: «Мои QR-коды» → «⋯» → «Передать QR-код».
          </p>
          {me.registration.open && !hasSelf(me) && (
            <Button
              block
              className="mt-4"
              onClick={() => {
                onClose();
                navigate('/register');
              }}
            >
              Зарегистрироваться
            </Button>
          )}
          <Button variant="plain" block className="mt-2" onClick={onClose}>
            Закрыть
          </Button>
        </>
      )}
    </Sheet>
  );
}
