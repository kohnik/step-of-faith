import {
  CONSENT_LABEL,
  DEFAULT_BREAKFAST,
  DEFAULT_CITY,
  PRIVACY_POLICY_TEXT,
  TIERS,
  breakfastAllowed,
  isFreeTier,
  formatRub,
  participantInputSchema,
  priceOf,
  type ParticipantInput,
  type MeResponse,
  type RegisteredByOtherDetails,
  type RegistrationResult,
  type RegistrationSubmit,
} from '@sof/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { IconCircleCheckFilled, IconUserPlus } from '@tabler/icons-react';
import { ApiError, errorMessage } from '../api/client.ts';
import { fetchMe, refreshMe, setMe } from '../api/queries.ts';
import { haptic } from '../lib/feedback.ts';
import { quickHash, sleep, uuid } from '../lib/ids.ts';
import { parseBirthDate, phoneForSubmit } from '../lib/masks.ts';
import { local, session } from '../lib/storage.ts';
import { plural } from '../lib/time.ts';
import { ensureWriteAccess } from '../telegram/actions.ts';
import { setClosingConfirmation, setVerticalSwipes, telegramUser } from '../telegram/sdk.ts';
import { useMainButton } from '../telegram/main-button.ts';
import { Button, Card, Checkbox, FieldError, Notice, Section } from '../ui/kit.tsx';
import { Page, StickyFooter } from '../ui/Page.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { ListGroup } from '../ui/List.tsx';
import { TierBadge, tierColor } from '../ui/TierBadge.tsx';
import { AFTER_REGISTER_KEY, feeDeadlineText, freeSlots, hasSelf as hasSelfIn, ownedActive, participantApi, paymentsOn, useMeData } from './api.ts';
import { useClaim } from './Claim.tsx';
import GuestRegister from './GuestRegister.tsx';
import {
  draftChecks,
  FIELD_LABELS,
  FIELD_ORDER,
  fieldAnchor,
  fieldMessage,
  isFieldEmpty,
  PersonFields,
  type FieldKey,
  type PersonDraft,
  type PersonErrors,
  usernameForSubmit,
} from './PersonFields.tsx';

// v7: «нет Телеграма» у ника - старые черновики другого формата не подхватываем.
const DRAFT_KEY = 'sof:reg-draft:v7';
const IDEM_KEY = 'sof:reg-idempotency';
/** Черновик и ключ запроса живут на устройстве до успеха (свайп вниз и повторное открытие их не теряют), но не дольше 3 дней. */
const KEEP_MS = 3 * 24 * 3600_000;
const scoped = (key: string) => `${key}:${telegramUser()?.id ?? 'anon'}`;
const draftStore = {
  getJSON<T>(key: string): T | null {
    const v = local.getJSON<{ at: number; value: T }>(scoped(key));
    return v && Date.now() - v.at < KEEP_MS ? v.value : null;
  },
  setJSON(key: string, value: unknown) {
    local.setJSON(scoped(key), { at: Date.now(), value });
  },
  remove(key: string) {
    local.remove(scoped(key));
  },
};
const sameName = (a: string, b: string) => a.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim() === b.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const RETRY_DELAYS = [1000, 2000, 4000, 8000];

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting'; attempt: number }
  | { kind: 'error'; message: string }
  | { kind: 'done'; result: RegistrationResult; writeAccess: 'allowed' | 'denied' | 'unknown' };

function newPerson(relation: PersonDraft['relation'], prefill: Partial<PersonDraft> = {}): PersonDraft {
  return {
    key: uuid(),
    lastName: '',
    firstName: '',
    middleName: '',
    birthDate: '',
    // Пол выбирают явно: с подставленным «Мужской» часть девушек так бы и осталась «мужчинами».
    gender: '',
    city: DEFAULT_CITY,
    church: '',
    phoneMode: 'by',
    phone: '',
    relation,
    telegramUsername: '',
    noTelegram: false,
    tier: '',
    breakfast: false,
    // По умолчанию - переводом. Если переводы в настройках выключены, переключателя нет, а сервер сам ставит «наличными».
    paymentMethod: 'transfer',
    ...prefill,
  };
}

/**
 * Черновик, сохранённый до появления галочки завтрака: вариант «с завтраком» (fee45) стал
 * «Взнос и питание» + завтрак, неизвестный вариант - выбрать заново. Остальное - как было.
 */
