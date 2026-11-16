import {
  Alert,
  Anchor,
  Box,
  Button,
  Card,
  Center,
  Collapse,
  Divider,
  Group,
  List,
  Loader,
  PasswordInput,
  PinInput,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure, useDocumentTitle } from '@mantine/hooks';
import type { SessionInfo } from '@sof/shared';
import { useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconBrandTelegram, IconChevronDown, IconKey, IconStairsUp } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { ApiError, errorMessage } from '../api/client.ts';
import { qk } from '../api/keys.ts';
import { useLoginToken, usePasswordLogin, useSessionQuery } from '../api/session.ts';
import { ColorSchemeControl } from '../components/AppLayout.tsx';
import { cachedEventName } from '../lib/eventName.ts';
import { takeNextPath } from '../lib/nextPath.ts';
import { notifyInfo } from '../lib/notify.tsx';

function readHashToken(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const token = new URLSearchParams(hash).get('token');
  return token && token.length >= 16 ? token : null;
}

function tokenErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 410) return 'Эта ссылка уже не работает - она одноразовая и живёт 15 минут. Откройте админку из бота ещё раз: «Команда» → «Админка».';
    if (error.status === 429) return 'Слишком много попыток подряд. Подождите минутку и попробуйте снова.';
    if (error.status === 403) return error.message || 'Этот аккаунт пока не в команде - попросите организаторов выдать роль.';
    if (error.status === 400) return 'Похоже, ссылка открылась не полностью. Откройте админку из бота ещё раз: «Команда» → «Админка».';
  }
  return errorMessage(error);
}

function passwordErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return error.message || 'Логин, пароль или код не подходят. Проверьте и попробуйте ещё раз.';
    if (error.status === 429) return error.message || 'Слишком много попыток - вход закрыт на 15 минут.';
    if (error.status === 400) return 'Проверьте логин, пароль и 6-значный код.';
  }
  return errorMessage(error);
}

