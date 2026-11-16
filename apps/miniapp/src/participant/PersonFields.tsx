import {
  MIN_AGE,
  REG_PAYMENT_METHOD_LABELS,
  REG_PAYMENT_METHODS,
  RELATION_LABELS,
  RELATION_OPTIONS,
  TIERS,
  ageOn,
  breakfastAllowed,
  formatRub,
  textOn,
  type BreakfastConfig,
  type Gender,
  type RegPaymentMethod,
  type Relation,
  type Tier,
  type TiersConfig,
} from '@sof/shared';
import { useState } from 'react';
import { IconCheck, IconChevronDown, IconDeviceMobile, IconWorld } from '@tabler/icons-react';
import {
  formatIntlPhone,
  formatPhoneLocal,
  isPhoneFieldComplete,
  maskBirthDate,
  parseBirthDate,
  phoneFieldChange,
  phoneFieldFromStored,
  PHONE_COUNTRIES,
  type PhoneMode,
} from '../lib/masks.ts';
import { canRequestContact, requestContactFromTelegram, type TelegramContact } from '../telegram/actions.ts';
import { plural } from '../lib/time.ts';
import { Checkbox, cx, Field, FieldError, invalidRing, TextInput } from '../ui/kit.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { toast } from '../ui/toast.tsx';

/** Церковь-хозяйка - подсказка одним нажатием. */
export const HOME_CHURCH = 'Благодать';

export interface PersonDraft {
  key: string;
  lastName: string;
  firstName: string;
  /** В форме не показываем; остаётся для старых записей. */
  middleName: string;
  /** Как ввели: «17.05.1990». На сервер уходит `YYYY-MM-DD`. */
  birthDate: string;
  gender: Gender | '';
  /** Населённый пункт. */
  city: string;
  church: string;
  /** 'by' - белорусская маска, 'intl' - номер другой страны. */
  phoneMode: PhoneMode;
  /** 'by': 9 цифр после +375; 'intl': все цифры с кодом страны. */
  phone: string;
  relation: Relation | '';
  /** Ник в Telegram (для друга/родственника), без @. */
  telegramUsername: string;
  /** «Нет Телеграма или не знаю ник» - тогда ник не нужен: человек найдёт себя в боте по номеру телефона. */
  noTelegram: boolean;
  tier: Tier | '';
  /** Завтрак к платному варианту (+цена завтрака). */
  breakfast: boolean;
  paymentMethod: RegPaymentMethod | '';
}

export type FieldKey =
  | 'lastName'
  | 'firstName'
  | 'middleName'
  | 'birthDate'
  | 'gender'
  | 'city'
  | 'church'
  | 'phone'
  | 'relation'
  | 'telegramUsername'
  | 'tier'
  | 'breakfast'
  | 'paymentMethod';
export type PersonErrors = Partial<Record<FieldKey, string>>;

/** Порядок полей в форме - первая ошибка по нему получает фокус. */
export const FIELD_ORDER: FieldKey[] = [
  'relation',
  'lastName',
  'firstName',
  'birthDate',
  'phone',
  'gender',
  'city',
  'church',
  'telegramUsername',
  'tier',
  'breakfast',
  'paymentMethod',
];

/** Названия полей для сводки ошибок. */
export const FIELD_LABELS: Record<FieldKey, string> = {
  relation: 'Кто это',
  lastName: 'Фамилия',
  firstName: 'Имя',
  middleName: 'Отчество',
  birthDate: 'Дата рождения',
  phone: 'Телефон',
  gender: 'Пол',
  city: 'Населённый пункт',
  church: 'Церковь',
  telegramUsername: 'Ник в Telegram',
  tier: 'Вариант участия',
  breakfast: 'Завтрак',
  paymentMethod: 'Способ оплаты',
};

/** id обёртки поля - для прокрутки к нему из сводки ошибок. */
export const fieldAnchor = (personKey: string, field: FieldKey) => `f-${personKey}-${field}`;

/** Пустое ли поле: «не заполнено» показываем только после нажатия кнопки, ошибки формата - сразу при уходе с поля. */
export function isFieldEmpty(p: PersonDraft, field: FieldKey): boolean {
  const v = p[field as keyof PersonDraft];
  return typeof v !== 'string' || v.trim() === '';
}

