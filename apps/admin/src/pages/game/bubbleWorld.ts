/**
 * Физика пузырей большого экрана. Пузыри мягко тянутся к центру - эллипсом под форму экрана, чтобы заполнить
 * и широкий телевизор, и проектор 4:3; расталкивают друг друга без наложений; размер меняется пружиной
 * («буньк», когда за команду голосуют). Для пьедестала - якоря: пузырь плавно уезжает на своё место.
 * Шаг фиксированный (1/120 с) - одинаково на 60 и 144 Гц и на слабом компьютере у телевизора.
 */

export interface BubbleTarget {
  id: number;
  /** Целевой радиус, px. */
  R: number;
  /** Точка, к которой пузырь притягивается пружиной (пьедестал). */
  anchor?: { x: number; y: number } | null;
  /** Сейчас голосуем за эту команду - пузырь выезжает к центру. */
  focus?: boolean;
  /** Запас вокруг пузыря (×радиус) для соседей: корона, плашка «голосуем», пульсирующее кольцо. */
  halo?: number;
}

export interface Body {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Текущий радиус и его скорость (пружина к R). */
  r: number;
  vr: number;
  R: number;
  anchor: { x: number; y: number } | null;
  focus: boolean;
  halo: number;
  /** Фаза покачивания: у каждого своя, чтобы пузыри «дышали» вразнобой. */
  phase: number;
  /** Когда начинает расти (при первом показе пузыри появляются по очереди). */
  appearAt: number;
}

const STEP = 1 / 120;

export class BubbleWorld {
  w = 0;
  h = 0;
  time = 0;
  readonly bodies = new Map<number, Body>();
  private acc = 0;

  /** Размер сцены поменялся (окно, полоса голосования) - сохраняем расположение пропорционально. */
  resize(w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    if (this.w > 0 && this.h > 0) {
      const sx = w / this.w;
      const sy = h / this.h;
      for (const b of this.bodies.values()) {
        b.x *= sx;
        b.y *= sy;
      }
    }
    this.w = w;
    this.h = h;
  }

  sync(targets: BubbleTarget[]): void {
    const ids = new Set<number>();
    let fresh = 0;
    for (const t of targets) {
      ids.add(t.id);
      let b = this.bodies.get(t.id);
      if (!b) {
        // Новые появляются по кругу вокруг центра и по очереди - «пуф, пуф, пуф».
        const a = Math.random() * Math.PI * 2;
        const d = 0.18 + Math.random() * 0.22;
        b = {
          id: t.id,
          x: this.w / 2 + Math.cos(a) * this.w * d,
          y: this.h / 2 + Math.sin(a) * this.h * d,
          vx: 0,
          vy: 0,
          r: 0,
          vr: 0,
          R: t.R,
          anchor: null,
          focus: false,
          halo: 1,
          phase: Math.random() * Math.PI * 2,
          appearAt: this.time + fresh * 0.07,
        };
        fresh += 1;
        this.bodies.set(t.id, b);
      }
      b.R = t.R;
      b.anchor = t.anchor ?? null;
      b.focus = !!t.focus;
      b.halo = t.halo ?? 1;
    }
    for (const id of [...this.bodies.keys()]) if (!ids.has(id)) this.bodies.delete(id);
  }

  /** Толчок размера: пузырь вздрагивает, когда в него «прилетают» люди. */
  kick(id: number, strength = 1): void {
    const b = this.bodies.get(id);
    if (b) b.vr += strength * Math.max(b.R, 24) * 1.6;
  }

  advance(dt: number): void {
    // Медленный кадр (слабый компьютер у телевизора) - догоняем время, а не показываем «замедленную съёмку».
    this.acc += Math.min(Math.max(dt, 0), 0.25);
    while (this.acc >= STEP) {
      this.step(STEP);
      this.acc -= STEP;
      this.time += STEP;
    }
  }

