import {
  Anchor,
  Badge,
  Blockquote,
  Button,
  Card,
  Center,
  Checkbox,
  Group,
  Image,
  Progress,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { ReceiptView } from '@sof/shared';
import { IconCheck, IconExternalLink, IconFileText, IconMessage, IconPhotoOff, IconTrash, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { useAcceptReceipt, useDeleteReceipt, useRejectReceipt } from '../../api/receipts.ts';
import { PaymentBadge, TierBadge } from '../../components/badges.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { useCan, useTiers } from '../../components/SessionProvider.tsx';
import { CopyValue } from '../../components/CopyValue.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { ParticipantLink } from '../../components/ParticipantLink.tsx';
import { formatDateTime, formatMoney, formatRelative, normalizeMoneyInput } from '../../lib/format.ts';
import { RECEIPT_KIND_COLORS, RECEIPT_KIND_LABELS, RECEIPT_STATUS_COLORS, RECEIPT_STATUS_LABELS } from '../../lib/labels.ts';
import { notifyError, notifyInfo, notifySuccess } from '../../lib/notify.tsx';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';

const MONEY_RE = /^\d{1,8}(\.\d{1,2})?$/;
const MERCH_STATUS: Record<string, string> = { paid: 'оплачено', issued: 'выдано', owed: 'в долг', cancelled: 'бронь отменена', expired: 'бронь истекла' };

function handleReviewError(err: unknown) {
  if (err instanceof ApiError && err.status === 409) {
    notifyInfo('Этот чек уже проверил кто-то другой - список обновлён.', 'Чек уже проверен');
    return;
  }
  notifyError(err);
}

type ReceiptFileView = ReceiptView['files'][number];

/** Все файлы чека: несколько переводов одним чеком - каждый файл отдельно, с номером. */
function ReceiptFiles({ receipt }: { receipt: ReceiptView }) {
  const files = receipt.files?.length ? receipt.files : [{ url: receipt.fileUrl, kind: receipt.fileKind, mimeType: receipt.mimeType }];
  if (files.length === 1) return <ReceiptPreview receipt={receipt} file={files[0]!} />;
  return (
    <Stack gap="xs">
      <Badge variant="light" color="blue">
        Файлов в чеке: {files.length}
      </Badge>
      {files.map((f, i) => (
        <Stack key={f.url} gap={2}>
          <Text size="xs" c="dimmed">
            Файл {i + 1}
          </Text>
          <ReceiptPreview receipt={receipt} file={f} />
        </Stack>
      ))}
    </Stack>
  );
}

function ReceiptPreview({ receipt, file }: { receipt: ReceiptView; file: ReceiptFileView }) {
  const [failed, setFailed] = useState(false);
  // Новая попытка - новый адрес картинки (браузер не возьмёт ошибку из кэша).
  const [attempt, setAttempt] = useState(0);
  const sep = file.url.includes('?') ? '&' : '?';
  const src = attempt ? `${file.url}${sep}try=${attempt}` : file.url;
  const [zoomOpened, zoom] = useDisclosure(false);
  // Картинку, присланную файлом (JPG, PNG, WebP), показываем так же, как фото. PDF и прочее - кнопкой.
  const isImage = file.kind === 'photo' || /^image\/(jpeg|png|webp|gif)$/.test(file.mimeType ?? '');
  if (!isImage) return <ReceiptFileButton receipt={receipt} file={file} />;
  if (failed) {
    return (
      <Center h={120} bg="var(--mantine-color-default-hover)" style={{ borderRadius: 'var(--mantine-radius-md)' }}>
        <Stack gap={4} align="center">
          <IconPhotoOff size={24} color="var(--mantine-color-dimmed)" />
          <Text size="xs" c="dimmed" ta="center">
            Не удалось загрузить фото из Telegram.
          </Text>
          <Group gap="xs">
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => {
                setFailed(false);
                setAttempt((a) => a + 1);
              }}
            >
              Повторить
            </Button>
            <Anchor href={src} target="_blank" rel="noopener noreferrer" size="xs">
              Открыть отдельно
            </Anchor>
          </Group>
        </Stack>
      </Center>
    );
  }
  return (
    <>
      <img
        src={src}
        alt={`Чек №${receipt.id}`}
        className="sof-receipt-preview"
        loading="lazy"
        onError={() => setFailed(true)}
        onClick={zoom.open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') zoom.open();
        }}
        tabIndex={0}
        role="button"
      />
      <AppModal opened={zoomOpened} onClose={zoom.close} size="xl" title={<Text fw={700}>{`Чек №${receipt.id} · ${receipt.userName}`}</Text>}>
        <Stack gap="sm">
          <Image src={file.url} alt={`Чек №${receipt.id}`} className="sof-receipt-full" />
          <ModalActions>
            <Button component="a" variant="default" href={file.url} target="_blank" rel="noopener noreferrer" leftSection={<IconExternalLink size={16} />}>
              Открыть в новой вкладке
            </Button>
            <Button onClick={zoom.close}>Закрыть</Button>
          </ModalActions>
        </Stack>
      </AppModal>
    </>
  );
}

