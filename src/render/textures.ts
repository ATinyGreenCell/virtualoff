import * as THREE from 'three';

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

export function canvasTexture(w: number, h: number, draw: Draw, repeat = false): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const css = (hex: number, alpha = 1) => {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
};

export const cssColor = css;

/** Multiply a hex color's channels by k (clamped). */
export function shade(hex: number, k: number) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/** Deterministic PRNG so procedural textures look the same every load. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map<string, THREE.Texture>();
function memo(key: string, make: () => THREE.Texture) {
  let t = cache.get(key);
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

/** Soft radial glow, white — tint via material color. */
export const glowTexture = () =>
  memo('glow', () =>
    canvasTexture(64, 64, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.28)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }),
  );

/** Four-point star flare for muzzle flashes and impacts. */
export const flareTexture = () =>
  memo('flare', () =>
    canvasTexture(128, 128, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.2, 'rgba(255,255,255,0.6)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (const rot of [0, Math.PI / 2]) {
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate(rot);
        const lg = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
        lg.addColorStop(0, 'rgba(255,255,255,0)');
        lg.addColorStop(0.5, 'rgba(255,255,255,0.9)');
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = lg;
        ctx.fillRect(-w / 2, -3, w, 6);
        ctx.restore();
      }
    }),
  );

export const blobShadowTexture = () =>
  memo('blob', () =>
    canvasTexture(64, 64, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(0,0,0,0.62)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.42)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }),
  );

/** Vertical gradient strip (white->transparent), used for energy barriers and beams. */
export const fadeTexture = () =>
  memo('fade', () =>
    canvasTexture(4, 128, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, h, 0, 0);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.15, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }),
  );

export interface FloorStyle {
  a: number;
  b: number;
  line: number;
  seed: number;
}

/** 2x2 floor panels with seams, bevels, bolts and grime — repeated across the arena. */
export function floorTexture(s: FloorStyle) {
  return canvasTexture(
    512,
    512,
    (ctx, w) => {
      const rnd = mulberry32(s.seed);
      const P = w / 2;
      for (let py = 0; py < 2; py++) {
        for (let px = 0; px < 2; px++) {
          const base = (px + py) % 2 === 0 ? s.a : s.b;
          const x0 = px * P;
          const y0 = py * P;
          ctx.fillStyle = css(base);
          ctx.fillRect(x0, y0, P, P);
          // grime / speckle
          for (let i = 0; i < 260; i++) {
            const k = 0.9 + rnd() * 0.16;
            ctx.fillStyle = css(shade(base, k), 0.35);
            const sz = 2 + rnd() * 10;
            ctx.fillRect(x0 + rnd() * P, y0 + rnd() * P, sz, sz * (0.3 + rnd()));
          }
          // sub-panel seams
          ctx.fillStyle = css(shade(base, 0.86));
          ctx.fillRect(x0 + P / 2 - 1, y0 + 10, 2, P - 20);
          ctx.fillRect(x0 + 10, y0 + P / 2 - 1, P - 20, 2);
          // bevel
          ctx.fillStyle = css(shade(base, 1.12));
          ctx.fillRect(x0 + 6, y0 + 6, P - 12, 3);
          ctx.fillRect(x0 + 6, y0 + 6, 3, P - 12);
          ctx.fillStyle = css(shade(base, 0.78));
          ctx.fillRect(x0 + 6, y0 + P - 9, P - 12, 3);
          ctx.fillRect(x0 + P - 9, y0 + 6, 3, P - 12);
          // bolts
          ctx.fillStyle = css(shade(base, 0.62));
          for (const [bx, by] of [
            [16, 16],
            [P - 22, 16],
            [16, P - 22],
            [P - 22, P - 22],
          ]) {
            ctx.fillRect(x0 + bx, y0 + by, 6, 6);
          }
          // occasional hatch or vent
          if (rnd() < 0.5) {
            ctx.fillStyle = css(shade(base, 0.8));
            const vx = x0 + 30 + rnd() * (P - 110);
            const vy = y0 + 30 + rnd() * (P - 80);
            for (let i = 0; i < 6; i++) ctx.fillRect(vx, vy + i * 7, 60, 3);
          }
        }
      }
      // seams between panels (drawn last so they're crisp)
      ctx.fillStyle = css(s.line);
      for (let i = 0; i <= 2; i++) {
        const p = Math.min(w - 3, Math.max(0, i * P - 3));
        ctx.fillRect(p, 0, 6, w);
        ctx.fillRect(0, p, w, 6);
      }
    },
    true,
  );
}

