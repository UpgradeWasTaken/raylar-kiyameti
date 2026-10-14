import type { Map as MLMap } from 'maplibre-gl';
import { store } from '../game/store';
import { trainStates, type TrainState } from '../game/trains';

/** Draws every running train on a canvas above the map, positioned from the shared timetable. */
export class TrainOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private drawn: { x: number; y: number; line: number }[] = [];
  private buf: TrainState[] = [];
  highlightLine: number | null = null;

  constructor(private map: MLMap) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'train-overlay';
    map.getCanvasContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    const resize = () => {
      const c = map.getCanvas();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = c.clientWidth * dpr;
      this.canvas.height = c.clientHeight * dpr;
      this.canvas.style.width = `${c.clientWidth}px`;
      this.canvas.style.height = `${c.clientHeight}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    map.on('resize', resize);
    resize();
  }

  draw() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const zoom = this.map.getZoom();
    const b = this.map.getBounds();
    const pad = 0.2;
    const west = b.getWest() - pad, east = b.getEast() + pad, south = b.getSouth() - pad, north = b.getNorth() + pad;
    const now = store.now();
    this.drawn.length = 0;
    const len = Math.max(8, Math.min(26, (zoom - 3) * 2.6));
    const wid = Math.max(4, Math.min(9, (zoom - 3) * 1.0));
    for (const line of store.lines.values()) {
      if (line.status !== 'active') continue;
      this.buf.length = 0;
      trainStates(line, now, this.buf);
      const model = store.trainModels.get(line.model);
      const cargo = model?.service === 'cargo';
      const hl = this.highlightLine === line.id;
      for (const t of this.buf) {
        const [lon, lat] = t.p;
        if (lon < west || lon > east || lat < south || lat > north) continue;
        const pt = this.map.project(t.p as [number, number]);
        this.drawn.push({ x: pt.x, y: pt.y, line: line.id });
        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.rotate(-t.bearing);
        const L = hl ? len * 1.3 : len, W = hl ? wid * 1.3 : wid;
        ctx.fillStyle = line.color;
        ctx.strokeStyle = hl ? '#111827' : '#ffffff';
        ctx.lineWidth = hl ? 2.5 : 1.5;
        ctx.beginPath();
        if (cargo) ctx.rect(-L / 2, -W / 2, L, W);
        else roundRect(ctx, -L / 2, -W / 2, L, W, W / 2);
        ctx.fill();
        ctx.stroke();
        // nose
        ctx.fillStyle = '#ffffffcc';
        ctx.fillRect(L / 2 - Math.min(3, L / 4), -W / 2 + 1, Math.min(2, L / 6), W - 2);
        ctx.restore();
      }
    }
  }

  /** Line id of the train under a screen point, if any. */
  hit(x: number, y: number): number | null {
    let best: number | null = null, bd = 10;
    for (const d of this.drawn) {
      const dist = Math.hypot(d.x - x, d.y - y);
      if (dist < bd) { bd = dist; best = d.line; }
    }
    return best;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + r, r, Math.PI / 2, (3 * Math.PI) / 2);
  ctx.closePath();
}
