import { createElement, useEffect, useRef, useState } from 'react';
import { IconCube3dSphere, IconRotate2 } from '@tabler/icons-react';
import { haptic } from '../lib/feedback.ts';
import { setVerticalSwipes } from '../telegram/sdk.ts';
import { loadModelViewer } from './model-viewer-loader.ts';
import { cx, Spinner } from './kit.tsx';


/** Насколько можно приблизить и отдалить - от вида при открытии. */
const ZOOM_IN = 0.7;
const ZOOM_OUT = 1.12;
/** С какого приближения показывать «Вернуть». */
const AWAY_ZOOM = 1.3;

interface Vec {
  x: number;
  y: number;
  z: number;
}
/** То, что нужно от <model-viewer> (его типы тянут за собой three.js). */
interface Viewer extends HTMLElement {
  getCameraOrbit(): { theta: number; phi: number; radius: number };
  getCameraTarget(): Vec;
  getFieldOfView(): number;
  cameraOrbit: string;
  cameraTarget: string;
  fieldOfView: string;
  minCameraOrbit: string;
  maxCameraOrbit: string;
  minFieldOfView: string;
  maxFieldOfView: string;
}
interface Home {
  radius: number;
  fov: number;
  phi: number;
  target: Vec;
}

const tanHalf = (deg: number) => Math.tan((deg * Math.PI) / 360);

/**
 * 3D-модель вещи (.glb): крутится сама, вращается пальцем на 360°, щипком - приблизить (в меру).
 * Приблизили или сдвинули сильно - появляется «Вернуть». Пока модель на экране, вертикальный свайп
 * Telegram выключен - иначе вращение сворачивало бы приложение.
 */
export function ModelViewer({ src, poster, alt, className }: { src: string; poster?: string | null; alt: string; className?: string }) {
  const [engine, setEngine] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const [away, setAway] = useState(false);
  const ref = useRef<Viewer | null>(null);
  const home = useRef<Home | null>(null);
  const resets = useRef(0);

  useEffect(() => {
    let alive = true;
    loadModelViewer().then(
      () => alive && setEngine('ready'),
      () => alive && setEngine('failed'),
    );
    setVerticalSwipes(false);
    return () => {
      alive = false;
      setVerticalSwipes(true);
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setProgress(0);
    setFailed(false);
    setAway(false);
    home.current = null;
    const onProgress = (e: Event) => setProgress((e as CustomEvent<{ totalProgress: number }>).detail.totalProgress);
    const onError = () => setFailed(true);
    // Вид при открытии - «домашний»: от него считаем пределы зума и когда звать «Вернуть».
    const onLoad = () => {
      const { radius, phi } = el.getCameraOrbit();
      const fov = el.getFieldOfView();
      home.current = { radius, fov, phi, target: el.getCameraTarget() };
      el.minCameraOrbit = `auto auto ${radius * ZOOM_IN}m`;
      el.maxCameraOrbit = `auto auto ${radius * ZOOM_OUT}m`;
      el.minFieldOfView = `${fov * ZOOM_IN}deg`;
      el.maxFieldOfView = `${fov * ZOOM_OUT}deg`;
    };
    const onCamera = () => {
      const h = home.current;
      if (!h) return;
      const zoom = (h.radius * tanHalf(h.fov)) / (el.getCameraOrbit().radius * tanHalf(el.getFieldOfView()));
      const t = el.getCameraTarget();
      const shift = Math.hypot(t.x - h.target.x, t.y - h.target.y, t.z - h.target.z);
      setAway(zoom > AWAY_ZOOM || shift > h.radius * 0.12);
    };
    el.addEventListener('progress', onProgress);
    el.addEventListener('error', onError);
    el.addEventListener('load', onLoad);
    el.addEventListener('camera-change', onCamera);
    return () => {
      el.removeEventListener('progress', onProgress);
      el.removeEventListener('error', onError);
      el.removeEventListener('load', onLoad);
      el.removeEventListener('camera-change', onCamera);
    };
  }, [engine, src]);

  /** Плавно назад к виду при открытии; поворот вокруг оставляем, чтобы модель не крутанулась. */
  const reset = () => {
    const el = ref.current;
    const h = home.current;
    if (!el || !h) return;
    haptic('selection');
    // Камеру двигает только новое значение свойства - то же самое <model-viewer> пропустит,
    // поэтому к повторному сбросу добавляем неразличимую на глаз добавку.
    const e = (resets.current++ % 2) * 1e-4;
    el.cameraTarget = `${h.target.x + e}m ${h.target.y}m ${h.target.z}m`;
    el.cameraOrbit = `${el.getCameraOrbit().theta}rad ${h.phi}rad ${h.radius + e}m`;
    el.fieldOfView = `${h.fov + e}deg`;
  };

  if (engine === 'failed' || failed) {
    return (
      <div className={cx('flex flex-col items-center justify-center gap-2 bg-fill text-center text-[14px] text-subtle', className)}>
        <IconCube3dSphere size={32} stroke={1.5} />
        Не получилось открыть 3D-модель
      </div>
    );
  }
  return (
    <div className={cx('relative bg-fill', className)}>
      {engine === 'ready' &&
        createElement('model-viewer' as 'div', {
          ref,
          src,
          poster: poster ?? undefined,
          alt,
          'camera-controls': true,
          'auto-rotate': true,
          'auto-rotate-delay': 0,
          'rotation-per-second': '24deg',
          'interaction-prompt': 'none',
          'touch-action': 'pan-y',
          'shadow-intensity': '1',
          'environment-image': 'neutral',
          exposure: '1.05',
          style: { width: '100%', height: '100%', background: 'transparent', '--poster-color': 'transparent' },
        } as never)}
      <button
        type="button"
        onClick={reset}
        tabIndex={away ? 0 : -1}
        aria-hidden={!away}
        className={cx(
          'absolute bottom-4 right-3 flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-[13px] font-semibold text-white backdrop-blur transition duration-300',
          away ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
        )}
      >
        <IconRotate2 size={15} />
        Вернуть
      </button>
      {(engine === 'loading' || progress < 1) && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <span className="flex items-center gap-2 rounded-full bg-black/55 px-3 py-1 text-[13px] font-semibold text-white">
            <Spinner className="size-4" />
            {engine === 'loading' ? '3D' : `${Math.round(progress * 100)}%`}
          </span>
        </div>
      )}
    </div>
  );
}
