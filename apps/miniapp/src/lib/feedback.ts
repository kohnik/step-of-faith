/**
 * Обратная связь: вибрация (Telegram HapticFeedback или navigator.vibrate) и короткий звук (WebAudio).
 * На входе шумно и все смотрят на экран - цвет + вибрация + звук дублируют друг друга.
 */
import { hapticFeedback } from '@tma.js/sdk-react';
import { isTelegram } from '../telegram/sdk.ts';

export type Signal = 'success' | 'warning' | 'error';

export function haptic(kind: Signal | 'light' | 'selection'): void {
  if (isTelegram()) {
    try {
      if (kind === 'light') hapticFeedback.impactOccurred.ifAvailable('light');
      else if (kind === 'selection') hapticFeedback.selectionChanged.ifAvailable();
      else hapticFeedback.notificationOccurred.ifAvailable(kind);
      return;
    } catch {
      /* ниже - вибрация браузера */
    }
  }
  const pattern: number | number[] =
    kind === 'success' ? 40 : kind === 'warning' ? [60, 60, 60] : kind === 'error' ? [140, 70, 140] : 12;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* ignore */
  }
}

type AudioCtor = typeof AudioContext;
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (!ctx) {
    const Ctor: AudioCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
  return ctx;
}

/** iOS разрешает звук только после жеста пользователя - вызываем на первом нажатии «Сканировать». */
export function unlockAudio(): void {
  const c = audio();
  if (!c) return;
  try {
    const buffer = c.createBuffer(1, 1, 22050);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    src.start(0);
  } catch {
    /* ignore */
  }
}

export function beep(kind: Signal): void {
  const c = audio();
  if (!c) return;
  const tones: [freq: number, delay: number, duration: number][] =
    kind === 'success'
      ? [
          [880, 0, 0.09],
          [1320, 0.09, 0.12],
        ]
      : kind === 'warning'
        ? [
            [560, 0, 0.12],
            [560, 0.2, 0.12],
          ]
        : [[196, 0, 0.42]];
  try {
    for (const [freq, delay, duration] of tones) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = kind === 'error' ? 'square' : 'sine';
      osc.frequency.value = freq;
      const t0 = c.currentTime + delay;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(kind === 'error' ? 0.18 : 0.3, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.03);
    }
  } catch {
    /* ignore */
  }
}

export function signal(kind: Signal, withSound = true): void {
  haptic(kind);
  if (withSound) beep(kind);
}
