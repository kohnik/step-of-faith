import { isStaff, type Role } from '@sof/shared';
import type { Api, GrammyError } from 'grammy';
import type { BotCommand } from 'grammy/types';

export function participantCommands(payments: boolean): BotCommand[] {
  return [
    { command: 'start', description: 'Главное меню' },
    { command: 'qr', description: 'Прислать QR-коды в чат' },
    ...(payments ? [{ command: 'pay', description: 'Оплата' }] : []),
  ];
}

export function staffCommands(payments: boolean): BotCommand[] {
  return [
    ...participantCommands(payments),
    { command: 'scanner', description: 'Сканер на входе' },
  ];
}

/** Команды «/» у каждого свои: сотрудник видит служебные, участник - нет. */
export async function syncChatCommands(api: Api, chatId: number, roles: Role[], payments: boolean): Promise<void> {
  const scope = { type: 'chat' as const, chat_id: chatId };
  try {
    if (isStaff(roles)) await api.setMyCommands(staffCommands(payments), { scope });
    else await api.deleteMyCommands({ scope });
  } catch (err) {
    if ((err as GrammyError).error_code !== 400) throw err;
  }
}