/** Текст ошибки для поля по коду ошибки zod (общая схема из @sof/shared). */
export function fieldMessage(field: FieldKey, code: string, message?: string): string {
  if (code === 'too_big') return 'Слишком длинно';
  switch (field) {
    case 'lastName':
      return 'Напишите фамилию';
    case 'firstName':
      return 'Напишите имя';
    case 'birthDate':
      return 'Укажите дату рождения';
    case 'gender':
      return 'Выберите пол';
    case 'city':
      return 'Напишите населённый пункт';
    case 'church':
      return 'Напишите, в какую церковь ходите';
    case 'relation':
      return 'Выберите, кто это';
    case 'tier':
      return 'Выберите вариант участия';
    case 'paymentMethod':
      return 'Выберите, как внесёте взнос';
    case 'phone':
      return message && code === 'custom' ? message : 'Укажите телефон';
    case 'telegramUsername':
      return code === 'custom' && message ? message : 'Укажите ник или отметьте, что его нет';
    default:
      return 'Проверьте поле';
  }
}

/** Ник нужен у всех, кроме «Я»: указан или отмечено «нет Телеграма». Сервер ник не требует - это подсказка формы. */
export function needsUsername(p: Pick<PersonDraft, 'relation' | 'telegramUsername' | 'noTelegram'>): boolean {
  return p.relation !== '' && p.relation !== 'self' && !p.noTelegram && !p.telegramUsername.trim();
}

/** Ник, который уходит на сервер. */
export function usernameForSubmit(p: Pick<PersonDraft, 'relation' | 'telegramUsername' | 'noTelegram'>): string | null {
  return p.relation !== 'self' && !p.noTelegram && p.telegramUsername.trim() ? p.telegramUsername.trim() : null;
}

/** Проверки поверх общей схемы: настоящая дата рождения, полный номер телефона, ник или «нет Телеграма». */
export function draftChecks(
  p: Pick<PersonDraft, 'birthDate' | 'phone' | 'phoneMode' | 'relation' | 'telegramUsername' | 'noTelegram'>,
  errors: PersonErrors,
): void {
  if (needsUsername(p)) errors.telegramUsername = 'Укажите ник или отметьте, что его нет';
  const date = parseBirthDate(p.birthDate);
  if ('error' in date) errors.birthDate = date.error;
  if (p.phone && !isPhoneFieldComplete(p.phoneMode, p.phone)) {
    errors.phone = p.phoneMode === 'by' ? 'Номер неполный' : 'Нужен номер с кодом страны, от 8 до 15 цифр';
  }
}

/** Телефон из сохранённого значения для формы. */
export function phoneDraft(stored: string | null | undefined): Pick<PersonDraft, 'phoneMode' | 'phone'> {
  return phoneFieldFromStored(stored);
}

/** Младше 16 на начало конференции? null - дата ещё не введена. */
export function isUnder16Draft(birthDate: string, ageRef: string): boolean | null {
  const d = parseBirthDate(birthDate);
  return 'iso' in d ? ageOn(d.iso, ageRef) < MIN_AGE : null;
}

