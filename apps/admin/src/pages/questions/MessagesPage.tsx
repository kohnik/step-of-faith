import {
  ActionIcon,
  Alert,
  Anchor,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  CloseButton,
  FileButton,
  Group,
  Image,
  Loader,
  Menu,
  Modal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { CHAT_MARK_INFO, CHAT_MARKS, type ChatMark, type ChatMessageView, type ChatPerson, type ChatSearchHit, type ChatThreadRow } from '@sof/shared';
import {
  IconArrowLeft,
  IconCheck,
  IconClock,
  IconDots,
  IconInfoCircle,
  IconMail,
  IconPaperclip,
  IconBell,
  IconPencilPlus,
  IconSearch,
  IconSend,
  IconShirt,
  IconShoppingBag,
  IconX,
} from '@tabler/icons-react';
import { useDebouncedValue, useDocumentTitle } from '@mantine/hooks';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useRoute, useSearch } from 'wouter';
import {
  chatAvatarUrl,
  chatPhotoUrl,
  chatUploadUrl,
  loadEarlier,
  uploadChatPhoto,
  useChatPeople,
  useChatSearch,
  useChatThread,
  useChatThreads,
  useMarkChatRead,
  useMarkChatUnread,
  useSendChat,
  useSetChatMark,
  useSetChatTopic,
  type ChatFilter,
  type ChatFolder,
} from '../../api/chat.ts';
import { useSession } from '../../components/SessionProvider.tsx';
import { ChatNotifyModal } from './ChatNotifyModal.tsx';
import { AppModal, useIsMobile } from '../../components/AppModal.tsx';
import { useEvent, useEventTz } from '../../components/EventProvider.tsx';
import { ParticipantLink } from '../../components/ParticipantLink.tsx';
import { BlockSkeleton, ErrorState } from '../../components/states.tsx';
import { MerchRequestCard, ReserveModal } from './MerchReserve.tsx';
import { capitalizeFirst, formatDayLong, formatDayShort, formatTime, telegramUrl } from '../../lib/format.ts';
import { notifyError } from '../../lib/notify.tsx';
import { dayKey } from '../../lib/tz.ts';

/** Высота окна переписки: экран минус шапка админки и отступы страницы. */
const PANE_HEIGHT = 'calc(100dvh - 60px - 2 * var(--app-shell-padding, 24px))';

function PersonAvatar({ userId, name, avatar, size = 44 }: { userId: number; name: string; avatar: boolean; size?: number }) {
  return <Avatar src={avatar ? chatAvatarUrl(userId) : null} name={name} color="initials" size={size} radius="xl" />;
}

/** «14:05» сегодня, «вчера», иначе «пн, 27 окт.». */
function listTime(iso: string | null, tz: string): string {
  if (!iso) return '';
  const day = dayKey(iso, tz);
  const today = dayKey(new Date(), tz);
  if (day === today) return formatTime(iso, tz);
  if (day === dayKey(new Date(Date.now() - 86_400_000), tz)) return 'вчера';
  return formatDayShort(day);
}

/** Разделитель дней в ленте: «Сегодня», «Вчера», «Понедельник, 27 октября». */
function dayTitle(day: string, tz: string): string {
  if (day === dayKey(new Date(), tz)) return 'Сегодня';
  if (day === dayKey(new Date(Date.now() - 86_400_000), tz)) return 'Вчера';
  return capitalizeFirst(formatDayLong(day));
}

// ---------- список переписок ----------

/** «🛍 Мерч» - переписку ведёт продавец, остальным видно сразу, что отвечать не нужно. */
function MerchBadge() {
  return (
    <Badge size="xs" color="pink" variant="light" style={{ flexShrink: 0 }} title="Папка «Мерч»: отвечает продавец">
      🛍 Мерч
    </Badge>
  );
}

