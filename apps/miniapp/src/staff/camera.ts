/**
 * Распознавание QR в браузере: нативный BarcodeDetector, если он есть и умеет qr_code,
 * иначе - ponyfill barcode-detector на ZXing WebAssembly. WASM отдаётся с нашего домена
 * (Vite кладёт его в dist/assets), никаких CDN.
 */
import { BarcodeDetector as ZXingBarcodeDetector, prepareZXingModule } from 'barcode-detector/ponyfill';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

export interface QrDetector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

interface NativeDetectorCtor {
  new (opts: { formats: string[] }): QrDetector;
  getSupportedFormats(): Promise<string[]>;
}

let detectorPromise: Promise<QrDetector> | null = null;

export function getDetector(): Promise<QrDetector> {
  detectorPromise ??= (async (): Promise<QrDetector> => {
    const Native = (globalThis as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
    if (Native) {
      try {
        const formats = await Native.getSupportedFormats();
        if (formats.includes('qr_code')) return new Native({ formats: ['qr_code'] });
      } catch {
        /* используем ponyfill */
      }
    }
    prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
      },
    });
    return new ZXingBarcodeDetector({ formats: ['qr_code'] });
  })();
  detectorPromise.catch(() => {
    detectorPromise = null;
  });
  return detectorPromise;
}

export function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Нет доступа к камере. Разрешите доступ в настройках браузера и обновите страницу.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Камера не найдена.';
  if (name === 'NotReadableError') return 'Камера занята другим приложением.';
  if (err instanceof Error && err.message === 'unsupported')
    return 'Этот браузер не даёт доступ к камере (нужен HTTPS). Используйте поиск по фамилии.';
  return 'Не удалось запустить камеру. Попробуйте ещё раз или используйте поиск по фамилии.';
}