  private step(dt: number): void {
    const { w, h } = this;
    if (w <= 0 || h <= 0) return;
    const cx = w / 2;
    const cy = h / 2;
    const minDim = Math.min(w, h);
    const pad = minDim * 0.015;
    const gap = minDim * 0.016;
    const aspect = w / h;
    // Тяга к центру сильнее по короткой стороне - облако пузырей вытягивается под форму экрана.
    const gx = aspect >= 1 ? 1.4 : 1.4 * Math.min(1 / (aspect * aspect), 9);
    const gy = aspect >= 1 ? 1.4 * Math.min(aspect * aspect, 9) : 1.4;
    const list = [...this.bodies.values()];
    const focus = list.find((b) => b.focus && !b.anchor) ?? null;

    for (const b of list) {
      // Размер: пружина с небольшим перелётом - «буньк».
      if (this.time >= b.appearAt) {
        const ar = 120 * (b.R - b.r) - 12 * b.vr;
        b.vr += ar * dt;
        b.r = Math.max(0, b.r + b.vr * dt);
      }
      let ax: number;
      let ay: number;
      if (b.anchor) {
        ax = 26 * (b.anchor.x - b.x) - 8 * b.vx;
        ay = 26 * (b.anchor.y - b.y) - 8 * b.vy;
      } else {
        ax = -gx * (b.x - cx) - 2.4 * b.vx;
        ay = -gy * (b.y - cy) - 2.4 * b.vy;
        if (b.focus) {
          ax += -16 * (b.x - cx) - 2 * b.vx;
          ay += -16 * (b.y - cy) - 2 * b.vy;
        } else if (focus && focus.r > 0) {
          // Остальные заранее расступаются перед тем, за кого голосуют, - ему есть куда выехать в центр.
          const dx = b.x - focus.x;
          const dy = b.y - focus.y;
          const d = Math.hypot(dx, dy) || 1;
          const reach = (focus.r * focus.halo + b.r) * 1.3 + gap * 2;
          if (d < reach) {
            ax += (12 * (reach - d) * dx) / d;
            ay += (12 * (reach - d) * dy) / d;
          }
        }
      }
      // Мягкие стенки: пузырь не телепортируется, когда сцена сжимается (появилась полоса голосования).
      const r = b.r * b.halo;
      if (b.x - r < pad) ax += 90 * (pad - (b.x - r));
      else if (b.x + r > w - pad) ax -= 90 * (b.x + r - (w - pad));
      if (b.y - r < pad) ay += 90 * (pad - (b.y - r));
      else if (b.y + r > h - pad) ay -= 90 * (b.y + r - (h - pad));
      b.vx += ax * dt;
      b.vy += ay * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }

    // Столкновения: раздвигаем по линии центров; маленький уступает большому, якорный почти не сдвигается.
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < list.length; i++) {
        const a = list[i]!;
        if (a.r <= 0) continue;
        for (let j = i + 1; j < list.length; j++) {
          const c = list[j]!;
          if (c.r <= 0) continue;
          let dx = c.x - a.x;
          let dy = c.y - a.y;
          const minD = a.r * a.halo + c.r * c.halo + gap;
          const d2 = dx * dx + dy * dy;
          if (d2 >= minD * minD) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-3) {
            dx = Math.cos(a.phase + j);
            dy = Math.sin(a.phase + j);
            d = 1;
          }
          const nx = dx / d;
          const ny = dy / d;
          const overlap = minD - d;
          let wa = (c.r * c.r) / (a.r * a.r + c.r * c.r);
          let wc = 1 - wa;
          // Якорный и «тот, за кого голосуем» почти не сдвигаются - остальные расступаются.
          if ((a.anchor && !c.anchor) || (a.focus && !c.focus)) [wa, wc] = [0.15, 0.85];
          else if ((c.anchor && !a.anchor) || (c.focus && !a.focus)) [wa, wc] = [0.85, 0.15];
          a.x -= nx * overlap * wa * 0.55;
          a.y -= ny * overlap * wa * 0.55;
          c.x += nx * overlap * wc * 0.55;
          c.y += ny * overlap * wc * 0.55;
          // Гасим сближение: без этого пузыри дрожат, упираясь друг в друга.
          const rv = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
          if (rv < 0) {
            a.vx += nx * rv * wa;
            a.vy += ny * rv * wa;
            c.vx -= nx * rv * wc;
            c.vy -= ny * rv * wc;
          }
        }
      }
    }

    // Последняя страховка: целиком в сцене.
    for (const b of list) {
      const r = b.r * b.halo;
      if (r * 2 < w) b.x = Math.min(Math.max(b.x, r), w - r);
      if (r * 2 < h) b.y = Math.min(Math.max(b.y, r), h - r);
    }
  }
}

/**
 * Радиусы пузырей: площадь - от отправленных людей, у команд без голосов - небольшой «пол»,
 * чтобы их было видно и подписи читались. Вся «сцена» заполнена примерно наполовину - с воздухом между пузырями.
 */
export function bubbleRadii(points: number[], w: number, h: number): number[] {
  const n = points.length;
  if (n === 0 || w <= 0 || h <= 0) return [];
  const minDim = Math.min(w, h);
  const fill = n === 1 ? 0.2 : n <= 3 ? 0.34 : n <= 8 ? 0.42 : 0.46;
  const area = fill * w * h;
  const maxP = Math.max(0, ...points);
  const base = Math.max(1, maxP * 0.18);
  const weights = points.map((p) => Math.max(0, p) + base);
  const rMax = (n <= 2 ? 0.42 : 0.45) * minDim;
  const rMin = Math.min(0.1 * minDim, Math.sqrt(area / (Math.PI * n)) * 0.92);
  const r = new Array<number>(n).fill(0);
  const fixed = new Array<boolean>(n).fill(false);
  // «Наливаем воду»: кто упёрся в потолок или пол - фиксируем, остальным делим оставшуюся площадь.
  for (let iter = 0; iter < 12; iter++) {
    let budget = area;
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) budget -= Math.PI * r[i]! * r[i]!;
      else wsum += weights[i]!;
    }
    budget = Math.max(budget, 0);
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      const v = wsum > 0 ? Math.sqrt((budget * weights[i]!) / (Math.PI * wsum)) : rMin;
      if (v > rMax) {
        r[i] = rMax;
        fixed[i] = true;
        changed = true;
      } else if (v < rMin) {
        r[i] = rMin;
        fixed[i] = true;
        changed = true;
      } else r[i] = v;
    }
    if (!changed) break;
  }
  return r;
}
