import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../api/client.ts';

export function notifySuccess(message: ReactNode, title?: ReactNode): void {
  notifications.show({
    color: 'green',
    icon: <IconCheck size={18} />,
    title,
    message,
    autoClose: 4000,
  });
}

export function notifyError(error: unknown, title: ReactNode = 'Не получилось'): void {
  notifications.show({
    color: 'red',
    icon: <IconAlertTriangle size={18} />,
    title,
    message: errorMessage(error),
    autoClose: 7000,
  });
}

export function notifyInfo(message: ReactNode, title?: ReactNode): void {
  notifications.show({ color: 'blue', title, message, autoClose: 5000 });
}

export function notifyWarning(message: ReactNode, title: ReactNode = 'Обратите внимание'): void {
  notifications.show({ color: 'yellow', icon: <IconAlertTriangle size={18} />, title, message, autoClose: 9000 });
}