function upgradeDraft(p: PersonDraft): PersonDraft {
  const saved = p.tier as string;
  if (saved === 'fee45') return { ...p, tier: 'fee35', breakfast: true };
  const tier = (TIERS as readonly string[]).includes(saved) ? p.tier : '';
  return { ...p, tier, breakfast: Boolean(p.breakfast) && breakfastAllowed(tier) };
}

function toPayload(p: PersonDraft) {
  const date = parseBirthDate(p.birthDate);
  return {
    lastName: p.lastName,
    firstName: p.firstName,
    middleName: p.middleName.trim() || null,
    birthDate: 'iso' in date ? date.iso : '',
    gender: p.gender,
    city: p.city,
    church: p.church,
    phone: phoneForSubmit(p.phoneMode, p.phone),
    relation: p.relation,
    telegramUsername: usernameForSubmit(p),
    tier: p.tier || undefined,
    breakfast: p.breakfast && breakfastAllowed(p.tier),
    paymentMethod: p.tier && !isFreeTier(p.tier) && p.paymentMethod ? p.paymentMethod : null,
  };
}

function validatePerson(p: PersonDraft): { data: ParticipantInput | null; errors: PersonErrors } {
  const res = participantInputSchema.safeParse(toPayload(p));
  const errors: PersonErrors = {};
  // Свои проверки даты и телефона точнее общих - их сообщения важнее.
  draftChecks(p, errors);
  // Обязательный телефон проверяем сразу: в общей схеме это superRefine, а он молчит, пока не заполнены остальные поля.
  if (!errors.phone && !p.phone.trim() && p.relation !== 'child') errors.phone = 'Укажите телефон';
  if (!res.success) {
    for (const issue of res.error.issues) {
      const field = issue.path[0] as FieldKey | undefined;
      if (field && !errors[field]) errors[field] = fieldMessage(field, issue.code, issue.message);
    }
  }
  return { data: res.success && Object.keys(errors).length === 0 ? res.data : null, errors };
}

/** Ошибки всех людей сразу (плюс «Я» может быть только один). */
function validateAll(
  people: PersonDraft[],
  hasSelf: boolean,
  tierLeft: MeResponse['registration']['tierLeft'] = {},
  breakfastLeft: number | null = null,
): Record<string, PersonErrors> {
  const out: Record<string, PersonErrors> = {};
  const selfCount = people.filter((p) => p.relation === 'self').length + (hasSelf ? 1 : 0);
  // Сколько человек в форме выбрали каждый вариант и завтрак - хватит ли оставшихся мест на всех.
  const picked = new Map<string, number>();
  for (const p of people) if (p.tier) picked.set(p.tier, (picked.get(p.tier) ?? 0) + 1);
  const withBreakfast = people.filter((p) => p.breakfast && breakfastAllowed(p.tier)).length;
  for (const p of people) {
    const { errors } = validatePerson(p);
    if (selfCount > 1 && p.relation === 'self') errors.relation = '«Я» может быть только один';
    const left = p.tier ? tierLeft?.[p.tier] : undefined;
    if (!errors.tier && left !== undefined && (picked.get(p.tier) ?? 0) > left) {
      errors.tier = left > 0 ? `В этом варианте осталось мест: ${left} - выберите другой кому-то из участников` : 'Мест в этом варианте больше нет - выберите другой';
    }
    if (p.breakfast && breakfastAllowed(p.tier) && breakfastLeft !== null && withBreakfast > breakfastLeft) {
      errors.breakfast =
        breakfastLeft > 0
          ? `Завтраков осталось: ${breakfastLeft} - снимите галочку кому-то из участников`
          : 'Завтраков больше нет - снимите галочку';
    }
    if (Object.keys(errors).length) out[p.key] = errors;
  }
  return out;
}

const CONSENT_ANCHOR = 'consent';
const DUP_ANCHOR = 'registered-by-other';

/** Прокрутить к полю и поставить курсор в текстовое поле (кнопки-переключатели не фокусируем). */
function goToField(anchor: string) {
  const el = document.getElementById(anchor);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const input = el.querySelector<HTMLInputElement>('input:not([type=checkbox]):not([type=hidden])');
  if (input) window.setTimeout(() => input.focus({ preventScroll: true }), 350);
}

