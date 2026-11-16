import { toDataURL } from 'qrcode';
import { useEffect, useState } from 'react';
import { cx, Spinner } from './kit.tsx';

/**
 * QR-код строится на устройстве из кода (без сети): коррекция Q, поле 4 модуля, чёрный на белом.
 * PNG в <img> - его можно долго нажать и сохранить в галерею.
 */
export function TicketQr({ code, dimmed, className }: { code: string; dimmed?: boolean; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    toDataURL(code, {
      errorCorrectionLevel: 'Q',
      margin: 4,
      width: 720,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div
      className={cx(
        'relative mx-auto flex aspect-square w-[min(80vw,340px)] items-center justify-center overflow-hidden rounded-2xl bg-white',
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt={`QR-код для входа ${code}`}
          className={cx('size-full select-none', dimmed && 'opacity-15 blur-[3px]')}
          style={{ imageRendering: 'pixelated' }}
          draggable={false}
        />
      ) : failed ? (
        <span className="px-6 text-center text-sm text-black">Не получилось показать QR-код. Покажите код под ним.</span>
      ) : (
        <Spinner className="size-8 text-black" />
      )}
    </div>
  );
}
