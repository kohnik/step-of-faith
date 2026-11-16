import { Button, Stack, Text, TextInput } from '@mantine/core';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { AppModal, ModalActions } from './AppModal.tsx';

export interface ConfirmOptions {
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Красная кнопка - для необратимых действий. */
  danger?: boolean;
  /** Для особо опасных действий: нужно ввести это слово. */
  typeToConfirm?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

/** Модальные подтверждения: `const ok = await confirm({ title, message })`. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [opened, setOpened] = useState(false);
  const [typed, setTyped] = useState('');
  const pendingRef = useRef<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        pendingRef.current?.resolve(false);
        const next = { ...options, resolve };
        pendingRef.current = next;
        setTyped('');
        setPending(next);
        setOpened(true);
      }),
    [],
  );

  const finish = (result: boolean) => {
    pendingRef.current?.resolve(result);
    pendingRef.current = null;
    setOpened(false);
  };

  const needsTyping = !!pending?.typeToConfirm;
  const typedOk = !needsTyping || typed.trim().toLowerCase() === pending?.typeToConfirm?.toLowerCase();

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AppModal
        opened={opened}
        onClose={() => finish(false)}
        title={<Text fw={700}>{pending?.title}</Text>}
        size="md"
        zIndex={400}
        onExitTransitionEnd={() => setPending(null)}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (typedOk) finish(true);
          }}
        >
          <Stack gap="md">
            {pending?.message !== undefined &&
              (typeof pending.message === 'string' ? <Text size="sm">{pending.message}</Text> : pending.message)}
            {needsTyping && (
              <TextInput
                label={
                  <>
                    Чтобы подтвердить, введите <b>{pending?.typeToConfirm}</b>
                  </>
                }
                value={typed}
                onChange={(e) => setTyped(e.currentTarget.value)}
                data-autofocus
              />
            )}
            <ModalActions>
              <Button variant="default" onClick={() => finish(false)}>
                {pending?.cancelLabel ?? 'Отмена'}
              </Button>
              <Button type="submit" color={pending?.danger ? 'red' : undefined} disabled={!typedOk} data-autofocus={!needsTyping || undefined}>
                {pending?.confirmLabel ?? 'Подтвердить'}
              </Button>
            </ModalActions>
          </Stack>
        </form>
      </AppModal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm() вне ConfirmProvider');
  return confirm;
}
