import { useEffect, useRef, useState } from 'react';
import { IconBulb, IconBulbFilled, IconX } from '@tabler/icons-react';
import { Button, cx, Spinner } from '../ui/kit.tsx';
import { cameraErrorMessage, getDetector } from './camera.ts';

/**
 * Камера на странице (браузерный сканер; внутри Telegram - только по явной кнопке).
 * Распознавание идёт ~7 раз в секунду; пока открыт результат, кадры не обрабатываются.
 */
export default function CameraScanner({
  paused,
  onRead,
  onClose,
}: {
  paused: boolean;
  onRead: (text: string) => void;
  onClose?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const readRef = useRef(onRead);
  readRef.current = onRead;
  const [status, setStatus] = useState<'starting' | 'running' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState({ supported: false, on: false });
  const [restart, setRestart] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let stream: MediaStream | null = null;
    setStatus('starting');
    setError(null);
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
        const [detector, media] = await Promise.all([
          getDetector(),
          navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          }),
        ]);
        stream = media;
        if (stopped || !videoRef.current) {
          media.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        video.srcObject = media;
        await video.play().catch(() => undefined);
        const track = media.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        const caps =
          track && typeof track.getCapabilities === 'function'
            ? (track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean })
            : null;
        setTorch({ supported: Boolean(caps?.torch), on: false });
        setStatus('running');
        const loop = async () => {
          if (stopped) return;
          if (!pausedRef.current && video.readyState >= 2) {
            try {
              const codes = await detector.detect(video);
              const text = codes.find((c) => c.rawValue)?.rawValue;
              if (text && !stopped && !pausedRef.current) readRef.current(text);
            } catch {
              /* кадр не распознан */
            }
          }
          timer = window.setTimeout(() => void loop(), 140);
        };
        void loop();
      } catch (err) {
        if (!stopped) {
          setStatus('error');
          setError(cameraErrorMessage(err));
        }
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      trackRef.current = null;
    };
  }, [restart]);

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track) return;
    const on = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch((t) => ({ ...t, on }));
    } catch {
      setTorch((t) => ({ ...t, supported: false }));
    }
  };

  return (
    <div className="relative mb-4 overflow-hidden rounded-3xl bg-black">
      <video ref={videoRef} playsInline muted autoPlay className="aspect-[4/5] w-full object-cover" />
      {status === 'running' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className={cx(
              'aspect-square w-3/5 rounded-3xl border-4 transition-colors',
              paused ? 'border-[rgba(255,255,255,0.25)]' : 'border-white',
            )}
          />
        </div>
      )}
      {status === 'starting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white">
          <Spinner className="size-8" />
          <p className="text-sm">Включаем камеру…</p>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-white">
          <p className="text-[15px] leading-snug">{error}</p>
          <Button variant="secondary" onClick={() => setRestart((n) => n + 1)}>
            Попробовать снова
          </Button>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 p-3">
        <span className="rounded-full bg-[rgba(0,0,0,0.55)] px-3 py-1 text-[13px] font-medium text-white">
          {paused ? 'Пауза' : 'Наведите камеру на QR-код'}
        </span>
        <div className="flex gap-2">
          {torch.supported && (
            <button
              type="button"
              onClick={() => void toggleTorch()}
              className="flex size-10 items-center justify-center rounded-full bg-[rgba(0,0,0,0.55)] text-white"
              aria-label="Фонарик"
            >
              {torch.on ? <IconBulbFilled size={20} className="text-[#ffd43b]" /> : <IconBulb size={20} />}
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="flex size-10 items-center justify-center rounded-full bg-[rgba(0,0,0,0.55)] text-lg text-white"
              aria-label="Выключить камеру"
            >
              <IconX size={20} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