function ThreadRow({
  t,
  active,
  tz,
  merchBadge,
  onOpen,
}: {
  t: ChatThreadRow;
  active: boolean;
  tz: string;
  /** В папке «Мерч» бейдж у всех одинаковый - там не показываем. */
  merchBadge: boolean;
  onOpen: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onOpen}
      px="sm"
      py={10}
      style={{
        display: 'block',
        width: '100%',
        borderRadius: 'var(--mantine-radius-md)',
        background: active ? 'var(--mantine-primary-color-light)' : undefined,
      }}
    >
      <Group gap="sm" wrap="nowrap" align="center">
        <PersonAvatar userId={t.userId} name={t.name} avatar={t.avatar} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Group justify="space-between" gap={6} wrap="nowrap">
            <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
              <Text fw={600} size="sm" truncate>
                {t.mark && (
                  <span title={CHAT_MARK_INFO[t.mark].label} style={{ marginRight: 4 }}>
                    {CHAT_MARK_INFO[t.mark].emoji}
                  </span>
                )}
                {t.name}
              </Text>
              {t.topic === 'merch' && merchBadge && <MerchBadge />}
            </Group>
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              {listTime(t.lastAt, tz)}
            </Text>
          </Group>
          <Group justify="space-between" gap={6} wrap="nowrap">
            <Text size="sm" c="dimmed" truncate>
              {t.lastFromStaff ? 'Вы: ' : ''}
              {t.lastText}
            </Text>
            {t.unread > 0 ? (
              <Badge size="sm" circle={t.unread < 10} variant="filled" style={{ flexShrink: 0 }}>
                {t.unread}
              </Badge>
            ) : (
              t.markedUnread && (
                // Отмечено «непрочитанным» без новых сообщений - просто точка.
                <Box
                  aria-label="Отмечено непрочитанным"
                  style={{ width: 10, height: 10, borderRadius: 999, background: 'var(--mantine-primary-color-filled)', flexShrink: 0 }}
                />
              )
            )}
          </Group>
        </div>
      </Group>
    </UnstyledButton>
  );
}

/** Кусок текста вокруг найденного, найденное - жирным. */
function Snippet({ text, query }: { text: string; query: string }) {
  const norm = (x: string) => x.toLowerCase().replaceAll('ё', 'е');
  const at = norm(text).indexOf(norm(query));
  if (at < 0) return <>{text}</>;
  const start = Math.max(0, at - 30);
  return (
    <>
      {start > 0 ? '…' : ''}
      {text.slice(start, at)}
      <Text span fw={700} c="var(--mantine-color-text)">
        {text.slice(at, at + query.length)}
      </Text>
      {text.slice(at + query.length)}
    </>
  );
}

function HitRow({ h, query, tz, onOpen }: { h: ChatSearchHit; query: string; tz: string; onOpen: () => void }) {
  return (
    <UnstyledButton onClick={onOpen} px="sm" py={8} style={{ display: 'block', width: '100%', borderRadius: 'var(--mantine-radius-md)' }}>
      <Group gap="sm" wrap="nowrap" align="center">
        <PersonAvatar userId={h.userId} name={h.name} avatar={h.avatar} size={36} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Group justify="space-between" gap={6} wrap="nowrap">
            <Text fw={600} size="sm" truncate>
              {h.name}
            </Text>
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              {listTime(h.createdAt, tz)}
            </Text>
          </Group>
          <Text size="sm" c="dimmed" lineClamp={2}>
            {h.fromStaff ? 'Вы: ' : ''}
            <Snippet text={h.text} query={query} />
          </Text>
        </div>
      </Group>
    </UnstyledButton>
  );
}

