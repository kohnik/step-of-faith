import { useEffect, useRef, useState } from 'react';

/** Сколько держим подсветку новой строки. */
export const FRESH_MS = 3000;

/**
 * Какие id появились в списке с прошлого обновления (например, только что отсканированные).
 * При первой загрузке ничего не подсвечиваем. Через `FRESH_MS` подсветка снимается.
 */
export function useFreshIds(ids: readonly number[] | undefined): ReadonlySet<number> {
  const seen = useRef<Set<number> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!ids) return;
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const known = seen.current;
    const added = ids.filter((id) => !known.has(id));
    seen.current = new Set(ids);
    if (added.length === 0) return;
    setFresh(new Set(added));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFresh(new Set()), FRESH_MS);
  }, [ids]);

  return fresh;
}
