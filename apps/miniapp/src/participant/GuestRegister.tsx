import { CONSENT_LABEL, PRIVACY_POLICY_TEXT, formatRub, guestRegistrationSchema, type RegisteredByOtherDetails } from '@sof/shared';
import { IconCircleCheckFilled } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { ApiError, errorMessage } from '../api/client.ts';
import { refreshMe } from '../api/queries.ts';
import { haptic } from '../lib/feedback.ts';
import { uuid } from '../lib/ids.ts';
import { phoneForSubmit } from '../lib/masks.ts';
import { ensureWriteAccess } from '../telegram/actions.ts';
import { Button, Checkbox, FieldError, Notice } from '../ui/kit.tsx';
import { Page, StickyFooter } from '../ui/Page.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { hasSelf, participantApi, useMeData } from './api.ts';
import { PersonFields, type PersonDraft, type PersonErrors } from './PersonFields.tsx';

const empty = (): PersonDraft =>
  ({
    key: 'guest',
    relation: 'self',
    lastName: '',
    firstName: '',
    middleName: '',
    birthDate: '',
    gender: '',
    city: '',
    church: '',
    phone: '',
    phoneMode: 'by',
    telegramUsername: '',
    noTelegram: false,
    tier: 'fee10',
    breakfast: false,
    paymentMethod: 'cash',
  }) as PersonDraft;

/** Ошибки короткой формы - те же сообщения, что у полной анкеты. */
function check(p: PersonDraft): PersonErrors {
  const errors: PersonErrors = {};
  if (!p.lastName.trim()) errors.lastName = 'Укажите фамилию';
  if (!p.firstName.trim()) errors.firstName = 'Укажите имя';
  if (!p.gender) errors.gender = 'Выберите пол';
  const phone = phoneForSubmit(p.phoneMode, p.phone);
  if (!phone) errors.phone = 'Укажите телефон';
  else if (!guestRegistrationSchema.shape.phone.safeParse(phone).success) errors.phone = 'Проверьте номер';
  return errors;
}

/**
 * «Гость» на месте (день конференции): фамилия, имя, телефон, пол - и сразу QR-код.
 * Вариант «Только взнос», без питания, только за себя; взнос - на кассе.
 */
export default function GuestRegister() {
  const me = useMeData();
  const [, navigate] = useLocation();
  const [person, setPerson] = useState<PersonDraft>(empty);
  const [consent, setConsent] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [dup, setDup] = useState<RegisteredByOtherDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Ключ запроса: повтор (двойной тап, плохая сеть) не создаст второго участника. */
  const keyRef = useRef(uuid());
  const fee = me.registration.tiers.fee10;
  const errors = attempted ? check(person) : {};

  if (hasSelf(me) && !done) {
    return (
      <Page title="Регистрация" back="/">
        <Notice tone="green">
          Вы уже зарегистрированы - QR-код в разделе «Мои QR-коды». Друга на месте регистрируем с его телефона: пусть откроет бота и
          нажмёт «Регистрация».
        </Notice>
        <Button block className="mt-4" onClick={() => navigate('/tickets')}>
          Мои QR-коды
        </Button>
      </Page>
    );
  }

  if (done) {
    return (
      <Page title="Готово!" back="/">
        <div className="flex flex-col items-center py-6 text-center">
          <IconCircleCheckFilled size={64} className="text-ok" />
          <p className="mt-3 text-[20px] font-bold">Вы зарегистрированы</p>
          <p className="mt-1 text-[15px] text-subtle">
            QR-код уже в боте. Взнос {formatRub(fee.amount.toFixed(2))} - на кассе у входа или переводом: после перевода пришлите чек в бот.
          </p>
        </div>
        <StickyFooter>
          <Button size="lg" block onClick={() => navigate('/tickets')}>
            Мой QR-код
          </Button>
        </StickyFooter>
      </Page>
    );
  }

  const submit = async (notDuplicate = false) => {
    if (busy) return;
    setAttempted(true);
    if (Object.keys(check(person)).length > 0 || !consent) {
      haptic('error');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await ensureWriteAccess();
      await participantApi.registerGuest({
        idempotencyKey: keyRef.current,
        lastName: person.lastName.trim(),
        firstName: person.firstName.trim(),
        phone: phoneForSubmit(person.phoneMode, person.phone),
        gender: person.gender as 'm' | 'f',
        notDuplicate,
        consent: { pd: true, photo: false, documentVersion: me.registration.consentVersion },
      });
      await refreshMe().catch(() => undefined);
      haptic('success');
      setDone(true);
      window.scrollTo(0, 0);
    } catch (err) {
      haptic('error');
      if (err instanceof ApiError && err.code === 'registered_by_other') {
        setDup(err.details as RegisteredByOtherDetails);
      } else {
        // Данные поменяли - повтор с новым ключом, а не «ключ уже использован».
        keyRef.current = uuid();
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Регистрация на месте" subtitle={`Вариант «${fee.label}» - ${formatRub(fee.amount.toFixed(2))}, взнос на кассе`} back="/" bottomInset>
      <section className="mb-4 rounded-2xl bg-section px-4 pb-1 pt-4">
        <PersonFields
          person={person}
          errors={errors}
          onChange={(patch) => setPerson((p) => ({ ...p, ...patch }))}
          tiers={me.registration.tiers}
          ageRef=""
          withRelation={false}
          withPayment={false}
          offerContact
          guest
        />
      </section>

      <div className="mb-4 rounded-2xl bg-section px-3 py-2">
        <Checkbox checked={consent} invalid={attempted && !consent} onChange={setConsent}>
          {CONSENT_LABEL}
        </Checkbox>
        <button type="button" onClick={() => setPolicyOpen(true)} className="ml-9 pb-1 text-[14px] font-medium text-accent">
          Как мы обращаемся с данными
        </button>
        {attempted && !consent && (
          <div className="ml-8 pb-1">
            <FieldError>Без согласия зарегистрировать не получится</FieldError>
          </div>
        )}
      </div>
      <Sheet open={policyOpen} onClose={() => setPolicyOpen(false)} title="Персональные данные">
        <p className="whitespace-pre-line pb-2 text-[15px] leading-relaxed">{PRIVACY_POLICY_TEXT}</p>
        <Button
          block
          className="mt-3"
          onClick={() => {
            setConsent(true);
            setPolicyOpen(false);
          }}
        >
          Согласен(на)
        </Button>
      </Sheet>

      {dup && (
        <Notice tone="yellow" className="mb-4">
          Похоже, вас уже зарегистрировал(а) {dup.registeredBy}. Если это не вы -
          <button type="button" className="ml-1 font-semibold text-accent" onClick={() => void submit(true)}>
            всё равно зарегистрировать
          </button>
          .
        </Notice>
      )}
      {error && (
        <Notice tone="red" className="mb-4">
          {error}
        </Notice>
      )}

      <StickyFooter>
        <Button size="lg" block loading={busy} onClick={() => void submit()}>
          Зарегистрироваться
        </Button>
      </StickyFooter>
    </Page>
  );
}