/**
 * Ключ идемпотентности живёт в sessionStorage до успеха: повтор после обрыва связи уходит с тем же
 * ключом, и сервер вернёт уже сохранённый результат. Если данные формы изменились - ключ новый
 * (с тем же ключом сервер ответил бы idempotency_mismatch).
 */
function idempotencyKeyFor(payloadHash: string, forceNew = false): string {
  const stored = draftStore.getJSON<{ key: string; hash: string }>(IDEM_KEY);
  if (!forceNew && stored && stored.hash === payloadHash) return stored.key;
  const key = uuid();
  draftStore.setJSON(IDEM_KEY, { key, hash: payloadHash });
  return key;
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return err.status === 0 || err.status === 429 || err.status >= 500 || (err.status === 409 && err.code === 'in_progress');
}

export default function Register() {
  const me = useMeData();
  // День конференции: вместо анкеты - короткая форма «Гость».
  if (me.registration.onSite) return <GuestRegister />;
  return <FullRegister />;
}

function FullRegister() {
  const me = useMeData();
  const [, navigate] = useLocation();
  const owned = ownedActive(me);
  // «Я» уже есть: записался сам или его записал кто-то другой (узнали по нику / передали QR-код).
  const hasSelf = hasSelfIn(me);
  const tiers = me.registration.tiers;
  // Данные с телефона, сохранённые до появления завтрака, - с настройками по умолчанию, пока не придут свежие.
  const breakfastCfg = me.registration.breakfast ?? DEFAULT_BREAKFAST;
  const breakfastLeft = me.registration.breakfastLeft ?? null;
  const ageRef = (me.event.startsAt ?? new Date().toISOString()).slice(0, 10);
  const slots = freeSlots(me);
  const payments = paymentsOn(me);

  const [people, setPeople] = useState<PersonDraft[]>(() => {
    const saved = draftStore.getJSON<PersonDraft[]>(DRAFT_KEY);
    if (saved && saved.length > 0) return saved.slice(0, Math.max(1, slots)).map(upgradeDraft);
    // Имя и фамилию из Telegram не подставляем: там бывает латиница, а поиск на входе - по-русски.
    if (!hasSelf) return [newPerson('self')];
    // «Я» уже записан - дальше записывают других: их фамилию и имя не подставляем.
    return [newPerson('', { church: owned[0]?.church ?? '' })];
  });
  // Вариант или завтрак выключили в настройках, а в черновике он выбран - выбираем заново (сервер его не примет).
  const tiersOff = TIERS.filter((t) => tiers[t].enabled === false).join(',');
  const breakfastOff = breakfastCfg.enabled === false;
  useEffect(() => {
    setPeople((list) => {
      let changed = false;
      const next = list.map((p) => {
        const tierOff = p.tier !== '' && tiers[p.tier].enabled === false;
        const dropBreakfast = breakfastOff && p.breakfast;
        if (!tierOff && !dropBreakfast) return p;
        changed = true;
        return { ...p, tier: tierOff ? '' : p.tier, breakfast: tierOff || dropBreakfast ? false : p.breakfast };
      });
      return changed ? next : list;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiersOff, breakfastOff]);
  const [consent, setConsent] = useState(false);
  /** «Готов(а) оплатить за того, у кого нет возможности» - одна галочка на анкету. */
  const [sponsorOffer, setSponsorOffer] = useState(false);
  /** Нажимали «Зарегистрироваться» - теперь показываем и незаполненные поля. */
  const [attempted, setAttempted] = useState(false);
  /** С каких полей человек уже ушёл - для них сразу показываем ошибки формата. */
  const [touched, setTouched] = useState<Record<string, FieldKey[]>>({});
  const [policyOpen, setPolicyOpen] = useState(false);
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const submitting = useRef(false);
  /** «Я» уже записан с другого аккаунта (совпали телефон, фамилия и имя). */
  const [dup, setDup] = useState<RegisteredByOtherDetails | null>(null);

  // Нашли свою регистрацию по номеру и забрали - «Я» из формы убираем, остальных можно дорегистрировать.
  const claim = useClaim({
    onClaimed: (claimed) => {
      setDup(null);
      // Забрали всех, кто записан на этот номер (часто вся семья) - их из формы тоже убираем, иначе запишем второй раз.
      const rest = people.filter(
        (p) => p.relation !== 'self' && !claimed.some((c) => sameName(c.fullName, [p.lastName, p.firstName, p.middleName].filter(Boolean).join(' ')) || sameName(c.fullName.split(' ').slice(0, 2).join(' '), `${p.lastName} ${p.firstName}`)),
      );
      if (rest.length === 0) {
        draftStore.remove(DRAFT_KEY);
        navigate('/tickets');
        return;
      }
      setPeople(rest);
      setState({ kind: 'idle' });
    },
  });

  useEffect(() => {
    if (state.kind !== 'done') draftStore.setJSON(DRAFT_KEY, people);
  }, [people, state.kind]);

  // Пока форма заполняется, свайп вниз не закрывает приложение, а закрытие спрашивает подтверждение.
  const dirty = state.kind !== 'done' && people.some((p) => p.lastName.trim() || p.firstName.trim() || p.birthDate.trim());
  useEffect(() => {
    setVerticalSwipes(false);
    return () => setVerticalSwipes(true);
  }, []);
  useEffect(() => {
    setClosingConfirmation(dirty);
    return () => setClosingConfirmation(false);
  }, [dirty]);

  const update = useCallback((key: string, patch: Partial<PersonDraft>) => {
    setPeople((ps) =>
      ps.map((p) => {
        if (p.key !== key) return p;
        return { ...p, ...patch };
      }),
    );
  }, []);

  const markTouched = useCallback((key: string, field: FieldKey) => {
    setTouched((t) => (t[key]?.includes(field) ? t : { ...t, [key]: [...(t[key] ?? []), field] }));
  }, []);

  // Проверяем на лету, но показываем мягко: «не заполнено» - только после нажатия кнопки,
  // ошибки формата (дата, телефон, ник) - когда человек ушёл с поля. Исправил - ошибка сразу пропадает.
  const allErrors = useMemo(
    () => validateAll(people, hasSelf, me.registration.tierLeft, breakfastLeft),
    [people, hasSelf, me.registration.tierLeft, breakfastLeft],
  );
  const errors = useMemo(() => {
    const out: Record<string, PersonErrors> = {};
    for (const p of people) {
      const all = allErrors[p.key];
      if (!all) continue;
      const shown: PersonErrors = {};
      for (const [f, msg] of Object.entries(all) as [FieldKey, string][]) {
        if (attempted || (touched[p.key]?.includes(f) && !isFieldEmpty(p, f))) shown[f] = msg;
      }
      out[p.key] = shown;
    }
    return out;
  }, [people, allErrors, attempted, touched]);
  const consentError = attempted && !consent;

  /** Сводка над кнопкой: что осталось, с переходом к полю. */
  const summary = useMemo(() => {
    if (!attempted) return [];
    const items: { anchor: string; label: string }[] = [];
    people.forEach((p, idx) => {
      const errs = allErrors[p.key];
      if (!errs) return;
      const who = p.relation === 'self' ? 'Я' : [p.lastName, p.firstName].filter(Boolean).join(' ') || `Участник ${idx + 1}`;
      for (const f of FIELD_ORDER) {
        if (errs[f]) items.push({ anchor: fieldAnchor(p.key, f), label: people.length > 1 ? `${who}: ${FIELD_LABELS[f].toLowerCase()}` : FIELD_LABELS[f] });
      }
    });
    if (!consent) items.push({ anchor: CONSENT_ANCHOR, label: 'Согласие на обработку данных' });
    return items;
  }, [attempted, people, allErrors, consent]);

  const addPerson = () => {
    if (people.length >= slots) return;
    haptic('light');
    // Город, церковь и способ оплаты берём у первого - чаще всего совпадают. Фамилию - нет: это другой человек.
    setPeople((ps) => {
      const first = ps[0];
      return [
        ...ps,
        newPerson('', {
          city: first?.city || DEFAULT_CITY,
          church: first?.church ?? '',
          paymentMethod: first?.paymentMethod ?? '',
        }),
      ];
    });
    window.setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 50);
  };

  const removePerson = (key: string) => {
    setPeople((ps) => (ps.length > 1 ? ps.filter((p) => p.key !== key) : ps));
  };

  const submit = () => doSubmit(false);
  /** «Это не я» - такой же человек с другого аккаунта, но это другой человек. */
  const submitAnyway = () => doSubmit(true);

  const doSubmit = async (notDuplicate: boolean) => {
    if (submitting.current) return;
    if (state.kind === 'done') {
      navigate('/tickets');
      return;
    }
    // Проверяем всё сразу - и людей, и согласие, чтобы не всплывало по одной ошибке за нажатие.
    setAttempted(true);
    const checked = people.map((p) => validatePerson(p));
    const firstBad = people.find((p) => allErrors[p.key]);
    if (firstBad || !consent || checked.some((c) => !c.data)) {
      haptic('error');
      const errs = firstBad ? allErrors[firstBad.key]! : {};
      const firstField = FIELD_ORDER.find((f) => errs[f]);
      goToField(firstBad && firstField ? fieldAnchor(firstBad.key, firstField) : CONSENT_ANCHOR);
      return;
    }
    const participants = checked.map((c) => c.data!);

    submitting.current = true;
    setDup(null);
    setState({ kind: 'submitting', attempt: 1 });
    const ownedBefore = new Set(ownedActive(me).map((p) => p.id));
    try {
      const writeAccess = await ensureWriteAccess();
      const payloadHash = quickHash(JSON.stringify({ participants }));
      let body: RegistrationSubmit = {
        idempotencyKey: idempotencyKeyFor(payloadHash),
        participants,
        notDuplicate,
        sponsorOffer,
        consent: { pd: true, photo: false, documentVersion: me.registration.consentVersion },
      };
      let regenerated = false;
      let attempt = 1;
      let result: RegistrationResult | null = null;
      while (!result) {
        try {
          result = await participantApi.register(body);
        } catch (err) {
          if (err instanceof ApiError && err.status === 422 && err.code === 'idempotency_mismatch' && !regenerated) {
            regenerated = true;
            body = { ...body, idempotencyKey: idempotencyKeyFor(payloadHash, true) };
            continue;
          }
          if (!isTransient(err) || attempt > RETRY_DELAYS.length) throw err;
          await sleep(RETRY_DELAYS[attempt - 1]! + Math.random() * 400);
          attempt += 1;
          setState({ kind: 'submitting', attempt });
        }
      }
      draftStore.remove(IDEM_KEY);
      draftStore.remove(DRAFT_KEY);
      // Ждём свежие данные: экран «QR-коды» сразу после успеха должен их показать.
      await refreshMe().catch(() => undefined);
      haptic('success');
      setState({ kind: 'done', result, writeAccess });
      window.scrollTo(0, 0);
    } catch (err) {
      haptic('error');
      if (err instanceof ApiError && err.code === 'registered_by_other') {
        setDup(err.details as RegisteredByOtherDetails);
        setState({ kind: 'idle' });
        window.setTimeout(() => document.getElementById(DUP_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
      } else if (isTransient(err) && (await registeredMeanwhile(ownedBefore))) {
        // Ответ потерялся, но регистрация прошла: показываем результат, а не ошибку - иначе после
        // правки опечатки человек запишется второй раз.
        return;
      } else {
        if (err instanceof ApiError && (err.code === 'tier_full' || err.code === 'breakfast_full' || err.code === 'capacity_full')) void refreshMe();
        setState({ kind: 'error', message: errorMessage(err) });
      }
    } finally {
      submitting.current = false;
    }
  };

  /** После сетевой ошибки: появились ли у аккаунта новые люди (запрос дошёл, потерялся только ответ). */
  async function registeredMeanwhile(ownedBefore: Set<number>): Promise<boolean> {
    try {
      const fresh = await fetchMe();
      setMe(fresh);
      const created = ownedActive(fresh).filter((p) => !ownedBefore.has(p.id));
      if (created.length === 0) return false;
      draftStore.remove(IDEM_KEY);
      draftStore.remove(DRAFT_KEY);
      haptic('success');
      setState({
        kind: 'done',
        result: { created: created.map((p) => ({ id: p.id, fullName: p.fullName, ticketCode: p.ticket?.code ?? '' })), skipped: [] },
        writeAccess: 'unknown',
      });
      window.scrollTo(0, 0);
      return true;
    } catch {
      return false;
    }
  }

  const busy = state.kind === 'submitting';
  const count = people.length;
  const buttonText =
    state.kind === 'done'
      ? state.result.created.length > 1
        ? 'Показать QR-коды'
        : 'Показать QR-код'
      : count > 1
        ? `Зарегистрировать всех (${count})`
        : 'Зарегистрироваться';
  const canUseForm = me.registration.open && slots > 0;
  const native = useMainButton({ text: buttonText, visible: canUseForm || state.kind === 'done', loading: busy, onClick: submit });

  // Итог к оплате по черновикам формы: у каждого свой вариант и завтрак.
  const dues = people
    .filter((p) => p.tier)
    .map((p) => {
      const tier = p.tier as Exclude<typeof p.tier, ''>;
      const breakfast = p.breakfast && breakfastAllowed(tier);
      return {
        key: p.key,
        name: [p.lastName, p.firstName].filter(Boolean).join(' ') || 'Без имени',
        tier,
        breakfast,
        amount: priceOf({ tiers, breakfast: breakfastCfg }, tier, breakfast),
        method: p.paymentMethod,
      };
    });
  const total = dues.reduce((sum, d) => sum + d.amount, 0);
  const anyCash = dues.some((d) => d.amount > 0 && d.method === 'cash');
  const anyTransfer = me.payment.transfers && dues.some((d) => d.amount > 0 && d.method === 'transfer');

  if (state.kind === 'done') {
    const { created, skipped } = state.result;
    const createdPeople = created.map((c) => me.participants.find((p) => p.id === c.id));
    const toPay = createdPeople.filter((p) => p && p.paymentStatus === 'unpaid');
    const toPayTotal = toPay.reduce((sum, p) => sum + Number(p?.amountDue ?? 0), 0);
    const many = created.length > 1;
    const only = createdPeople[0];
    const title = many
      ? 'Регистрация готова'
      : only?.relation === 'self' || !only
        ? 'Вы зарегистрированы'
        : `${only.firstName} ${only.gender === 'f' ? 'зарегистрирована' : 'зарегистрирован'}`;
    const subtitle =
      state.writeAccess === 'denied'
        ? `Бот не может вам написать, поэтому ${many ? 'QR-коды есть' : 'QR-код есть'} только в приложении.`
        : many
          ? 'QR-коды для входа отправили в чат с ботом.'
          : 'QR-код для входа отправили в чат с ботом.';
    return (
      <Page back="/" bottomInset={!native}>
        {created.length > 0 ? (
          <div className="mb-6 px-1 pt-8 text-center">
            <IconCircleCheckFilled size={56} className="mx-auto text-ok" aria-hidden />
            <h1 className="mt-3 font-display text-[21px] font-semibold leading-tight">{title}</h1>
            <p className="mx-auto mt-1.5 max-w-xs text-[15px] leading-snug text-subtle">{subtitle}</p>
          </div>
        ) : (
          <div className="mb-6 px-1 pt-8 text-center">
            <h1 className="font-display text-[21px] font-semibold leading-tight">Уже зарегистрированы</h1>
            <p className="mt-1.5 text-[15px] text-subtle">Новых записей нет.</p>
          </div>
        )}

        {many && (
          <ListGroup className="mb-4">
            {created.map((c, i) => {
              const p = createdPeople[i];
              return (
                <div key={c.id} className="group flex items-stretch gap-3 pl-4">
                  <span aria-hidden className="my-3 w-1 shrink-0 rounded-full" style={{ background: tierColor(p?.tier, tiers) ?? 'var(--color-line)' }} />
                  <div className="min-w-0 flex-1 border-b border-line py-3 pr-4 group-last:border-b-0">
                    <p className="truncate text-[16px] font-semibold">{c.fullName}</p>
                    {p?.tier && tiers[p.tier] && (
                      <p className="text-[14px] text-subtle">
                        {tiers[p.tier].label}
                        {p.breakfast ? ' + завтрак' : ''}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </ListGroup>
        )}

        {skipped.length > 0 && (
          <p className="mb-4 px-1 text-[14px] leading-snug text-subtle">
            {skipped.length > 1 ? 'Уже были зарегистрированы: ' : 'Уже был(а) зарегистрирован(а): '}
            {skipped.map((x) => x.fullName).join(', ')}.
          </p>
        )}

        {payments && toPay.length > 0 && (
          <Card className="mb-4">
            <p className="text-[14px] text-subtle">Взнос</p>
            <p className="mt-0.5 font-display text-[24px] font-semibold leading-tight">{formatRub(toPayTotal)}</p>
            <p className="mt-1 text-[14px] text-subtle">{feeDeadlineText(me)}</p>
            <Button variant="secondary" block className="mt-3" onClick={() => navigate('/payment')}>
              Как оплатить
            </Button>
          </Card>
        )}

        {created.length > 0 && session.get(AFTER_REGISTER_KEY) === '/seminars' && (
          <Button
            block
            className="mb-2"
            onClick={() => {
              session.remove(AFTER_REGISTER_KEY);
              navigate('/seminars');
            }}
          >
            Выбрать семинары
          </Button>
        )}
        <Button variant="plain" block onClick={() => navigate('/')}>
          На главную
        </Button>
        {!native && (
          <StickyFooter>
            <Button size="lg" block onClick={() => navigate('/tickets')}>
              {buttonText}
            </Button>
          </StickyFooter>
        )}
      </Page>
    );
  }

  if (!me.registration.open) {
    return (
      <Page title="Регистрация" back="/">
        <Notice tone="yellow">Регистрация закрыта. Если нужно что-то изменить, напишите организаторам.</Notice>
      </Page>
    );
  }
  if (slots === 0) {
    return (
      <Page title="Регистрация" back="/">
        <Notice tone="yellow">
          С одного Telegram можно записать до {me.registration.maxPerAccount}{' '}
          {plural(me.registration.maxPerAccount, ['человека', 'человек', 'человек'])}, и все места уже заняты. Остальные могут
          зарегистрироваться со своего Telegram.
        </Notice>
      </Page>
    );
  }

  const capacityLeft = me.registration.capacityLeft;
  const selfTaken = hasSelf || people.some((p) => p.relation === 'self');

  return (
    <Page
      title="Регистрация"
      subtitle={slots > 1 ? `Можно записать до ${slots} ${plural(slots, ['человека', 'человек', 'человек'])}: себя, семью, друзей.` : undefined}
      back="/"
      bottomInset={!native}
    >
      {capacityLeft !== null && capacityLeft < count && (
        <Notice tone="red" className="mb-4">
          {capacityLeft > 0 ? `Осталось мест: ${capacityLeft}. Уберите лишних.` : 'Мест больше нет'}
        </Notice>
      )}

      {people.map((p, idx) => (
        <section key={p.key} id={`person-${p.key}`} className="mb-4 scroll-mt-4">
          <div className="mb-2 flex items-center justify-between px-1">
            <h2 className="text-lg font-bold">{p.relation === 'self' ? 'Я' : `Участник ${idx + 1}`}</h2>
            {count > 1 && (
              <button type="button" onClick={() => removePerson(p.key)} className="h-9 px-2 text-[15px] font-medium text-danger">
                Убрать
              </button>
            )}
          </div>
          <Card>
            <PersonFields
              person={p}
              errors={errors[p.key] ?? {}}
              onChange={(patch) => update(p.key, patch)}
              onBlurField={(f) => markTouched(p.key, f)}
              tiers={tiers}
              ageRef={ageRef}
              withPayment={payments}
              transfers={me.payment.transfers}
              allowSelf={!selfTaken || p.relation === 'self'}
              offerContact={p.relation === 'self'}
              tierLeft={me.registration.tierLeft}
              breakfast={breakfastCfg}
              breakfastLeft={breakfastLeft}
              onContact={p.relation === 'self' ? (c) => void claim.check(c, true) : undefined}
            />
          </Card>
        </section>
      ))}

      {count < slots && (
        <Button variant="secondary" block className="mb-5" onClick={addPerson} disabled={busy}>
          <IconUserPlus size={20} />
          Добавить ещё человека
        </Button>
      )}

      {state.kind === 'submitting' && state.attempt > 1 && (
        <Notice tone="yellow" className="mb-3">
          Плохая связь, пробуем ещё раз (попытка {state.attempt} из {RETRY_DELAYS.length + 1})
        </Notice>
      )}
      {state.kind === 'error' && (
        <Notice tone="red" className="mb-3">
          {state.message}
        </Notice>
      )}
      {dup && (
        <div id={DUP_ANCHOR} className="mb-4 scroll-mt-24 rounded-2xl bg-section p-4">
          <p className="text-[17px] font-semibold leading-snug">Похоже, вас уже зарегистрировали</p>
          <div className="mt-3 rounded-xl bg-fill px-3 py-2.5">
            <p className="text-[16px] font-semibold leading-snug">{dup.fullName}</p>
            <p className="text-[14px] text-subtle">записал(а) {dup.registeredBy}</p>
          </div>
          {claim.available && (
            <p className="mt-3 text-[15px] leading-snug text-subtle">
              Подтвердите номер через Telegram, и эта регистрация станет вашей. Второй раз записываться не нужно.
            </p>
          )}
          {claim.available && (
            <Button block className="mt-3" loading={claim.busy} onClick={() => void claim.start()}>
              Подтвердить номер
            </Button>
          )}
          <Button variant="plain" block className="mt-2" disabled={busy} onClick={() => void submitAnyway()}>
            Это не я, зарегистрировать
          </Button>
        </div>
      )}

      {payments && dues.length > 0 && (
        <Section title="Взнос">
          <Card>
            {dues.map((d) => (
              <div key={d.key} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{d.name}</span>
                  <TierBadge tier={d.tier} tiers={tiers} breakfast={d.breakfast} size="sm" className="mt-0.5" />
                </span>
                <span className="shrink-0 font-semibold">{d.amount > 0 ? formatRub(d.amount) : '-'}</span>
              </div>
            ))}
            {dues.length > 1 && (
              <div className="mt-1 flex items-center justify-between border-t border-line pt-2 text-[17px] font-bold">
                <span>Всего</span>
                <span>{formatRub(total)}</span>
              </div>
            )}
          </Card>
          {total > 0 && (
            <p className="mt-2 px-1 text-[13px] leading-snug text-hint">
              {feeDeadlineText(me)}
              {anyTransfer && ' Реквизиты для перевода будут в разделе «Оплата».'}
              {anyCash && ` Наличными: ${me.payment.cash.charAt(0).toLowerCase()}${me.payment.cash.slice(1)}`}
            </p>
          )}
        </Section>
      )}

      {payments && (
        <div className="mb-3 rounded-2xl bg-section px-3 py-2">
          <Checkbox checked={sponsorOffer} onChange={setSponsorOffer}>
            Если у тебя есть желание оплатить регистрацию человека, который не имеет финансовой возможности покрыть расходы
            самостоятельно – отметь данный пункт.
            <span className="mt-0.5 block text-[13px] text-hint">В случае необходимости с тобой свяжутся.</span>
          </Checkbox>
        </div>
      )}

      <div id={CONSENT_ANCHOR} className="mb-4 scroll-mt-24 rounded-2xl bg-section px-3 py-2">
        <Checkbox checked={consent} invalid={consentError} onChange={setConsent}>
          {CONSENT_LABEL}
        </Checkbox>
        <button type="button" onClick={() => setPolicyOpen(true)} className="ml-9 pb-1 text-[14px] font-medium text-accent">
          Как мы обращаемся с данными
        </button>
        {consentError && (
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

      {summary.length > 0 && (
        <div role="alert" className="mb-4 animate-error-in rounded-2xl bg-bad-soft px-4 py-3 text-bad-fg">
          <p className="text-[15px] font-semibold">
            {summary.length === 1 ? 'Осталось одно поле' : `Осталось заполнить: ${summary.length} ${plural(summary.length, ['поле', 'поля', 'полей'])}`}
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {summary.map((it) => (
              <li key={it.anchor}>
                <button
                  type="button"
                  onClick={() => goToField(it.anchor)}
                  className="min-h-8 rounded-full bg-section/70 px-3 text-left text-[14px] font-medium text-bad-fg underline-offset-2 active:opacity-70"
                >
                  {it.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="px-1 text-[13px] text-hint">
        {count > 1 ? 'После регистрации QR-коды для входа придут в чат с ботом.' : 'После регистрации QR-код для входа придёт в чат с ботом.'}
      </p>

      {!native && (
        <StickyFooter>
          <Button size="lg" block loading={busy} onClick={() => void submit()}>
            {buttonText}
          </Button>
        </StickyFooter>
      )}
      {claim.sheet}
    </Page>
  );
}
