import { create } from 'qrcode';
import { useMemo } from 'react';

/**
 * QR-код как SVG - чёткий и на экране, и при печати. Матрицу считает библиотека
 * `qrcode`, рисуем сами (без innerHTML).
 */
export function QrCode({
  value,
  size = 200,
  level = 'M',
  margin = 2,
  label = 'QR-код',
}: {
  value: string;
  size?: number | string;
  level?: 'L' | 'M' | 'Q' | 'H';
  margin?: number;
  label?: string;
}) {
  const { path, dim } = useMemo(() => {
    const qr = create(value, { errorCorrectionLevel: level });
    const n = qr.modules.size;
    const parts: string[] = [];
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (qr.modules.get(row, col)) parts.push(`M${col + margin} ${row + margin}h1v1h-1z`);
      }
    }
    return { path: parts.join(''), dim: n + margin * 2 };
  }, [value, level, margin]);

  return (
    <svg
      viewBox={`0 0 ${dim} ${dim}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
      style={{ display: 'block', borderRadius: 8 }}
    >
      <rect width={dim} height={dim} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