interface Props {
  person: PersonDraft;
  errors: PersonErrors;
  onChange: (patch: Partial<PersonDraft>) => void;
  /** Варианты участия из настроек (цены, цвета). */
  tiers: TiersConfig;
  /** Дата, на которую считаем возраст (начало конференции). */
  ageRef: string;
  /**
   * Показывать способ оплаты. Вариант участия показываем всегда: он обязателен (от него питание,
   * лимиты, цвет на билете), даже пока приём оплаты выключен.
   */
  withPayment?: boolean;
  /** Вариант менять нельзя (уже оплачено) - текст пояснения. */
  tierLockedNote?: string;
  /** Вариант заблокирован оплатой, но завтрак докупить можно (только добавить). */
  breakfastAddable?: boolean;
  /** Докупленный, но ещё не оплаченный завтрак можно снять. */
  breakfastRemovable?: boolean;
  /** Человек ушёл с поля - можно проверить формат (дата, телефон, ник). */
  onBlurField?: (field: FieldKey) => void;
  /** Принимаем переводы. Нет - выбора способа нет, только наличные. */
  transfers?: boolean;
  /** Показывать «Кто это?» (при правке - нет). */
  withRelation?: boolean;
  /** Можно ли выбрать «Я» (один раз на аккаунт). */
  allowSelf?: boolean;
  /** Предложить номер из Telegram (для «Я»). */
  offerContact?: boolean;
  /** Номер пришёл из Telegram - с подписью, можно проверить, не записан ли человек с другого аккаунта. */
  onContact?: (contact: TelegramContact) => void;
  /** Подсказка под телефоном (например, сохранён номер другой страны). */
  phoneNote?: string;
  /** Остаток мест у вариантов с лимитом. */
  tierLeft?: Partial<Record<Tier, number>>;
  /** Завтрак из настроек (доплата, когда); нет - галочку не показываем. */
  breakfast?: BreakfastConfig;
  /** Сколько завтраков осталось; null - без лимита. */
  breakfastLeft?: number | null;
  /** Завтрак у человека уже есть (при правке) - его можно оставить, даже если завтраков больше нет. */
  currentBreakfast?: boolean;
  /** «Гость» на месте: только фамилия, имя, телефон и пол. */
  guest?: boolean;
  /** Текущий вариант человека (при правке) - остаётся доступным, даже если мест нет. */
  currentTier?: Tier | null;
}

