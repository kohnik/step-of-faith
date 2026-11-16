import { DEFAULT_BREAKFAST, breakfastAllowed, formatRub, isFreeTier, participantUpdateSchema, type Gender, type ParticipantUpdate } from '@sof/shared';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { errorMessage } from '../api/client.ts';
import { setMe } from '../api/queries.ts';
import { haptic } from '../lib/feedback.ts';
import { isoToDisplayDate, parseBirthDate, phoneForSubmit } from '../lib/masks.ts';
import { useMainButton } from '../telegram/main-button.ts';
import { Button, Card, Notice } from '../ui/kit.tsx';
import { Page, StickyFooter } from '../ui/Page.tsx';
import { toast } from '../ui/toast.tsx';
import { canAddBreakfast, canRemoveBreakfast, participantApi, paymentsOn, useMeData } from './api.ts';
import {
  draftChecks,
  fieldAnchor,
  fieldMessage,
  PersonFields,
  phoneDraft,
  type FieldKey,
  type PersonDraft,
  type PersonErrors,
  usernameForSubmit,
} from './PersonFields.tsx';

export default function EditParticipant({ id }: { id: number }) {
  const me = useMeData();
  const [, navigate] = useLocation();
  const original = me.participants.find((p) => p.id === id);
  const [draft, setDraft] = useState<PersonDraft | null>(() =>
    original
      ? {
          key: `edit-${original.id}`,
          lastName: original.lastName,
          firstName: original.firstName,
          middleName: original.middleName ?? '',
          birthDate: original.birthDate ? isoToDisplayDate(original.birthDate) : '',
          gender: original.gender,
          city: original.city ?? '',
          church: original.church ?? '',
          ...phoneDraft(original.phone),
          relation: original.relation,
          telegramUsername: original.telegramUsername ?? '',
          noTelegram: original.relation !== 'self' && !original.telegramUsername,
          tier: original.tier ?? '',
          breakfast: Boolean(original.breakfast),
          paymentMethod: original.paymentMethod ?? '',
        }
      : null,
  );
  // Телефон отправляем, только если его трогали: старые номера в другом формате не перезапишем.
  const phoneTouched = useRef(false);
  const [errors, setErrors] = useState<PersonErrors>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editable = Boolean(original && draft && original.status === 'active' && !original.transferredToMe && me.registration.open);

  // Пришли по карандашу у варианта или по «+ завтрак» - сразу к нужному месту.
  const focus = new URLSearchParams(useSearch()).get('focus');
  useEffect(() => {
    if ((focus !== 'tier' && focus !== 'breakfast') || !draft) return;
    const t = window.setTimeout(() => {
      document.getElementById(fieldAnchor(draft.key, focus))?.scrollIntoView({ behavior: 'smooth', block: focus === 'tier' ? 'start' : 'center' });
    }, 150);
    return () => window.clearTimeout(t);
  }, []);

  const save = async () => {
    if (!original || !draft || saving) return;
    const nextErrors: PersonErrors = {};
    draftChecks(draft, nextErrors);
    // Гость на месте записывался без даты рождения и города - не требуем их и сейчас.
    if (original.onSite && !draft.birthDate.trim()) delete nextErrors.birthDate;
    const date = parseBirthDate(draft.birthDate);

    const patch: ParticipantUpdate = {};
    if (draft.lastName.trim() !== original.lastName) patch.lastName = draft.lastName;
    if (draft.firstName.trim() !== original.firstName) patch.firstName = draft.firstName;
    const middle = draft.middleName.trim() || null;
    if (middle !== original.middleName) patch.middleName = middle;
    if ('iso' in date && date.iso !== original.birthDate) patch.birthDate = date.iso;
    if (draft.gender && draft.gender !== original.gender) patch.gender = draft.gender as Gender;
    if (draft.city.trim() !== (original.city ?? '') && !(original.onSite && !draft.city.trim())) patch.city = draft.city;
    if (draft.church.trim() !== (original.church ?? '')) patch.church = draft.church;
    if (phoneTouched.current) {
      const phone = phoneForSubmit(draft.phoneMode, draft.phone);
      if (phone !== original.phone) patch.phone = phone;
    }
    const username = usernameForSubmit(draft);
    if (original.relation !== 'self' && username !== original.telegramUsername) patch.telegramUsername = username;
    if (draft.tier && draft.tier !== original.tier) patch.tier = draft.tier;
    const breakfast = draft.breakfast && breakfastAllowed(draft.tier);
    if (breakfast !== Boolean(original.breakfast)) patch.breakfast = breakfast;
    // Пока приём оплаты выключен, способа оплаты в форме нет - не трогаем его и не требуем.
    if (paymentsOn(me)) {
      const method = !isFreeTier(draft.tier) && draft.paymentMethod ? draft.paymentMethod : null;
      if (method !== original.paymentMethod) patch.paymentMethod = method;
      if (draft.tier && !isFreeTier(draft.tier) && !method) nextErrors.paymentMethod = 'Выберите, как внесёте взнос';
    }

    const res = participantUpdateSchema.safeParse(patch);
    if (!res.success) {
      for (const issue of res.error.issues) {
        const field = issue.path[0] as FieldKey | undefined;
        if (field && !nextErrors[field]) nextErrors[field] = fieldMessage(field, issue.code, issue.message);
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !res.success) {
      haptic('error');
      return;
    }
    if (Object.keys(res.data).length === 0) {
      toast.info('Изменений нет');
      navigate('/tickets');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await participantApi.updateParticipant(original.id, res.data);
      setMe({ ...me, participants: me.participants.map((p) => (p.id === updated.id ? updated : p)) });
      haptic('success');
      // Докупил завтрак после оплаты - сразу говорим, сколько доплатить.
      const extra = Number(updated.amountDue ?? 0) - Number(updated.amountPaid ?? 0);
      toast.success(
        !original.breakfast && updated.breakfast && updated.paymentStatus === 'partial' && extra > 0
          ? `Завтрак добавлен - доплатите ${formatRub(extra.toFixed(2))}`
          : original.breakfast && !updated.breakfast && updated.paymentStatus === 'paid'
            ? 'Завтрак убран - доплачивать не нужно'
            : 'Сохранили',
      );
      navigate('/tickets');
    } catch (err) {
      haptic('error');
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const native = useMainButton({ text: 'Сохранить', visible: editable, loading: saving, onClick: save });

  if (!original || !draft) {
    return (
      <Page title="Не нашли участника" back="/tickets">
        <p className="text-subtle">Похоже, регистрацию уже изменили. Вернитесь к QR-кодам.</p>
      </Page>
    );
  }
  if (!editable) {
    return (
      <Page title={original.fullName} back="/tickets">
        <Notice tone="yellow">
          {!me.registration.open
            ? 'Регистрация закрыта - чтобы что-то поменять, напишите организаторам.'
            : original.transferredToMe
              ? 'Этот QR-код вам передали - поменять данные может тот, кто регистрировал.'
              : 'Эту регистрацию уже нельзя изменить.'}
        </Notice>
      </Page>
    );
  }

  return (
    <Page title="Изменить данные" subtitle={original.fullName} back="/tickets" bottomInset={!native}>
      <Card className="mb-4">
        <PersonFields
          person={draft}
          errors={errors}
          withRelation={false}
          tiers={me.registration.tiers}
          ageRef={(me.event.startsAt ?? new Date().toISOString()).slice(0, 10)}
          withPayment={paymentsOn(me)}
          transfers={me.payment.transfers}
          tierLockedNote={
            ['unpaid', 'exempt'].includes(original.paymentStatus)
              ? undefined
              : original.paymentStatus === 'pending'
                ? 'Чек на проверке - докупить завтрак можно будет после проверки. Сменить вариант - через организаторов.'
                : original.breakfast
                  ? canRemoveBreakfast(me, original)
                    ? 'Взнос внесён, а завтрак ещё не оплачен - его можно убрать (доплачивать тогда не нужно) или доплатить разницу. Сменить вариант - через организаторов.'
                    : 'Взнос уже внесён - чтобы сменить вариант или убрать завтрак, напишите организаторам.'
                  : 'Взнос уже внесён - вариант поменять нельзя, а завтрак можно докупить: отметьте его и доплатите разницу на кассе или переводом.'
          }
          breakfastAddable={canAddBreakfast(me, original)}
          breakfastRemovable={canRemoveBreakfast(me, original)}
          offerContact={original.relation === 'self'}
          tierLeft={me.registration.tierLeft}
          currentTier={original.tier}
          breakfast={me.registration.breakfast ?? DEFAULT_BREAKFAST}
          breakfastLeft={me.registration.breakfastLeft ?? null}
          currentBreakfast={Boolean(original.breakfast)}
          guest={original.onSite}
          onChange={(patch) => {
            if ('phone' in patch || 'phoneMode' in patch) phoneTouched.current = true;
            setDraft((d) => (d ? { ...d, ...patch } : d));
            setErrors((e) => {
              const next = { ...e };
              for (const f of Object.keys(patch)) {
                delete next[(f === 'phoneMode' ? 'phone' : f === 'noTelegram' ? 'telegramUsername' : f) as FieldKey];
              }
              return next;
            });
          }}
        />
      </Card>
      <p className="mb-3 px-1 text-[13px] text-hint">QR-код останется прежним - сохранённые картинки продолжат работать.</p>
      {error && (
        <Notice tone="red" className="mb-3">
          {error}
        </Notice>
      )}
      {!native && (
        <StickyFooter>
          <Button size="lg" block loading={saving} onClick={save}>
            Сохранить
          </Button>
        </StickyFooter>
      )}
    </Page>
  );
}
