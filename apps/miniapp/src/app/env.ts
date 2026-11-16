import { createContext, useContext } from 'react';

export type AppMode = 'telegram' | 'browser';

export interface AppEnv {
  /** telegram - Mini App внутри Telegram (или dev-имитация), browser - обычный браузер. */
  mode: AppMode;
  /** Окружение Telegram имитируется (только `vite dev`). */
  mocked: boolean;
}

export const EnvContext = createContext<AppEnv>({ mode: 'browser', mocked: false });

export function useEnv(): AppEnv {
  return useContext(EnvContext);
}