export function LoginPage() {
  const eventName = cachedEventName();
  useDocumentTitle(`Вход · ${eventName}`);
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [token, setToken] = useState<string | null>(readHashToken);
  const session = useSessionQuery();
  const loginToken = useLoginToken();
  const passwordLogin = usePasswordLogin();
  const consumed = useRef<string | null>(null);
  const [passwordOpened, { toggle: togglePassword }] = useDisclosure(false);
  const botUsername = import.meta.env.VITE_BOT_USERNAME?.replace(/^@/, '');

  const finish = (s: SessionInfo) => {
    // Новый вход - возможно, другим человеком: чистый кэш, чтобы не мелькали чужие данные.
    qc.clear();
    qc.setQueryData(qk.session, s);
    navigate(takeNextPath(), { replace: true });
  };

  // Ссылку могли открыть в уже открытой вкладке - тогда меняется только #hash.
  useEffect(() => {
    const onHash = () => {
      const next = readHashToken();
      if (next) setToken(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Вход по одноразовой ссылке из бота: /login#token=…
  useEffect(() => {
    if (!token || consumed.current === token) return;
    consumed.current = token;
    // Токен одноразовый - сразу убираем из адресной строки и истории.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    loginToken.mutate(token, { onSuccess: finish });
  }, [token, loginToken, finish]);

  // Уже вошли (и пришли без ссылки или со старой ссылкой) - сразу внутрь.
  const tokenFailed = loginToken.isError;
  useEffect(() => {
    if (!session.data) return;
    if (token && !tokenFailed) return;
    if (tokenFailed) notifyInfo('Ссылка входа устарела, но вы уже вошли в админку.');
    navigate(takeNextPath(), { replace: true });
  }, [token, tokenFailed, session.data, navigate]);

  const form = useForm({
    mode: 'controlled',
    initialValues: { login: '', password: '', totp: '' },
    validate: {
      login: (v) => (v.trim().length < 3 ? 'Минимум 3 символа' : null),
      password: (v) => (v.length < 8 ? 'Минимум 8 символов' : null),
      totp: (v) => (/^\d{6}$/.test(v) ? null : 'Введите 6 цифр из приложения'),
    },
  });

  const tokenPending = !!token && (loginToken.isPending || loginToken.isIdle);

  return (
    <Box
      mih="100dvh"
      py="xl"
      px="md"
      style={{
        background:
          'radial-gradient(1200px 600px at 10% -10%, rgba(76,110,245,0.18), transparent), radial-gradient(900px 500px at 110% 110%, rgba(21,170,191,0.16), transparent)',
      }}
    >
      <Group justify="flex-end" mb="md">
        <ColorSchemeControl />
      </Group>
      <Center>
        <Card w="100%" maw={440} padding="xl" shadow="md">
          <Stack gap="lg">
            <Group gap="sm" wrap="nowrap">
              <div className="sof-brand-mark" aria-hidden>
                <IconStairsUp size={20} />
              </div>
              <div>
                <Title order={3} lh={1.2}>
                  Вход в админку
                </Title>
                <Text size="sm" c="dimmed">
                  {eventName}
                </Text>
              </div>
            </Group>

            {tokenPending ? (
              <Group gap="sm" py="md" justify="center">
                <Loader size="sm" />
                <Text>Проверяем ссылку…</Text>
              </Group>
            ) : (
              <>
                {loginToken.isError && (
                  <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Не получилось войти по ссылке">
                    {tokenErrorText(loginToken.error)}
                  </Alert>
                )}

                <Stack gap="xs">
                  <Group gap="xs" wrap="nowrap" align="flex-start">
                    <ThemeIcon variant="light" color="cyan" radius="xl" size="lg">
                      <IconBrandTelegram size={18} />
                    </ThemeIcon>
                    <Text fw={600}>Откройте бота → «Команда» → «Админка»</Text>
                  </Group>
                  <List size="sm" c="dimmed" spacing={4} type="ordered" pl="xs">
                    <List.Item>Откройте бота конференции в Telegram и нажмите «📱 Открыть приложение».</List.Item>
                    <List.Item>
                      В приложении нажмите <b>«Команда»</b> → <b>«Админка»</b>.
                    </List.Item>
                    <List.Item>Админка откроется в браузере - сразу с входом, без паролей.</List.Item>
                  </List>
                  {botUsername && (
                    <Button
                      component="a"
                      href={`https://t.me/${encodeURIComponent(botUsername)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      leftSection={<IconBrandTelegram size={18} />}
                      color="cyan"
                      mt="xs"
                    >
                      Открыть бота
                    </Button>
                  )}
                </Stack>

                <Divider
                  label={
                    <Anchor component="button" type="button" size="sm" onClick={togglePassword} c="dimmed">
                      <Group gap={4} wrap="nowrap">
                        Вход по паролю (без Telegram)
                        <IconChevronDown
                          size={14}
                          style={{ transform: passwordOpened ? 'rotate(180deg)' : undefined, transition: 'transform 150ms' }}
                        />
                      </Group>
                    </Anchor>
                  }
                  labelPosition="center"
                />

                <Collapse expanded={passwordOpened}>
                  <form
                    onSubmit={form.onSubmit((values) =>
                      passwordLogin.mutate(
                        { login: values.login.trim(), password: values.password, totp: values.totp },
                        {
                          onSuccess: finish,
                          onError: () => form.setFieldValue('totp', ''),
                        },
                      ),
                    )}
                  >
                    <Stack gap="sm">
                      <Text size="xs" c="dimmed">
                        Логин и пароль выдаёт суперадмин. Код - из приложения-аутентификатора (Google Authenticator,
                        Яндекс Ключ и т. п.).
                      </Text>
                      <TextInput label="Логин" autoComplete="username" required {...form.getInputProps('login')} />
                      <PasswordInput label="Пароль" autoComplete="current-password" required {...form.getInputProps('password')} />
                      <Stack gap={4}>
                        <Text size="sm" fw={500}>
                          Код из приложения
                        </Text>
                        <PinInput
                          length={6}
                          type="number"
                          oneTimeCode
                          inputMode="numeric"
                          aria-label="Шестизначный код"
                          value={form.values.totp}
                          onChange={(v) => form.setFieldValue('totp', v)}
                          error={!!form.errors.totp}
                        />
                        {form.errors.totp && (
                          <Text size="xs" c="red">
                            {form.errors.totp}
                          </Text>
                        )}
                      </Stack>
                      {passwordLogin.isError && (
                        <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />}>
                          {passwordErrorText(passwordLogin.error)}
                        </Alert>
                      )}
                      <Button type="submit" loading={passwordLogin.isPending} leftSection={<IconKey size={16} />}>
                        Войти
                      </Button>
                    </Stack>
                  </form>
                </Collapse>
              </>
            )}
          </Stack>
        </Card>
      </Center>
    </Box>
  );
}