/** Grayscale panelling for blocks/buildings, tinted by material color. */
export const blockTexture = () =>
  memo('block', () =>
    canvasTexture(
      256,
      256,
      (ctx, w, h) => {
        const rnd = mulberry32(77);
        ctx.fillStyle = '#e6e6e6';
        ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 120; i++) {
          const g = 200 + Math.floor(rnd() * 55);
          ctx.fillStyle = `rgba(${g},${g},${g},0.5)`;
          ctx.fillRect(rnd() * w, rnd() * h, 4 + rnd() * 20, 2 + rnd() * 6);
        }
        ctx.fillStyle = '#9a9a9a';
        for (let i = 0; i <= 4; i++) {
          ctx.fillRect(0, i * 64 - 1, w, 3);
        }
        ctx.fillRect(0, 0, 3, h);
        ctx.fillRect(128, 0, 3, h);
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 4; i++) ctx.fillRect(0, i * 64 + 2, w, 2);
        // a few windows / vents
        ctx.fillStyle = '#7c7c7c';
        for (let i = 0; i < 6; i++) {
          const x = 12 + Math.floor(rnd() * 8) * 30;
          const y = 14 + Math.floor(rnd() * 4) * 64;
          ctx.fillRect(x, y, 18, 10);
        }
      },
      true,
    ),
  );

export function hazardTexture(a: number, b: number) {
  return memo(`hazard-${a}-${b}`, () =>
    canvasTexture(
      128,
      32,
      (ctx, w, h) => {
        ctx.fillStyle = css(a);
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = css(b);
        for (let x = -h; x < w + h; x += 32) {
          ctx.beginPath();
          ctx.moveTo(x, h);
          ctx.lineTo(x + 16, h);
          ctx.lineTo(x + 16 + h, 0);
          ctx.lineTo(x + h, 0);
          ctx.closePath();
          ctx.fill();
        }
      },
      true,
    ),
  );
}

export interface SkyStyle {
  top: number;
  mid: number;
  horizon: number;
  below: number;
  clouds: number;
  cloudAlpha: number;
  sun: number;
  sunU: number;
  sunV: number;
  sunSize: number;
  stars: boolean;
  seed: number;
}

/** Equirectangular painted sky — u wraps around the horizon, v=0.5 is the horizon line. */
export function skyTexture(s: SkyStyle) {
  return canvasTexture(1024, 512, (ctx, w, h) => {
    const rnd = mulberry32(s.seed);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, css(s.top));
    g.addColorStop(0.32, css(s.mid));
    g.addColorStop(0.495, css(s.horizon));
    g.addColorStop(0.505, css(s.below));
    g.addColorStop(1, css(s.below));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (s.stars) {
      for (let i = 0; i < 260; i++) {
        const y = rnd() * h * 0.36;
        ctx.fillStyle = `rgba(255,255,255,${0.25 + rnd() * 0.6 * (1 - y / (h * 0.36))})`;
        const sz = rnd() < 0.1 ? 2 : 1;
        ctx.fillRect(rnd() * w, y, sz, sz);
      }
    }
    // sun glow
    const sx = s.sunU * w;
    const sy = s.sunV * h;
    for (const off of [-w, 0, w]) {
      const sg = ctx.createRadialGradient(sx + off, sy, 0, sx + off, sy, s.sunSize * 6);
      sg.addColorStop(0, css(s.sun, 0.9));
      sg.addColorStop(0.15, css(s.sun, 0.45));
      sg.addColorStop(1, css(s.sun, 0));
      ctx.fillStyle = sg;
      ctx.fillRect(sx + off - s.sunSize * 6, sy - s.sunSize * 6, s.sunSize * 12, s.sunSize * 12);
      ctx.fillStyle = css(s.sun);
      ctx.beginPath();
      ctx.arc(sx + off, sy, s.sunSize, 0, Math.PI * 2);
      ctx.fill();
    }
    // streaky cloud banks near the horizon
    for (let i = 0; i < 70; i++) {
      const cx = rnd() * w;
      const cy = h * (0.3 + rnd() * 0.17);
      const rw = 40 + rnd() * 160;
      const rh = 4 + rnd() * 12;
      for (const off of [-w, 0, w]) {
        const cg = ctx.createRadialGradient(cx + off, cy, 0, cx + off, cy, rw);
        const a = s.cloudAlpha * (0.4 + rnd() * 0.6);
        cg.addColorStop(0, css(s.clouds, a));
        cg.addColorStop(1, css(s.clouds, 0));
        ctx.fillStyle = cg;
        ctx.save();
        ctx.translate(cx + off, cy);
        ctx.scale(1, rh / rw);
        ctx.translate(-(cx + off), -cy);
        ctx.fillRect(cx + off - rw, cy - rw, rw * 2, rw * 2);
        ctx.restore();
      }
    }
  });
}

/** Big painted floor lettering. */
export function textTexture(text: string, color: number, font: string, w = 1024, h = 256) {
  return canvasTexture(w, h, (ctx) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = css(color);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 6);
  });
}