/**
 * PDF и другие файлы - в окне поверх админки с кнопкой «Закрыть» (в новой вкладке на телефоне
 * не было пути назад). Файл берём в память браузера: у админки запрещено встраивание страниц
 * (X-Frame-Options), а показ из памяти этот запрет не задевает.
 */
function ReceiptFileButton({ receipt, file }: { receipt: ReceiptView; file: ReceiptFileView }) {
  const pdf = file.mimeType === 'application/pdf';
  const [opened, modal] = useDisclosure(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!opened || !pdf) return;
    let url: string | null = null;
    let cancelled = false;
    setError(false);
    fetch(file.url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([b], { type: 'application/pdf' }));
        setBlobUrl(url);
      })
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setBlobUrl(null);
    };
  }, [opened, pdf, file.url]);

  if (!pdf) {
    return (
      <Button component="a" href={file.url} target="_blank" rel="noopener noreferrer" variant="light" leftSection={<IconFileText size={16} />} rightSection={<IconExternalLink size={14} />} fullWidth>
        Открыть файл
      </Button>
    );
  }
  return (
    <>
      <Button variant="light" leftSection={<IconFileText size={16} />} fullWidth onClick={modal.open}>
        Открыть PDF
      </Button>
      <AppModal opened={opened} onClose={modal.close} size="xl" title={<Text fw={700}>{`Чек №${receipt.id} · ${receipt.userName}`}</Text>}>
        <Stack gap="sm">
          {error ? (
            <Text size="sm" c="red">
              Не получилось загрузить PDF из Telegram - попробуйте ещё раз или откройте в новой вкладке.
            </Text>
          ) : blobUrl ? (
            <iframe src={blobUrl} title={`Чек №${receipt.id}`} className="sof-receipt-pdf" />
          ) : (
            <Center h={200}>
              <Text size="sm" c="dimmed">
                Загружаем PDF…
              </Text>
            </Center>
          )}
          <ModalActions>
            <Button component="a" variant="default" href={file.url} target="_blank" rel="noopener noreferrer" leftSection={<IconExternalLink size={16} />}>
              Открыть в новой вкладке
            </Button>
            <Button onClick={modal.close}>Закрыть</Button>
          </ModalActions>
        </Stack>
      </AppModal>
    </>
  );
}

/** Сколько внесено и сколько осталось: полоска и подпись - понятно и у частичной оплаты. */
function PaymentProgress({ due, paid, status }: { due: number; paid: number; status: string }) {
  if (status === 'exempt' || due <= 0) return null;
  const left = Math.max(0, due - paid);
  const pct = Math.min(100, Math.round((paid / due) * 100));
  const color = left <= 0 ? 'green' : paid > 0 ? 'orange' : 'gray';
  return (
    <Stack gap={2} mt={2}>
      <Progress value={pct} size="sm" radius="xl" color={color} aria-label={`Внесено ${pct}%`} />
      <Text size="xs" c={left <= 0 ? 'green' : 'dimmed'}>
        {left <= 0
          ? `Оплачено ${formatMoney(due)}`
          : paid > 0
            ? `Внесено ${formatMoney(paid)} из ${formatMoney(due)} · осталось ${formatMoney(left)}`
            : `К оплате ${formatMoney(due)}`}
      </Text>
    </Stack>
  );
}