/** «Написать»: найти человека по фамилии, имени, нику или телефону. */
function NewChatModal({ opened, onClose, onPick }: { opened: boolean; onClose: () => void; onPick: (userId: number) => void }) {
  const [q, setQ] = useState('');
  const people = useChatPeople(q);
  return (
    <AppModal opened={opened} onClose={onClose} title={<Text fw={700}>Написать участнику</Text>}>
      <Stack gap="sm">
        <TextInput
          placeholder="Фамилия, имя, @ник или телефон"
          leftSection={<IconSearch size={16} />}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          data-autofocus
        />
        {q.trim().length < 2 ? (
          <Text size="sm" c="dimmed">
            Начните вводить - найдём участника.
          </Text>
        ) : people.isPending ? (
          <Loader size="sm" />
        ) : (people.data ?? []).length === 0 ? (
          <Text size="sm" c="dimmed">
            Никого не нашли.
          </Text>
        ) : (
          <Stack gap={4}>
            {people.data!.map((p) => (
              <UnstyledButton key={p.userId} onClick={() => onPick(p.userId)} p="xs" style={{ borderRadius: 'var(--mantine-radius-md)' }}>
                <Group gap="sm" wrap="nowrap">
                  <PersonAvatar userId={p.userId} name={p.name} avatar={p.avatar} size={36} />
                  <div style={{ minWidth: 0 }}>
                    <Text fw={600} size="sm" truncate>
                      {p.name}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      {[p.username ? `@${p.username}` : null, p.participants.length > 1 ? `семья: ${p.participants.length}` : null, p.botNote]
                        .filter(Boolean)
                        .join(' · ') || ' '}
                    </Text>
                  </div>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        )}
      </Stack>
    </AppModal>
  );
}

function ThreadList({ activeId, onOpen }: { activeId: number | null; onOpen: (userId: number, messageId?: number) => void }) {
  const tz = useEventTz();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');
  // Продавец видит только «Мерч» (сервер сам отдаёт только его) - выбор папки ему не нужен.
  const allChats = useSession().can('content:write');
  const canNotify = useSession().can('settings:write');
  const [folder, setFolder] = useState<ChatFolder>('all');
  const [newOpen, setNewOpen] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [q] = useDebouncedValue(search.trim(), 250);
  const threads = useChatThreads(q, filter, allChats ? folder : 'all');
  // Поиск по тексту - отдельным блоком под переписками, как в Telegram.
  const hits = useChatSearch(filter === 'all' ? q : '');
  const showHits = filter === 'all' && q.length >= 2;
  return (
    <Stack gap={0} h="100%">
      <Stack gap="xs" p="sm" pb="xs">
        <Group gap="xs" wrap="nowrap">
          <TextInput
            placeholder="Имя, фамилия или текст сообщения"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Tooltip label="Написать участнику">
            <ActionIcon size="lg" variant="light" onClick={() => setNewOpen(true)} aria-label="Написать участнику">
              <IconPencilPlus size={18} />
            </ActionIcon>
          </Tooltip>
          {canNotify && (
            <Tooltip label="Копии сообщений в Telegram">
              <ActionIcon size="lg" variant="default" onClick={() => setNotifyOpen(true)} aria-label="Копии сообщений в Telegram">
                <IconBell size={18} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        <ChatNotifyModal opened={notifyOpen} onClose={() => setNotifyOpen(false)} />
        <SegmentedControl
          size="xs"
          fullWidth
          value={filter}
          onChange={(v) => setFilter(v as ChatFilter)}
          data={[
            { value: 'all', label: 'Все' },
            { value: 'unread', label: 'Непрочитанные' },
            { value: 'marked', label: 'С отметкой' },
          ]}
        />
        {allChats ? (
          <SegmentedControl
            size="xs"
            fullWidth
            value={folder}
            onChange={(v) => setFolder(v as ChatFolder)}
            data={[
              { value: 'all', label: 'Все папки' },
              { value: 'merch', label: '🛍 Мерч' },
              { value: 'other', label: 'Без мерча' },
            ]}
          />
        ) : (
          <Text size="xs" c="dimmed">
            🛍 Папка «Мерч»: вопросы про мерч
          </Text>
        )}
      </Stack>
      <ScrollArea style={{ flex: 1 }} px={6} pb={6}>
        {threads.isPending ? (
          <BlockSkeleton rows={6} height={52} />
        ) : threads.isError ? (
          <ErrorState error={threads.error} onRetry={() => void threads.refetch()} />
        ) : (
          <>
            {showHits && threads.data.length > 0 && <SectionTitle>Переписки</SectionTitle>}
            {threads.data.length === 0 && !(showHits && (hits.data?.length ?? 0) > 0) && (
              <Text size="sm" c="dimmed" p="sm">
                {search || filter !== 'all'
                  ? 'Ничего не нашли.'
                  : folder === 'merch' || !allChats
                    ? 'В папке «Мерч» пока пусто. Сюда попадают вопросы из раздела «Мерч» в мини-аппе и сообщения про мерч, размеры, бронь.'
                    : 'Сообщений пока нет. Нажмите карандаш, чтобы написать участнику первым.'}
              </Text>
            )}
            {threads.data.map((t) => (
              <ThreadRow
                key={t.userId}
                t={t}
                tz={tz}
                active={t.userId === activeId}
                merchBadge={allChats && folder !== 'merch'}
                onOpen={() => onOpen(t.userId)}
              />
            ))}
            {showHits && (hits.data?.length ?? 0) > 0 && (
              <>
                <SectionTitle>Сообщения: {hits.data!.length >= 50 ? 'последние 50' : hits.data!.length}</SectionTitle>
                {hits.data!.map((h) => (
                  <HitRow key={h.messageId} h={h} query={q} tz={tz} onOpen={() => onOpen(h.userId, h.messageId)} />
                ))}
              </>
            )}
          </>
        )}
      </ScrollArea>
      <NewChatModal
        opened={newOpen}
        onClose={() => setNewOpen(false)}
        onPick={(id) => {
          setNewOpen(false);
          onOpen(id);
        }}
      />
    </Stack>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" pt="sm" pb={4}>
      {children}
    </Text>
  );
}

// ---------- переписка ----------

function DeliveryMark({ m }: { m: ChatMessageView }) {
  if (!m.fromStaff) return null;
  if (m.delivery === null) return <IconClock size={12} style={{ opacity: 0.7 }} aria-label="Отправляем" />;
  if (m.delivery === 'sent') return <IconCheck size={12} style={{ opacity: 0.8 }} aria-label="Доставлено в бот" />;
  // Бот не смог написать (не запускал или остановил бота, нет Telegram) - сообщение всё равно видно в приложении.
  return (
    <Tooltip label="Бот не смог написать человеку. Сообщение видно в приложении: «Написать организаторам»." multiline w={240}>
      <Text span size="xs" fw={600} style={{ opacity: 0.85 }}>
        только в приложении
      </Text>
    </Tooltip>
  );
}

function Bubble({
  m,
  tz,
  onPhoto,
  onMedia,
  onReserve,
}: {
  m: ChatMessageView;
  tz: string;
  onPhoto: (id: number) => void;
  onMedia: () => void;
  /** Заявка на бронь: продавец бронирует по ней; null - нет права. */
  onReserve: ((m: ChatMessageView) => void) | null;
}) {
  const mine = m.fromStaff;
  // У заявки вещи - в карточке; из текста показываем только комментарий человека (он после пустой строки).
  const text = m.merch ? m.text?.split('\n\n').slice(1).join('\n\n') || null : m.text;
  return (
    <Group justify={mine ? 'flex-end' : 'flex-start'} wrap="nowrap" px="sm">
      <Box
        maw={m.merch ? 'min(88%, 560px)' : 'min(72%, 560px)'}
        px={m.photo && !m.text ? 4 : 12}
        py={m.photo && !m.text ? 4 : 8}
        style={{
          borderRadius: 16,
          borderBottomRightRadius: mine ? 4 : 16,
          borderBottomLeftRadius: mine ? 16 : 4,
          background: mine ? 'var(--mantine-primary-color-filled)' : 'var(--mantine-color-default-hover)',
          color: mine ? 'var(--mantine-color-white)' : undefined,
        }}
      >
        {mine && m.author && (
          <Text size="xs" fw={700} mb={2} style={{ opacity: 0.85 }}>
            {m.author}
          </Text>
        )}
        {m.photo && (
          <UnstyledButton onClick={() => onPhoto(m.id)} display="block" mb={m.text ? 6 : 0}>
            <Image src={chatPhotoUrl(m.id, true)} alt="Картинка" radius={12} maw={320} mah={320} fit="cover" onLoad={onMedia} />
          </UnstyledButton>
        )}
        {text && (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {text}
          </Text>
        )}
        {m.merch && <MerchRequestCard request={m.merch} canReserve={onReserve !== null} onReserve={() => onReserve?.(m)} />}
        <Group gap={4} justify="flex-end" mt={2} px={m.photo && !m.text ? 8 : 0} pb={m.photo && !m.text ? 4 : 0}>
          <DeliveryMark m={m} />
          <Text size="xs" style={{ opacity: 0.7 }}>
            {formatTime(m.createdAt, tz)}
          </Text>
        </Group>
      </Box>
    </Group>
  );
}

function Composer({ userId, person }: { userId: number; person: ChatPerson }) {
  const send = useSendChat();
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const ready = (text.trim() !== '' || photo !== null) && !uploading;
  // Черновик у каждой переписки свой: сменили человека - поле пустое.
  useEffect(() => {
    setText('');
    setPhoto(null);
  }, [userId]);

  const attach = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      setPhoto((await uploadChatPhoto(file)).photo);
    } catch (err) {
      notifyError(err, 'Картинка не загрузилась');
    } finally {
      setUploading(false);
    }
  };
  const submit = () => {
    if (!ready || send.isPending) return;
    send.mutate(
      { userId, text: text.trim() || null, photo },
      {
        onSuccess: () => {
          setText('');
          setPhoto(null);
        },
        onError: (err) => notifyError(err, 'Не отправилось'),
      },
    );
  };

  return (
    <Box p="sm" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
      {photo && (
        <Group gap="xs" mb="xs" align="flex-start">
          <Image src={chatUploadUrl(photo)} alt="Картинка" h={72} w="auto" radius="md" />
          <CloseButton size="sm" onClick={() => setPhoto(null)} aria-label="Убрать картинку" />
        </Group>
      )}
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <FileButton onChange={(f) => void attach(f)} accept="image/jpeg,image/png,image/webp">
          {(props) => (
            <ActionIcon {...props} size="lg" variant="subtle" loading={uploading} aria-label="Прикрепить картинку">
              <IconPaperclip size={20} />
            </ActionIcon>
          )}
        </FileButton>
        <Textarea
          placeholder={person.botNote ? 'Сообщение (увидит в приложении)' : 'Сообщение'}
          autosize
          minRows={1}
          maxRows={8}
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Enter - отправить, Shift+Enter - новая строка.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          style={{ flex: 1 }}
        />
        <ActionIcon size="lg" onClick={submit} disabled={!ready} loading={send.isPending} aria-label="Отправить">
          <IconSend size={18} />
        </ActionIcon>
      </Group>
    </Box>
  );
}

function ChatPane({ userId, focusId, onBack }: { userId: number; focusId: number | null; onBack: (() => void) | null }) {
  const tz = useEventTz();
  const thread = useChatThread(userId);
  const markRead = useMarkChatRead();
  const markUnread = useMarkChatUnread();
  const setMark = useSetChatMark();
  const setTopic = useSetChatTopic();
  const session = useSession();
  const allChats = session.can('content:write');
  const canReserve = session.can('merch:sell');
  /** Бронь человеку: по заявке из сообщения или сама (из меню). */
  const [reserving, setReserving] = useState<{ messageId: number | null; items: NonNullable<ChatMessageView['merch']>['items'] } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [older, setOlder] = useState<ChatMessageView[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [photoOf, setPhotoOf] = useState<number | null>(null);
  const keepScroll = useRef<number | null>(null);
  // Внизу ли лента: тогда новые сообщения и догрузившиеся картинки держат её внизу.
  const atBottom = useRef(true);
  const toBottom = () => {
    const el = viewport.current;
    if (el && atBottom.current) el.scrollTo({ top: el.scrollHeight });
  };

  useEffect(() => {
    setOlder([]);
    setHasMoreOlder(null);
  }, [userId]);

  const latest = thread.data?.messages ?? [];
  const messages = useMemo(() => {
    const seen = new Set(latest.map((m) => m.id));
    return [...older.filter((m) => !seen.has(m.id)), ...latest];
  }, [older, latest]);
  const hasMore = hasMoreOlder ?? thread.data?.hasMore ?? false;
  const lastId = latest.at(-1)?.id ?? 0;

  // Открыли переписку или пришло новое - отмечаем прочитанным и прокручиваем вниз.
  useEffect(() => {
    if (!lastId) return;
    markRead.mutate(userId);
    toBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, lastId]);

  // Подгрузили раньше - оставляем экран на том же сообщении.
  useLayoutEffect(() => {
    const el = viewport.current;
    if (el && keepScroll.current !== null) {
      el.scrollTop = el.scrollHeight - keepScroll.current;
      keepScroll.current = null;
    }
  }, [older]);

  const showEarlier = async () => {
    const first = messages[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const page = await loadEarlier(userId, first.id);
      keepScroll.current = viewport.current ? viewport.current.scrollHeight - viewport.current.scrollTop : null;
      setOlder((prev) => [...page.messages, ...prev]);
      setHasMoreOlder(page.hasMore);
    } catch (err) {
      notifyError(err);
    } finally {
      setLoadingOlder(false);
    }
  };

  // Открыли из поиска: листаем вверх, пока не дойдём до найденного сообщения, и подсвечиваем его.
  const [highlight, setHighlight] = useState<number | null>(null);
  const focusDone = useRef<number | null>(null);
  useEffect(() => {
    if (!focusId || focusDone.current === focusId || thread.isPending || loadingOlder) return;
    if (messages.some((m) => m.id === focusId)) {
      focusDone.current = focusId;
      atBottom.current = false;
      requestAnimationFrame(() => document.getElementById(`msg-${focusId}`)?.scrollIntoView({ block: 'center' }));
      setHighlight(focusId);
      const t = window.setTimeout(() => setHighlight(null), 2500);
      return () => window.clearTimeout(t);
    }
    if (hasMore) void showEarlier();
    else focusDone.current = focusId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, messages, hasMore, loadingOlder, thread.isPending]);

  if (thread.isPending) return <BlockSkeleton rows={6} height={40} />;
  if (thread.isError) return <ErrorState error={thread.error} onRetry={() => void thread.refetch()} />;
  const person = thread.data.person;
  const mark: ChatMark | null = thread.data.mark ?? null;
  const tg = telegramUrl(person.username);

  return (
    <Stack gap={0} h="100%">
      <Group gap="sm" p="sm" wrap="nowrap" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
        {onBack && (
          <ActionIcon variant="subtle" onClick={onBack} aria-label="К списку">
            <IconArrowLeft size={20} />
          </ActionIcon>
        )}
        <PersonAvatar userId={person.userId} name={person.name} avatar={person.avatar} size={40} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6} wrap="nowrap">
            <Text fw={700} truncate>
              {mark && <span style={{ marginRight: 6 }}>{CHAT_MARK_INFO[mark].emoji}</span>}
              {person.name}
            </Text>
            {allChats && thread.data.topic === 'merch' && <MerchBadge />}
          </Group>
          <Group gap={8} wrap="wrap">
            {tg && (
              <Anchor href={tg} target="_blank" size="xs">
                @{person.username}
              </Anchor>
            )}
            {person.participants.map((p) => (
              <ParticipantLink key={p.id} id={p.id} name={p.name} size="xs" />
            ))}
          </Group>
        </div>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" size="lg" aria-label="Отметки переписки">
              <IconDots size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconMail size={16} />}
              onClick={() =>
                markUnread.mutate(userId, {
                  onSuccess: () => onBack?.(),
                  onError: (err) => notifyError(err),
                })
              }
            >
              Отметить непрочитанным
            </Menu.Item>
            {canReserve && (
              <Menu.Item leftSection={<IconShoppingBag size={16} />} onClick={() => setReserving({ messageId: null, items: [] })}>
                Забронировать мерч
              </Menu.Item>
            )}
            {allChats && (
              <Menu.Item
                leftSection={<IconShirt size={16} />}
                onClick={() =>
                  setTopic.mutate(
                    { userId, topic: thread.data.topic === 'merch' ? null : 'merch' },
                    { onError: (err) => notifyError(err) },
                  )
                }
              >
                {thread.data.topic === 'merch' ? 'Убрать из папки «Мерч»' : 'Перенести в папку «Мерч»'}
              </Menu.Item>
            )}
            <Menu.Divider />
            <Menu.Label>Отметка</Menu.Label>
            {CHAT_MARKS.map((m) => (
              <Menu.Item
                key={m}
                leftSection={<span style={{ width: 16, textAlign: 'center' }}>{CHAT_MARK_INFO[m].emoji}</span>}
                rightSection={mark === m ? <IconCheck size={14} /> : null}
                onClick={() => setMark.mutate({ userId, mark: mark === m ? null : m }, { onError: (err) => notifyError(err) })}
              >
                {CHAT_MARK_INFO[m].label}
              </Menu.Item>
            ))}
            {mark && (
              <Menu.Item leftSection={<IconX size={16} />} color="red" onClick={() => setMark.mutate({ userId, mark: null }, { onError: (err) => notifyError(err) })}>
                Снять отметку
              </Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>
      </Group>
      {person.botNote && (
        <Alert color="yellow" variant="light" radius={0} py={6} icon={<IconInfoCircle size={16} />}>
          <Text size="xs">{person.botNote}</Text>
        </Alert>
      )}

      <ScrollArea
        viewportRef={viewport}
        style={{ flex: 1 }}
        py="sm"
        onScrollPositionChange={() => {
          const el = viewport.current;
          if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <Stack gap={6}>
          {hasMore && (
            <Group justify="center">
              <Button size="xs" variant="subtle" loading={loadingOlder} onClick={() => void showEarlier()}>
                Показать раньше
              </Button>
            </Group>
          )}
          {messages.length === 0 && (
            <Text size="sm" c="dimmed" ta="center" py="xl">
              Сообщений пока нет - напишите первым.
            </Text>
          )}
          {messages.map((m, i) => {
            const day = dayKey(m.createdAt, tz);
            const newDay = i === 0 || dayKey(messages[i - 1]!.createdAt, tz) !== day;
            return (
              <Box key={m.id} id={`msg-${m.id}`}>
                {newDay && (
                  <Group justify="center" my={6}>
                    <Badge variant="light" color="gray" tt="none" fw={500}>
                      {dayTitle(day, tz)}
                    </Badge>
                  </Group>
                )}
                <Box
                  py={2}
                  style={{ transition: 'background-color 0.8s', backgroundColor: highlight === m.id ? 'var(--mantine-color-yellow-light)' : undefined }}
                >
                  <Bubble
                    m={m}
                    tz={tz}
                    onPhoto={setPhotoOf}
                    onMedia={toBottom}
                    onReserve={canReserve ? (x) => setReserving({ messageId: x.id, items: x.merch?.items ?? [] }) : null}
                  />
                </Box>
              </Box>
            );
          })}
        </Stack>
      </ScrollArea>

      <Composer userId={userId} person={person} />
      <ReserveModal
        opened={reserving !== null}
        onClose={() => setReserving(null)}
        userId={userId}
        messageId={reserving?.messageId ?? null}
        items={reserving?.items ?? []}
      />
      <Modal opened={photoOf !== null} onClose={() => setPhotoOf(null)} size="auto" centered withCloseButton padding={4}>
        {photoOf !== null && <Image src={chatPhotoUrl(photoOf)} alt="Картинка" mah="85dvh" maw="90vw" fit="contain" />}
      </Modal>
    </Stack>
  );
}

// ---------- страница ----------

/** Сообщения: слева переписки, справа открытая переписка (на телефоне - по очереди). */
export default function MessagesPage() {
  const mobile = useIsMobile();
  const { eventName } = useEvent();
  // Заголовка страницы нет (переписка во весь экран) - название вкладки ставим сами.
  useDocumentTitle(`Сообщения · ${eventName}`);
  const [, params] = useRoute<{ id?: string }>('/messages/:id?');
  const [, navigate] = useLocation();
  const activeId = params?.id ? Number(params.id) || null : null;
  const focusId = Number(new URLSearchParams(useSearch()).get('m')) || null;
  const open = (id: number | null, messageId?: number) => navigate(id ? `/messages/${id}${messageId ? `?m=${messageId}` : ''}` : '/messages');

  const list = <ThreadList activeId={activeId} onOpen={open} />;
  const pane =
    activeId !== null ? (
      <ChatPane key={activeId} userId={activeId} focusId={focusId} onBack={mobile ? () => open(null) : null} />
    ) : (
      <Stack h="100%" align="center" justify="center" gap={4}>
        <Text c="dimmed">Выберите переписку слева</Text>
        <Text size="sm" c="dimmed" ta="center" px="md">
          или нажмите карандаш, чтобы написать участнику первым
        </Text>
      </Stack>
    );

  return (
    <Card withBorder radius="md" p={0} h={PANE_HEIGHT} mih={420} style={{ overflow: 'hidden' }}>
      {mobile ? (
        activeId !== null ? pane : list
      ) : (
        <Group gap={0} h="100%" wrap="nowrap" align="stretch">
          <Box w={340} style={{ borderRight: '1px solid var(--mantine-color-default-border)', flexShrink: 0 }}>
            {list}
          </Box>
          <Box style={{ flex: 1, minWidth: 0 }}>{pane}</Box>
        </Group>
      )}
    </Card>
  );
}