/** «Кто это?»: поле-кнопка во всю ширину + шторка с вариантами (системный select не используем). */
function RelationSelect({
  value,
  allowSelf,
  invalid,
  onChange,
}: {
  value: Relation | '';
  allowSelf: boolean;
  invalid: boolean;
  onChange: (r: Relation) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-haspopup="listbox"
        onClick={() => setOpen(true)}
        className={cx(
          'flex h-12 w-full items-center justify-between gap-2 rounded-xl bg-fill px-4 text-left text-[16px] transition active:opacity-70',
          invalid && invalidRing,
        )}
      >
        <span className={cx('truncate', value ? 'font-medium text-fg' : 'text-hint')}>
          {value ? RELATION_LABELS[value] : 'Выберите'}
        </span>
        <IconChevronDown size={20} className="text-hint" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Кто это?">
        <div role="listbox" className="overflow-hidden rounded-2xl bg-fill">
          {RELATION_OPTIONS.map((r) => {
            const selected = value === r;
            const disabled = r === 'self' && !allowSelf && !selected;
            return (
              <button
                key={r}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={disabled}
                onClick={() => {
                  onChange(r);
                  setOpen(false);
                }}
                className={cx(
                  'flex min-h-14 w-full items-center justify-between gap-3 border-b border-line px-4 text-left text-[17px] last:border-b-0 active:bg-section disabled:opacity-40',
                  selected && 'font-semibold',
                )}
              >
                <span>
                  {RELATION_LABELS[r]}
                  {disabled && <span className="block text-[13px] font-normal text-hint">Уже выбрано для другого человека</span>}
                </span>
                {selected && <IconCheck size={22} className="text-accent" />}
              </button>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}

/** Вариант участия: карточки с цветной полосой, ценой и описанием. */
function TierPicker({
  value,
  tiers,
  left,
  current,
  invalid,
  disabled,
  onChange,
}: {
  value: Tier | '';
  tiers: TiersConfig;
  /** Сколько мест осталось у вариантов с лимитом (обед и ужин и т. п.). */
  left?: Partial<Record<Tier, number>>;
  /** Вариант, который у человека уже есть, - его можно оставить, даже если мест больше нет. */
  current?: Tier | null;
  invalid: boolean;
  disabled?: boolean;
  onChange: (t: Tier) => void;
}) {
  return (
    <div role="radiogroup" aria-invalid={invalid || undefined} className="grid gap-2">
      {/* Выключенный в настройках вариант не показываем - кроме того, что у человека уже есть. */}
      {TIERS.filter((t) => tiers[t].enabled !== false || current === t).map((t) => {
        const cfg = tiers[t];
        const selected = value === t;
        const rest = left?.[t];
        const full = rest === 0 && current !== t;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={(disabled && !selected) || (full && !selected)}
            onClick={() => onChange(t)}
            className="relative flex w-full items-start gap-3 overflow-hidden rounded-xl bg-fill py-3 pl-5 pr-3 text-left transition active:opacity-80 disabled:opacity-40"
            style={selected ? { boxShadow: `inset 0 0 0 2px ${cfg.color}` } : undefined}
          >
            <span aria-hidden className="absolute inset-y-0 left-0 w-2" style={{ background: cfg.color }} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[16px] font-semibold leading-snug">{cfg.label}</span>
                <span className="shrink-0 text-[16px] font-bold" style={{ color: cfg.color }}>
                  {cfg.amount > 0 ? formatRub(cfg.amount) : '-'}
                </span>
              </span>
              {cfg.description && <span className="mt-0.5 block text-[14px] leading-snug text-subtle">{cfg.description}</span>}
              {full ? (
                <span className="mt-1 block text-[13px] font-semibold text-bad-fg">Мест больше нет</span>
              ) : rest !== undefined && rest < 20 && current !== t ? (
                <span className="mt-1 block text-[13px] font-semibold text-warn-fg">
                  Осталось {rest} {plural(rest, ['место', 'места', 'мест'])}
                </span>
              ) : null}
            </span>
            <span
              aria-hidden
              className={cx(
                'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full transition-[box-shadow,background-color]',
                !selected && (invalid ? 'bg-bad-soft shadow-[inset_0_0_0_2px_var(--color-danger)]' : 'shadow-[inset_0_0_0_2px_var(--color-hint)]'),
              )}
              style={selected ? { background: cfg.color, color: textOn(cfg.color) } : undefined}
            >
              {selected && <IconCheck size={16} stroke={3} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Галочка «Добавить завтрак» под выбранным платным вариантом: доплата, когда завтрак, сколько осталось. */
function BreakfastOption({
  checked,
  cfg,
  left,
  current,
  invalid,
  disabled,
  onChange,
}: {
  checked: boolean;
  cfg: BreakfastConfig;
  left?: number | null;
  current?: boolean;
  invalid: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  // Завтраков не осталось - добавить нельзя; у кого завтрак уже есть, тот может оставить или снять.
  const full = left === 0 && !current && !checked;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-invalid={invalid || undefined}
      disabled={disabled || full}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-xl bg-fill px-3 py-3 text-left transition active:opacity-80 disabled:opacity-40"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-[16px] font-semibold leading-snug">Добавить завтрак</span>
          <span className="shrink-0 text-[16px] font-bold">{cfg.amount > 0 ? `+${formatRub(cfg.amount)}` : 'бесплатно'}</span>
        </span>
        {cfg.description && <span className="mt-0.5 block text-[14px] leading-snug text-subtle">{cfg.description}</span>}
        {full ? (
          <span className="mt-1 block text-[13px] font-semibold text-bad-fg">Завтраков больше нет</span>
        ) : left != null && left < 20 && !current ? (
          <span className="mt-1 block text-[13px] font-semibold text-warn-fg">
            Осталось {left} {plural(left, ['завтрак', 'завтрака', 'завтраков'])}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        className={cx(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[7px] transition-[background-color,box-shadow]',
          checked
            ? 'bg-btn text-btn-fg'
            : invalid
              ? 'bg-bad-soft shadow-[inset_0_0_0_2px_var(--color-danger)]'
              : 'shadow-[inset_0_0_0_2px_var(--color-hint)]',
        )}
      >
        {checked && <IconCheck size={17} stroke={3} />}
      </span>
    </button>
  );
}

/** Две кнопки-переключателя (пол, способ оплаты). */
function Toggle<T extends string>({
  value,
  options,
  invalid,
  onChange,
}: {
  value: T | '';
  options: readonly (readonly [T, string])[];
  invalid: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-invalid={invalid || undefined}
      className={cx('flex min-h-12 gap-1 rounded-xl bg-fill p-1 transition-[box-shadow,background-color]', invalid && invalidRing)}
    >
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cx(
            'flex-1 rounded-lg px-2 text-[15px] font-semibold leading-tight transition',
            value === v ? 'bg-btn text-btn-fg' : 'text-subtle',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const GENDER_OPTIONS = [
  ['m', 'Мужской'],
  ['f', 'Женский'],
] as const;
export const METHOD_OPTIONS = REG_PAYMENT_METHODS.map((m) => [m, m === 'transfer' ? 'Переводом' : REG_PAYMENT_METHOD_LABELS[m]] as const);

export function PersonFields({
  person: p,
  errors,
  onChange,
  tiers,
  ageRef,
  withPayment = true,
  tierLockedNote,
  breakfastAddable,
  breakfastRemovable,
  onBlurField,
  transfers = true,
  withRelation = true,
  allowSelf = true,
  offerContact,
  onContact,
  phoneNote,
  tierLeft,
  currentTier,
  breakfast,
  breakfastLeft,
  currentBreakfast,
  guest = false,
}: Props) {
  const [contactBusy, setContactBusy] = useState(false);
  const [phoneFocused, setPhoneFocused] = useState(false);
  // Для «Я» при первом касании пустого телефона Telegram сам спросит «Поделиться номером?» - один раз.
  const [contactAsked, setContactAsked] = useState(false);
  const [phoneHint, setPhoneHint] = useState<string | null>(null);
  const id = (f: string) => `${p.key}-${f}`;
  const anchor = (f: FieldKey) => fieldAnchor(p.key, f);
  const blur = (f: FieldKey) => () => onBlurField?.(f);
  const under16 = isUnder16Draft(p.birthDate, ageRef);
  const tierCfg = p.tier ? tiers[p.tier] : null;
  const showUsername = p.relation !== '' && p.relation !== 'self';
  const phoneRequired = p.relation !== 'child';

  /** silent - сами спросили при касании поля: отказ не комментируем, человек просто впишет номер. */
  const fillPhone = async (silent = false) => {
    setContactBusy(true);
    const contact = await requestContactFromTelegram();
    setContactBusy(false);
    if (contact) {
      setPhoneHint(null);
      const next = phoneFieldChange('by', contact.phone);
      onChange({ phoneMode: next.mode, phone: next.digits });
      onContact?.(contact);
    } else if (!silent) toast.info('Номер не пришёл, впишите его вручную');
  };

  const phoneTip =
    phoneHint ?? phoneNote ?? (phoneFocused && p.phoneMode === 'by' && !p.phone ? 'Для номера другой страны нажмите на +375' : null);

  return (
    <div>
      {withRelation && (
        <Field label="Кто это?" error={errors.relation} anchor={anchor('relation')}>
          <RelationSelect
            value={p.relation}
            allowSelf={allowSelf}
            invalid={Boolean(errors.relation)}
            onChange={(r) => onChange({ relation: r })}
          />
        </Field>
      )}
      <Field label="Фамилия" htmlFor={id('lastName')} error={errors.lastName} anchor={anchor('lastName')}>
        <TextInput
          id={id('lastName')}
          value={p.lastName}
          invalid={Boolean(errors.lastName)}
          autoComplete={p.relation === 'self' ? 'family-name' : 'off'}
          autoCapitalize="words"
          enterKeyHint="next"
          maxLength={60}
          onBlur={blur('lastName')}
          onChange={(e) => onChange({ lastName: e.target.value })}
        />
      </Field>
      <Field label="Имя" htmlFor={id('firstName')} error={errors.firstName} anchor={anchor('firstName')}>
        <TextInput
          id={id('firstName')}
          value={p.firstName}
          invalid={Boolean(errors.firstName)}
          autoComplete={p.relation === 'self' ? 'given-name' : 'off'}
          autoCapitalize="words"
          enterKeyHint="next"
          maxLength={60}
          onBlur={blur('firstName')}
          onChange={(e) => onChange({ firstName: e.target.value })}
        />
      </Field>
      {!guest && (
      <Field
        label="Дата рождения"
        htmlFor={id('birthDate')}
        error={errors.birthDate}
        anchor={anchor('birthDate')}
        hint={under16 ? undefined : 'Например, 17.05.2004'}
      >
        <TextInput
          id={id('birthDate')}
          inputMode="numeric"
          placeholder="ДД.ММ.ГГГГ"
          value={p.birthDate}
          invalid={Boolean(errors.birthDate)}
          autoComplete={p.relation === 'self' ? 'bday' : 'off'}
          maxLength={10}
          onBlur={blur('birthDate')}
          onChange={(e) => onChange({ birthDate: maskBirthDate(e.target.value, p.birthDate) })}
        />
        {under16 && !errors.birthDate && (
          <p className="mt-1.5 animate-error-in rounded-xl bg-warn-soft px-3 py-2 text-[13px] leading-snug text-warn-fg">
            Конференция рассчитана на участников с {MIN_AGE} лет. Младших тоже записываем, организаторы свяжутся с вами.
          </p>
        )}
      </Field>
      )}
      <Field label="Телефон" optional={!phoneRequired} htmlFor={id('phone')} error={errors.phone} anchor={anchor('phone')} hint={phoneTip}>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setPhoneHint(null);
              onChange(p.phoneMode === 'by' ? { phoneMode: 'intl', phone: '' } : { phoneMode: 'by', phone: '' });
            }}
            className="flex h-12 shrink-0 items-center gap-1 rounded-xl bg-fill px-3 text-[16px] font-semibold text-subtle active:opacity-70"
            aria-label={p.phoneMode === 'by' ? 'Номер другой страны' : 'Белорусский номер'}
          >
            {p.phoneMode === 'by' ? PHONE_COUNTRIES.by.label : <IconWorld size={20} />}
            <IconChevronDown size={16} className="text-hint" />
          </button>
          <TextInput
            id={id('phone')}
            type="tel"
            inputMode="tel"
            value={p.phoneMode === 'by' ? formatPhoneLocal('by', p.phone) : formatIntlPhone(p.phone)}
            invalid={Boolean(errors.phone)}
            autoComplete={p.relation === 'self' ? 'tel' : 'off'}
            placeholder={p.phoneMode === 'by' ? PHONE_COUNTRIES.by.placeholder : '+48 601 234 567'}
            onFocus={() => {
              setPhoneFocused(true);
              if (offerContact && !p.phone && !contactAsked && canRequestContact()) {
                setContactAsked(true);
                void fillPhone(true);
              }
            }}
            onBlur={() => {
              setPhoneFocused(false);
              onBlurField?.('phone');
            }}
            onChange={(e) => {
              const next = phoneFieldChange(p.phoneMode, e.target.value, p.phone);
              setPhoneHint(next.mode !== p.phoneMode && next.mode === 'intl' ? 'Номер другой страны' : null);
              onChange({ phoneMode: next.mode, phone: next.digits });
            }}
          />
        </div>
        {offerContact && canRequestContact() && (
          <button
            type="button"
            disabled={contactBusy}
            onClick={() => void fillPhone()}
            className="mt-1.5 inline-flex items-center gap-1.5 px-1 py-1 text-[14px] font-medium text-accent disabled:opacity-50"
          >
            <IconDeviceMobile size={17} />
            {contactBusy ? 'Запрашиваем номер…' : 'Взять номер из Telegram'}
          </button>
        )}
      </Field>
      <Field label="Пол" error={errors.gender} anchor={anchor('gender')}>
        <Toggle value={p.gender} options={GENDER_OPTIONS} invalid={Boolean(errors.gender)} onChange={(g) => onChange({ gender: g })} />
      </Field>
      {!guest && (
      <>
      <Field label="Населённый пункт" htmlFor={id('city')} error={errors.city} anchor={anchor('city')} hint="Город, посёлок, деревня">
        <TextInput
          id={id('city')}
          value={p.city}
          invalid={Boolean(errors.city)}
          autoComplete={p.relation === 'self' ? 'address-level2' : 'off'}
          autoCapitalize="words"
          maxLength={80}
          onBlur={blur('city')}
          onChange={(e) => onChange({ city: e.target.value })}
        />
      </Field>
      <Field label="Церковь, которую посещаете" htmlFor={id('church')} error={errors.church} anchor={anchor('church')}>
        <TextInput
          id={id('church')}
          value={p.church}
          invalid={Boolean(errors.church)}
          autoCapitalize="sentences"
          placeholder="Название и город"
          maxLength={120}
          onBlur={blur('church')}
          onChange={(e) => onChange({ church: e.target.value })}
        />
      </Field>
      {!p.church.trim() && (
        <div className="-mt-2.5 mb-4 flex flex-wrap gap-1.5 px-1">
          {[HOME_CHURCH, 'Не посещаю'].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange({ church: v })}
              className="min-h-8 rounded-full bg-fill px-3 text-[14px] font-medium text-accent active:opacity-70"
            >
              {v === HOME_CHURCH ? `«${v}»` : v}
            </button>
          ))}
        </div>
      )}
      {showUsername && (
        <Field label="Ник в Telegram" htmlFor={id('telegramUsername')} error={errors.telegramUsername} anchor={anchor('telegramUsername')}>
          {!p.noTelegram && (
            <>
              <div className="flex gap-2">
                <span className="flex h-12 shrink-0 items-center rounded-xl bg-fill px-3.5 text-[16px] font-semibold text-subtle">@</span>
                <TextInput
                  id={id('telegramUsername')}
                  value={p.telegramUsername}
                  invalid={Boolean(errors.telegramUsername)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="ivan_petrov"
                  maxLength={40}
                  onBlur={blur('telegramUsername')}
                  onChange={(e) => onChange({ telegramUsername: e.target.value.replace(/^@+/, '').replace(/\s/g, '') })}
                />
              </div>
              <p className="mt-1.5 px-1 text-[13px] leading-snug text-hint">Когда человек откроет бота, QR-код придёт и ему</p>
            </>
          )}
          <div className="px-1">
            <Checkbox
              checked={p.noTelegram}
              invalid={Boolean(errors.telegramUsername) && !p.telegramUsername.trim()}
              onChange={(v) => onChange({ noTelegram: v })}
            >
              Нет Телеграма или не знаю ник
              {p.noTelegram && (
                <span className="mt-0.5 block text-[13px] text-hint">
                  {p.relation === 'child' && !p.phone
                    ? 'Ничего страшного: на семинары ребёнка запишете вы.'
                    : 'Ничего страшного: человек найдёт свою регистрацию в боте по номеру телефона.'}
                </span>
              )}
            </Checkbox>
          </div>
        </Field>
      )}
      <Field label="Вариант участия" error={errors.tier} anchor={anchor('tier')} hint={tierLockedNote}>
        <TierPicker
          left={tierLeft}
          current={currentTier}
          value={p.tier}
          tiers={tiers}
          invalid={Boolean(errors.tier)}
          disabled={Boolean(tierLockedNote)}
          // К «Без взноса» завтрак не добавляется - галочку снимаем вместе со сменой варианта.
          onChange={(t) => onChange(breakfastAllowed(t) ? { tier: t } : { tier: t, breakfast: false })}
        />
        {breakfast && breakfastAllowed(p.tier) && (breakfast.enabled !== false || currentBreakfast) && (
          <div id={anchor('breakfast')} className="mt-2 scroll-mt-24">
            <BreakfastOption
              checked={p.breakfast}
              cfg={breakfast}
              left={breakfastLeft}
              current={currentBreakfast}
              invalid={Boolean(errors.breakfast)}
              disabled={Boolean(tierLockedNote) && !(breakfastAddable && !currentBreakfast) && !(breakfastRemovable && currentBreakfast)}
              onChange={(v) => onChange({ breakfast: v })}
            />
            {errors.breakfast && <FieldError>{errors.breakfast}</FieldError>}
          </div>
        )}
      </Field>
      {withPayment && (
        <>
          {tierCfg && tierCfg.amount > 0 && !transfers && (
            <p className="-mt-1 mb-4 px-1 text-[14px] text-subtle">Взнос вносится наличными.</p>
          )}
          {tierCfg && tierCfg.amount > 0 && transfers && (
            <Field label="Как внесёте взнос" error={errors.paymentMethod} anchor={anchor('paymentMethod')} hint={p.paymentMethod === 'transfer' ? 'Взнос, оплаченный переводом, не возвращается. Способ можно сменить и после регистрации' : 'Его можно сменить и после регистрации'}>
              <Toggle
                value={p.paymentMethod}
                options={METHOD_OPTIONS}
                invalid={Boolean(errors.paymentMethod)}
                onChange={(m) => onChange({ paymentMethod: m })}
              />
            </Field>
          )}
        </>
      )}
      </>
      )}
    </div>
  );
}
