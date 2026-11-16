import type { ReactNode } from 'react';
import { IconCopy } from '@tabler/icons-react';
import { copyText } from '../telegram/actions.ts';
import { toast } from '../ui/toast.tsx';

/**
 * Реквизиты с копированием по нажатию: номера вида «35862-1-1», длинные цифры (счёт, телефон)
 * и всё, что в настройках взято в `обратные кавычки`. Остальной текст - как есть.
 */
const COPYABLE = /`([^`\n]+)`|(\+?\d+(?:-\d+)+|\+?\d{6,})/g;

export function CopyableText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(COPYABLE)) {
    const value = m[1] ?? m[2]!;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <button
        key={m.index}
        type="button"
        onClick={async () => {
          if (await copyText(value)) toast.success(`Скопировано: ${value}`);
          else toast.error('Не получилось скопировать');
        }}
        className="inline-flex items-center gap-1 rounded-md bg-fill px-1.5 font-semibold text-accent active:opacity-70"
      >
        {value}
        <IconCopy size={15} aria-label="Скопировать" />
      </button>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
