import { useEffect, useRef } from 'react';

/**
 * 3D starfield: ~240 stars flying toward the viewer, with a motion-trail effect
 * (a semi-transparent black fill each frame). Pure canvas, fixed full-screen.
 */
export function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    const resize = () => {
      w = canvas.width = Math.floor(canvas.clientWidth * dpr);
      h = canvas.height = Math.floor(canvas.clientHeight * dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    const stars = Array.from({ length: 240 }, () => ({
      x: Math.random() * 2 - 1,
      y: Math.random() * 2 - 1,
      z: Math.random(),
    }));

    let raf = 0;
    const tick = () => {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const scale = Math.min(w, h) * 0.6;
      for (const s of stars) {
        s.z -= 0.006;
        if (s.z <= 0.02) {
          s.x = Math.random() * 2 - 1;
          s.y = Math.random() * 2 - 1;
          s.z = 1;
        }
        const sx = cx + (s.x / s.z) * scale;
        const sy = cy + (s.y / s.z) * scale;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        const size = Math.max(1, (1 - s.z) * 3 * dpr);
        ctx.fillStyle = `rgba(220, 230, 255, ${Math.min(1, (1 - s.z) * 1.2)})`;
        ctx.fillRect(sx, sy, size, size);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={ref} className="starfield" aria-hidden />;
}
