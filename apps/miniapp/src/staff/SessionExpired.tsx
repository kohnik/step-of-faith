import { Notice } from '../ui/kit.tsx';
import { useSessionExpired } from './session.ts';

/** Сессия истекла и сама не продлилась - пока приложение не переоткроют, отметки копятся на телефоне. */
export function SessionExpiredNotice() {
  const expired = useSessionExpired();
  if (!expired) return null;
  return (
    <Notice tone="red" className="mb-3">
      <p className="font-semibold">Сессия истекла</p>
      <p className="mt-0.5 text-[14px]">Закройте приложение и откройте заново. Отметки сохранены на телефоне и уйдут после входа.</p>
    </Notice>
  );
}
