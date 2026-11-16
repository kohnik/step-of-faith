/**
 * Безопасные обёртки над localStorage/sessionStorage: в приватном режиме, при переполнении
 * или в песочнице доступ к хранилищу бросает исключения - приложение не должно падать.
 */
interface SafeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  getJSON<T>(key: string): T | null;
  setJSON(key: string, value: unknown): void;
}

function wrap(getStorage: () => Storage): SafeStorage {
  const api: SafeStorage = {
    get(key) {
      try {
        return getStorage().getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        getStorage().setItem(key, value);
      } catch {
        /* хранилище недоступно - работаем без него */
      }
    },
    remove(key) {
      try {
        getStorage().removeItem(key);
      } catch {
        /* ignore */
      }
    },
    getJSON<T>(key: string): T | null {
      const raw = api.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    setJSON(key, value) {
      api.set(key, JSON.stringify(value));
    },
  };
  return api;
}

export const local = wrap(() => window.localStorage);
export const session = wrap(() => window.sessionStorage);
