import { AsyncLocalStorage } from 'node:async_hooks';

/** Какая задача бота сейчас выполняется: ключи шагов (повтор не шлёт дважды) и журнал сообщений («что за отправка»). */
export const jobScope = new AsyncLocalStorage<{ jobId: string; name: string }>();
