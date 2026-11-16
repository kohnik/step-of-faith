/** Куда вернуться после входа (sessionStorage, только внутренние пути). */
const NEXT_KEY = 'sof.admin.next';

/** Запомнить, куда вернуться после входа (только внутренние пути). */
export function rememberNextPath(path: string): void {
  try {
    if (path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/login')) sessionStorage.setItem(NEXT_KEY, path);
  } catch {
    /* ignore */
  }
}

export function takeNextPath(): string {
  try {
    const next = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login')) return next;
  } catch {
    /* ignore */
  }
  return '/';
}
