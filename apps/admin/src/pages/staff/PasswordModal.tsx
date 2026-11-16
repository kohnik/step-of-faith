import {
  Alert,
  Button,
  Card,
  Code,
  Group,
  List,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { staffPasswordSchema, type StaffMember, type StaffPasswordResponse } from '@sof/shared';
import { IconAlertTriangle, IconDice5, IconKey, IconShieldLock } from '@tabler/icons-react';
import { useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { useSetPassword } from '../../api/staff.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { CopyIconButton } from '../../components/CopyValue.tsx';
import { QrCode } from '../../components/QrCode.tsx';
import { schemaErrors } from '../../lib/validation.ts';

const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generatePassword(length = 14): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}

function totpSecret(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get('secret');
  } catch {
    return null;
  }
}

export function PasswordModal({ member, opened, onClose }: { member: StaffMember | null; opened: boolean; onClose: () => void }) {
  return (
    <AppModal
      opened={opened && member !== null}
      onClose={onClose}
      title={<Text fw={700}>Вход без Telegram{member ? ` · ${member.name}` : ''}</Text>}
      size="lg"
      closeOnClickOutside={false}
    >
      {member && <PasswordForm key={member.userId} member={member} onDone={onClose} />}
    </AppModal>
  );
}

function PasswordForm({ member, onDone }: { member: StaffMember; onDone: () => void }) {
  const setPassword = useSetPassword();
  const [result, setResult] = useState<{ response: StaffPasswordResponse; password: string } | null>(null);
  const form = useForm({
    mode: 'controlled',
    initialValues: { login: member.username ?? '', password: '' },
    validate: (v) => schemaErrors(staffPasswordSchema, { login: v.login.trim(), password: v.password }),
  });

  if (result) {
    const secret = totpSecret(result.response.totpUri);
    return (
      <Stack gap="md">
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="QR-код показывается один раз">
          После закрытия окна его нельзя будет открыть снова - только задать пароль заново (старый код перестанет работать).
        </Alert>
        <Card withBorder padding="md" radius="md">
          <Group gap="lg" wrap="wrap" align="flex-start">
            <QrCode value={result.response.totpUri} size={190} level="M" label="QR-код для приложения-аутентификатора" />
            <Stack gap="xs" style={{ flex: '1 1 240px' }}>
              <Text fw={700}>Как подключить</Text>
              <List size="sm" type="ordered" spacing={4}>
                <List.Item>Установите Google Authenticator или Яндекс Ключ.</List.Item>
                <List.Item>Нажмите «Добавить» → «Сканировать QR-код» и наведите камеру на этот код.</List.Item>
                <List.Item>При входе в админку введите логин, пароль и 6 цифр из приложения.</List.Item>
              </List>
              {secret && (
                <Text size="xs" c="dimmed">
                  Если камера недоступна - ключ для ручного ввода: <Code>{secret}</Code> <CopyIconButton value={secret} size="xs" />
                </Text>
              )}
            </Stack>
          </Group>
        </Card>
        <Card withBorder padding="sm" radius="md">
          <Group gap="xl" wrap="wrap">
            <Group gap={4}>
              <Text size="sm" c="dimmed">
                Логин:
              </Text>
              <Code fz="sm">{result.response.login}</Code>
              <CopyIconButton value={result.response.login} />
            </Group>
            <Group gap={4}>
              <Text size="sm" c="dimmed">
                Пароль:
              </Text>
              <Code fz="sm">{result.password}</Code>
              <CopyIconButton value={result.password} />
            </Group>
          </Group>
          <Text size="xs" c="dimmed" mt={6}>
            Передайте логин и пароль лично - не пересылайте в общих чатах.
          </Text>
        </Card>
        <ModalActions>
          <Button onClick={onDone}>Готово, код отсканирован</Button>
        </ModalActions>
      </Stack>
    );
  }

  return (
    <form
      onSubmit={form.onSubmit((values) => {
        const login = values.login.trim();
        setPassword.mutate(
          { userId: member.userId, login, password: values.password },
          {
            onSuccess: (response) => setResult({ response, password: values.password }),
            onError: (err) => {
              if (err instanceof ApiError && err.code === 'login_taken') form.setFieldError('login', 'Этот логин уже занят');
            },
          },
        );
      })}
      noValidate
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Запасной вход в админку для {member.name}: логин, пароль и одноразовый код из приложения-аутентификатора.
          {member.hasPassword ? ' Пароль уже задан - новый заменит старый, старый код из приложения перестанет работать.' : ''}
        </Text>
        <TextInput label="Логин" required leftSection={<IconKey size={16} />} autoComplete="off" autoCapitalize="none" {...form.getInputProps('login')} />
        <Group align="flex-end" gap="xs" wrap="nowrap">
          <PasswordInput
            label="Пароль"
            description="Не короче 10 символов"
            required
            autoComplete="new-password"
            style={{ flex: 1 }}
            {...form.getInputProps('password')}
          />
          <Tooltip label="Сгенерировать надёжный пароль">
            <Button variant="default" leftSection={<IconDice5 size={16} />} onClick={() => form.setFieldValue('password', generatePassword())}>
              Создать
            </Button>
          </Tooltip>
        </Group>
        {form.values.password && (
          <Text size="xs" c="dimmed">
            Пароль: <Code>{form.values.password}</Code>
          </Text>
        )}
        <ModalActions>
          <Button variant="default" onClick={onDone}>
            Отмена
          </Button>
          <Button type="submit" loading={setPassword.isPending} leftSection={<IconShieldLock size={16} />}>
            Задать пароль
          </Button>
        </ModalActions>
      </Stack>
    </form>
  );
}