/** «Удалить чек» - дубли и присланное по ошибке. Только суперадмин. */
function DeleteReceiptButton({ receipt }: { receipt: ReceiptView }) {
  const can = useCan();
  const confirm = useConfirm();
  const remove = useDeleteReceipt();
  if (!can('receipts:delete')) return null;
  const doDelete = async () => {
    const ok = await confirm({
      title: `Удалить чек №${receipt.id}?`,
      message:
        receipt.status === 'pending'
          ? 'Чек исчезнет из списка. У людей из него снимется «Чек на проверке» - смогут прислать чек заново.'
          : receipt.status === 'accepted'
            ? 'Чек исчезнет из списка. Оплата, засчитанная по нему, останется.'
            : 'Чек исчезнет из списка.',
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    remove.mutate(receipt.id, {
      onSuccess: () => notifySuccess(`Чек №${receipt.id} удалён`),
      onError: (err) => (err instanceof ApiError && err.status === 404 ? notifyInfo('Этот чек уже удалили - список обновлён.') : notifyError(err)),
    });
  };
  return (
    <Group justify="flex-end">
      <Button size="compact-xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} loading={remove.isPending} onClick={() => void doDelete()}>
        Удалить чек
      </Button>
    </Group>
  );
}

/** Карточка чека: кто прислал, за кого, превью файла, решение. */
export function ReceiptCard({
  receipt,
  canReview,
  dueHint,
}: {
  receipt: ReceiptView;
  /** payments:write - можно принимать и смотреть файл. */
  canReview: boolean;
  /** Сумма «к оплате» по базе для участников чека, если известна. */
  dueHint?: number | null;
}) {
  const tz = useEventTz();
  const tiers = useTiers();
  const accept = useAcceptReceipt();
  const reject = useRejectReceipt();
  const [acceptOpened, acceptModal] = useDisclosure(false);
  const [rejectOpened, rejectModal] = useDisclosure(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  // Принять можно частично: кого сняли - вернётся в «не оплачено».
  const [chosen, setChosen] = useState<number[]>(() => receipt.participants.map((p) => p.id));
  const chosenPeople = receipt.participants.filter((p) => chosen.includes(p.id));
  // Остатки, а не полная цена: у частично оплативших в чеке только доплата.
  const chosenDue = chosenPeople.reduce((sum, p) => sum + Math.max(0, Number(p.amountDue ?? 0) - Number(p.amountPaid ?? 0)), 0);
  const normalizedAmount = normalizeMoneyInput(amount);
  const amountError = !normalizedAmount
    ? null
    : !MONEY_RE.test(normalizedAmount)
      ? 'Сумма в формате 1234.50'
      : Number(normalizedAmount) <= 0
        ? 'Сумма больше нуля'
        : chosen.length > 1 && Number(normalizedAmount) + 0.005 < chosenDue
          ? `Меньше, чем за отмеченных (${formatMoney(chosenDue)}) - снимите лишних или примите по одному`
          : null;
  const pending = receipt.status === 'pending';
  const fee = receipt.kind === 'fee';
  const donation = receipt.kind === 'donation';
  const orderOpen = receipt.merchOrder?.status === 'reserved';
  // Пожертвование - сумма обязательна (её нет в базе); мерч - сумма брони, вписывать нечего.
  const canAccept = fee ? !amountError && chosen.length > 0 : donation ? !amountError && !!normalizedAmount : orderOpen;

  const doAccept = () => {
    if (!canAccept) return;
    accept.mutate(
      fee
        ? { id: receipt.id, amount: normalizedAmount, participantIds: chosen.length === receipt.participants.length ? undefined : chosen }
        : { id: receipt.id, amount: donation ? normalizedAmount : undefined },
      {
        onSuccess: () => {
          notifySuccess(
            !fee
              ? donation
                ? `Чек №${receipt.id}: пожертвование ${formatMoney(normalizedAmount)} принято`
                : `Чек №${receipt.id}: бронь ${receipt.merchOrder?.code ?? ''} оплачена`
              : chosen.length === receipt.participants.length
                ? `Чек №${receipt.id} принят`
                : `Чек №${receipt.id} принят за ${chosen.length} из ${receipt.participants.length} - остальные вернулись в «не оплачено»`,
          );
          acceptModal.close();
        },
        onError: (err) => {
          handleReviewError(err);
          if (err instanceof ApiError && err.status === 409) acceptModal.close();
        },
      },
    );
  };

  const doReject = () => {
    reject.mutate(
      { id: receipt.id, reason: reason.trim() || null },
      {
        onSuccess: () => {
          notifySuccess(`Чек №${receipt.id} отклонён - участнику придёт сообщение`);
          rejectModal.close();
        },
        onError: (err) => {
          handleReviewError(err);
          if (err instanceof ApiError && err.status === 409) rejectModal.close();
        },
      },
    );
  };

  return (
    <Card padding="md" h="100%">
      <Stack gap="sm" h="100%">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text fw={700} truncate>
              {receipt.userName}
            </Text>
            <Group gap={6} wrap="nowrap">
              <Text size="xs" c="dimmed">
                Код оплаты
              </Text>
              <CopyValue value={receipt.paymentRef} mono size="xs" fw={700} />
            </Group>
          </Stack>
          <Stack gap={4} align="flex-end">
            <Badge color={RECEIPT_STATUS_COLORS[receipt.status]} variant="light">
              {RECEIPT_STATUS_LABELS[receipt.status]}
            </Badge>
            {!fee && (
              <Badge color={RECEIPT_KIND_COLORS[receipt.kind]} variant="filled" tt="none" style={{ overflow: 'visible' }}>
                {RECEIPT_KIND_LABELS[receipt.kind]}
              </Badge>
            )}
          </Stack>
        </Group>

        <Text size="xs" c="dimmed">
          Чек №{receipt.id} · прислан {formatDateTime(receipt.createdAt, tz)} ({formatRelative(receipt.createdAt)})
        </Text>

        {canReview ? (
          <ReceiptFiles receipt={receipt} />
        ) : (
          <Text size="xs" c="dimmed">
            Файл чека видят только кассиры и админы.
          </Text>
        )}

        {receipt.comment && (
          <Blockquote icon={<IconMessage size={16} />} iconSize={28} p="xs" pl="md" color="gray" fz="sm">
            {receipt.comment}
          </Blockquote>
        )}

        {receipt.kind === 'merch' && receipt.merchOrder && receipt.merchOrder.items.length > 0 && (
          <Stack gap={2}>
            {receipt.merchOrder.items.map((it, i) => (
              <Text key={i} size="sm" fw={600}>
                {it.product} · {it.color} · {it.size}
                {it.qty > 1 ? ` × ${it.qty}` : ''}
              </Text>
            ))}
          </Stack>
        )}
        {receipt.kind === 'merch' && (
          <Text size="sm">
            {receipt.merchOrder ? (
              <>
                Бронь <b>{receipt.merchOrder.code}</b> · {formatMoney(receipt.merchOrder.total)}
                {receipt.merchOrder.status !== 'reserved' && (
                  <Text span c={receipt.merchOrder.status === 'paid' || receipt.merchOrder.status === 'issued' ? 'green' : 'red'}>
                    {' '}
                    · {MERCH_STATUS[receipt.merchOrder.status] ?? receipt.merchOrder.status}
                  </Text>
                )}
              </>
            ) : (
              'Бронь удалили'
            )}
          </Text>
        )}
        {donation && pending && (
          <Text size="sm" c="dimmed">
            Пожертвование: сумму из чека впишите при приёме.
          </Text>
        )}

        {fee && (
        <Stack gap={6}>
          <Text size="xs" c="dimmed" fw={700} tt="uppercase">
            За кого ({receipt.participants.length})
          </Text>
          {receipt.participants.map((p) => (
            <Stack key={p.id} gap={2}>
              <Group justify="space-between" gap="xs" wrap="nowrap">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <ParticipantLink id={p.id} name={p.fullName} />
                  <TierBadge tier={p.tier} tiers={tiers} breakfast={p.breakfast} size="xs" />
                </Stack>
                <PaymentBadge status={p.paymentStatus} size="xs" />
              </Group>
              <PaymentProgress due={Number(p.amountDue ?? 0)} paid={Number(p.amountPaid ?? 0)} status={p.paymentStatus} />
            </Stack>
          ))}
          {receipt.participants.length === 0 && (
            <Text size="sm" c="dimmed">
              Участники не найдены
            </Text>
          )}
          {pending && (dueHint ?? Number(receipt.expectedTotal ?? 0)) > 0 && (
            <Text size="sm">
              Должно быть в чеке: <b>{formatMoney(dueHint ?? Number(receipt.expectedTotal))}</b>
            </Text>
          )}
        </Stack>
        )}

        {!pending && (
          <Text size="xs" c="dimmed">
            {receipt.status === 'accepted' ? 'Принял(а)' : 'Отклонил(а)'} {receipt.reviewerName ?? '-'}
            {receipt.reviewedAt ? ` · ${formatDateTime(receipt.reviewedAt, tz)}` : ''}
            {receipt.status === 'rejected' && receipt.rejectReason ? ` · Причина: ${receipt.rejectReason}` : ''}
          </Text>
        )}

        {pending && canReview && (
          <Group grow gap="xs" mt="auto">
            <Button color="green" leftSection={<IconCheck size={16} />} onClick={acceptModal.open}>
              Принять
            </Button>
            <Button color="red" variant="light" leftSection={<IconX size={16} />} onClick={rejectModal.open}>
              Отклонить
            </Button>
          </Group>
        )}
        <DeleteReceiptButton receipt={receipt} />
      </Stack>

      <AppModal opened={acceptOpened} onClose={acceptModal.close} title={<Text fw={700}>{`Принять чек №${receipt.id}?`}</Text>} size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            doAccept();
          }}
        >
          <Stack gap="md">
            {receipt.kind === 'merch' && (
              <Text size="sm">
                {orderOpen
                  ? `Бронь ${receipt.merchOrder?.code} станет «Оплачено» (${formatMoney(receipt.merchOrder?.total)}), человеку придёт сообщение. Вещи можно выдавать.`
                  : 'Эта бронь уже оплачена или снята - чек нужно отклонить.'}
              </Text>
            )}
            {donation && (
              <TextInput
                label="Сумма пожертвования, руб."
                description="Как в чеке. Пойдёт в журнал денег как пожертвование переводом"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.currentTarget.value)}
                error={amountError}
                data-autofocus
              />
            )}
            {fee && (
            <>
            <Stack gap={6}>
              <Text size="sm" fw={600}>
                За кого засчитать
              </Text>
              {receipt.participants.map((p) => (
                <Checkbox
                  key={p.id}
                  checked={chosen.includes(p.id)}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setChosen((c) => (on ? [...c, p.id] : c.filter((x) => x !== p.id)));
                  }}
                  label={
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm">{p.fullName}</Text>
                      <TierBadge tier={p.tier} tiers={tiers} breakfast={p.breakfast} size="xs" />
                      {p.amountDue && Number(p.amountDue) > 0 && (
                        <Text size="xs" c="dimmed">
                          {formatMoney(p.amountDue)}
                        </Text>
                      )}
                    </Group>
                  }
                />
              ))}
              <Text size="xs" c="dimmed">
                Снятые вернутся в «не оплачено». Человеку придёт сообщение, за кого чек засчитан.
              </Text>
            </Stack>
            <TextInput
              label="Сумма по чеку, руб."
              description={
                chosen.length === 1
                  ? 'Если внесли меньше - человек станет «оплачено частично»'
                  : `Должно быть ${formatMoney(chosenDue)}. Можно не заполнять - каждому засчитаем его остаток`
              }
              placeholder={dueHint ? String(dueHint) : receipt.expectedTotal ? String(Number(receipt.expectedTotal)) : 'например, 35'}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.currentTarget.value)}
              error={amountError}
              data-autofocus
            />
            </>
            )}
            <ModalActions>
              <Button variant="default" onClick={acceptModal.close}>
                Отмена
              </Button>
              <Button type="submit" color="green" loading={accept.isPending} disabled={!canAccept}>
                {!fee || chosen.length === receipt.participants.length ? 'Принять' : `Принять за ${chosen.length}`}
              </Button>
            </ModalActions>
          </Stack>
        </form>
      </AppModal>

      <AppModal opened={rejectOpened} onClose={rejectModal.close} title={<Text fw={700}>{`Отклонить чек №${receipt.id}?`}</Text>} size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            doReject();
          }}
        >
          <Stack gap="md">
            {fee && <Text size="sm">Участники со статусом «Чек на проверке» вернутся в «Не оплачено».</Text>}
            <Textarea
              label="Причина"
              description="Придёт участнику в Telegram"
              placeholder="Например: сумма не совпадает, не виден получатель"
              autosize
              minRows={2}
              maxRows={5}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              data-autofocus
            />
            <ModalActions>
              <Button variant="default" onClick={rejectModal.close}>
                Отмена
              </Button>
              <Button type="submit" color="red" loading={reject.isPending}>
                Отклонить
              </Button>
            </ModalActions>
          </Stack>
        </form>
      </AppModal>
    </Card>
  );
}
