/**
 * Top-down 2D design view: pan/zoom canvas with heat layers, terrain
 * backdrop, corner numbers, sectors, start/finish and station inspection.
 */

import type { AppState, HeatLayer } from "./state";
import type { Track, TrackSample } from "../core/types";
import type { TerrainGrid } from "../core/terrain";

export class View2D {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tooltip: HTMLDivElement;
  private camX = 0;
  private camY = 0;
  private scale = 0.2; // px per meter
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private fittedFor: Track | null = null;
  private terrainCanvas: HTMLCanvasElement | null = null;
  private terrainFor: TerrainGrid | null = null;
  /** Set by the app when overlays change; forces a refit on next render. */
  needsFit = true;
  onStationHover: ((s: number | null) => void) | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.inset = "0";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.tooltip = document.createElement("div");
    this.tooltip.className = "station-tip";
    this.tooltip.style.display = "none";
    container.appendChild(this.tooltip);
    this.attachEvents(container);
  }

  resize(): void {
    const parent = this.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      this.needsFit = this.needsFit; // keep camera; fit only on new track
    }
  }

  private attachEvents(container: HTMLElement): void {
    this.canvas.addEventListener("mousedown", (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener("mouseup", () => (this.dragging = false));
    window.addEventListener("mousemove", (e) => {
      if (this.dragging) {
        const dpr = window.devicePixelRatio || 1;
        this.camX += (e.clientX - this.lastX) * dpr;
        this.camY += (e.clientY - this.lastY) * dpr;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
    });
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const mx = (e.clientX - rect.left) * dpr;
        const my = (e.clientY - rect.top) * dpr;
        const zoom = Math.exp(-e.deltaY * 0.0012);
        this.scale = Math.min(30, Math.max(0.01, this.scale * zoom));
        // zoom around cursor
        this.camX = mx - (mx - this.camX) * zoom;
        this.camY = my - (my - this.camY) * zoom;
      },
      { passive: false },
    );
    this.canvas.addEventListener("mousemove", (e) => {
      const state = this.lastState;
      if (!state?.track || this.dragging) return;
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const wx = ((e.clientX - rect.left) * dpr - this.camX) / this.scale;
      const wy = (this.camY - (e.clientY - rect.top) * dpr) / this.scale;
      const s = this.nearestStation(state.track, wx, wy);
      if (s !== null) {
        this.hoverS = s;
        this.onStationHover?.(s);
        this.showTooltip(state, s, e.clientX - rect.left, e.clientY - rect.top);
      } else {
        this.hoverS = null;
        this.onStationHover?.(null);
        this.tooltip.style.display = "none";
      }
    });
    this.canvas.addEventListener("mouseleave", () => {
      this.tooltip.style.display = "none";
      this.hoverS = null;
    });
    void container;
  }

  private lastState: AppState | null = null;
  private hoverS: number | null = null;

  private nearestStation(track: Track, wx: number, wy: number): number | null {
    let best = Infinity;
    let bestS: number | null = null;
    const samples = track.samples;
    const step = Math.max(1, Math.floor(samples.length / 1500));
    for (let i = 0; i < samples.length; i += step) {
      const dx = samples[i].x - wx;
      const dy = samples[i].y - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        bestS = samples[i].s;
      }
    }
    const maxDist = 60 / this.scale + 30; // generous grab radius
    return best < maxDist * maxDist ? bestS : null;
  }

  private fitW = 0;
  private fitH = 0;

  private canvasSizeChanged(): boolean {
    return Math.abs(this.canvas.width - this.fitW) > 60 || Math.abs(this.canvas.height - this.fitH) > 60;
  }

  fitToTrack(track: Track): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of track.samples) {
      if (s.x < minX) minX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.x > maxX) maxX = s.x;
      if (s.y > maxY) maxY = s.y;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width;
    let h = this.canvas.height;
    // keep the circuit clear of the candidate strip overlay
    const strip = this.canvas.parentElement?.querySelector(".candidate-strip");
    if (strip) h -= (strip as HTMLElement).clientHeight * dpr * 0.9;
    const spanX = Math.max(100, maxX - minX);
    const spanY = Math.max(100, maxY - minY);
    this.scale = Math.min(w / (spanX * 1.16), h / (spanY * 1.16));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.camX = w / 2 - cx * this.scale;
    // north-up: wy(y) = camY - y*scale, so center maps to h/2 with +
    this.camY = h / 2 + cy * this.scale;
    this.needsFit = false;
    void dpr;
  }

  private wx(x: number): number {
    return x * this.scale + this.camX;
  }
  private wy(y: number): number {
    // world y is north-up; canvas y is down
    return this.camY - y * this.scale;
  }

  render(state: AppState): void {
    this.lastState = state;
    this.resize();
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0c0e11";
    ctx.fillRect(0, 0, W, H);

    const track = state.track;
    if (!track) {
      ctx.fillStyle = "#3a4048";
      ctx.font = `${13 * dpr}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.fillText("press GENERATE to synthesize a circuit", W / 2, H / 2);
      return;
    }
    if (this.fittedFor !== track || this.needsFit || this.canvasSizeChanged()) {
      this.fitToTrack(track);
      this.fittedFor = track;
      this.fitW = this.canvas.width;
      this.fitH = this.canvas.height;
    }

    // terrain backdrop (world y-up vs canvas y-down: place image by its
    // top-left corner at world (originX, originY + height*res))
    if (state.terrain && state.showTerrainHeat) {
      this.renderTerrain(state.terrain);
      const tc = this.terrainCanvas!;
      ctx.imageSmoothingEnabled = true;
      const g = state.terrain;
      const x0 = this.wx(g.originX);
      const y0 = this.wy(g.originY + g.height * g.resolution);
      const wpx = g.width * g.resolution * this.scale;
      const hpx = g.height * g.resolution * this.scale;
      ctx.drawImage(tc, x0, y0, wpx, hpx);
    }

    this.drawTrack(state, track);
    if (state.lockRange) this.drawLockRange(track, state.lockRange);
    if (state.showCorners) this.drawCornerNumbers(track);
    this.drawStartFinish(track);
    if (state.showControlPoints) this.drawDebug(track);
    if (this.hoverS !== null) this.drawHoverMarker(track, this.hoverS, dpr);
  }

  private drawLockRange(track: Track, lock: { sStart: number; sEnd: number }): void {
    const ctx = this.ctx;
    const n = track.samples.length;
    const inRange = (s: number) => {
      if (lock.sStart <= lock.sEnd) return s >= lock.sStart && s <= lock.sEnd;
      return s >= lock.sStart || s <= lock.sEnd;
    };
    // highlight the locked arc with a wide underlay
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= n; i++) {
      const p = track.samples[i % n];
      if (inRange(p.s)) {
        if (!started) {
          ctx.moveTo(this.wx(p.x), this.wy(p.y));
          started = true;
        } else ctx.lineTo(this.wx(p.x), this.wy(p.y));
      }
    }
    ctx.strokeStyle = "rgba(255, 180, 84, 0.35)";
    ctx.lineWidth = Math.max(8, 14 * this.scale * 0.05 + 8);
    ctx.lineCap = "round";
    ctx.stroke();
    // boundary ticks
    for (const sBound of [lock.sStart, lock.sEnd]) {
      const idx = Math.round(sBound / track.ds) % n;
      const p = track.samples[idx];
      const nx = -Math.sin(p.heading);
      const ny = Math.cos(p.heading);
      const hw = p.width / 2 + 8;
      ctx.beginPath();
      ctx.moveTo(this.wx(p.x + nx * hw), this.wy(p.y + ny * hw));
      ctx.lineTo(this.wx(p.x - nx * hw), this.wy(p.y - ny * hw));
      ctx.strokeStyle = "#ffb454";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------ terrain
  private renderTerrain(grid: TerrainGrid): void {
    if (this.terrainFor === grid && this.terrainCanvas) return;
    this.terrainFor = grid;
    const w = grid.width;
    const h = grid.height;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    const range = Math.max(1, grid.maxElevation - grid.minElevation);
    for (let iy = 0; iy < h; iy++) {
      // canvas row 0 (top) = max world y, so flip rows
      const row = h - 1 - iy;
      for (let ix = 0; ix < w; ix++) {
        const z = grid.elevation[iy * w + ix];
        const t = (z - grid.minElevation) / range;
        const slope = grid.slopeAt(grid.originX + ix * grid.resolution, grid.originY + iy * grid.resolution);
        // hypsometric: deep green -> olive -> brown -> grey
        const r = 26 + t * 130;
        const g = 48 + t * 72;
        const b = 30 + t * 55;
        const shade = Math.max(0.35, 1 - slope * 1.1);
        const di = (row * w + ix) * 4;
        img.data[di] = r * shade;
        img.data[di + 1] = g * shade;
        img.data[di + 2] = b * shade;
        img.data[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.terrainCanvas = cv;
  }

  // -------------------------------------------------------------- track
  private drawTrack(state: AppState, track: Track): void {
    const ctx = this.ctx;
    const s = track.samples;
    const n = s.length;

    // asphalt band
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const p = s[i % n];
      const nx = -Math.sin(p.heading);
      const ny = Math.cos(p.heading);
      const x = this.wx(p.x + nx * (p.width / 2));
      const y = this.wy(p.y + ny * (p.width / 2));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = n; i >= 0; i--) {
      const p = s[i % n];
      const nx = -Math.sin(p.heading);
      const ny = Math.cos(p.heading);
      ctx.lineTo(this.wx(p.x - nx * (p.width / 2)), this.wy(p.y - ny * (p.width / 2)));
    }
    ctx.closePath();
    ctx.fillStyle = "#23262c";
    ctx.fill();
    ctx.strokeStyle = "#454b55";
    ctx.lineWidth = 1;
    ctx.stroke();

    // sector tint underlay
    if (state.showSectors && track.sectors.length === 3) {
      const colors = ["rgba(224,83,61,0.5)", "rgba(61,224,139,0.5)", "rgba(79,159,247,0.5)"];
      track.sectors.forEach((sec, si) => {
        ctx.beginPath();
        const i0 = Math.round(sec.sStart / track.ds);
        const i1 = Math.round(sec.sEnd / track.ds);
        for (let k = i0; ; k = (k + 1) % n) {
          const p = s[k];
          const x = this.wx(p.x);
          const y = this.wy(p.y);
          if (k === i0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          if (k === i1) break;
        }
        ctx.strokeStyle = colors[si];
        ctx.lineWidth = 5;
        ctx.stroke();
      });
    }

    // heat-colored centerline
    const layer: HeatLayer = state.heatLayer;
    if (layer !== "none") {
      const colorOf = this.heatColor(state, track, layer);
      ctx.lineWidth = 2.4;
      const step = Math.max(1, Math.round(1.5 / track.ds));
      for (let i = 0; i < n; i += step) {
        const a = s[i];
        const b = s[(i + step) % n];
        ctx.beginPath();
        ctx.moveTo(this.wx(a.x), this.wy(a.y));
        ctx.lineTo(this.wx(b.x), this.wy(b.y));
        ctx.strokeStyle = colorOf(a);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const p = s[i % n];
        if (i === 0) ctx.moveTo(this.wx(p.x), this.wy(p.y));
        else ctx.lineTo(this.wx(p.x), this.wy(p.y));
      }
      ctx.strokeStyle = "#e8e8e8";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // direction chevrons
    const every = Math.max(1, Math.round(250 / track.ds));
    ctx.fillStyle = "#9aa3ad";
    for (let i = 0; i < n; i += every) {
      const p = s[i];
      const x = this.wx(p.x);
      const y = this.wy(p.y);
      const h = p.heading;
      const sz = 4;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(h) * sz * 1.6, y - Math.sin(h) * sz * 1.6);
      ctx.lineTo(x + Math.cos(h + 2.5) * sz, y - Math.sin(h + 2.5) * sz);
      ctx.lineTo(x + Math.cos(h - 2.5) * sz, y - Math.sin(h - 2.5) * sz);
      ctx.closePath();
      ctx.fill();
    }
  }

  private heatColor(state: AppState, track: Track, layer: HeatLayer): (smp: TrackSample) => string {
    const vMinMax = (): [number, number] => {
      let mn = Infinity;
      let mx = -Infinity;
      for (const p of track.samples) {
        let v = 0;
        if (layer === "curvature") v = Math.abs(p.kappa);
        else if (layer === "speed") v = p.speed;
        else if (layer === "elevation") v = p.z;
        else if (layer === "banking") v = p.bank;
        else if (layer === "cutfill") v = p.z - p.groundZ;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      return [mn, mx];
    };
    if (layer === "curvature") {
      return (p) => {
        const t = Math.min(1, Math.abs(p.kappa) / 0.025);
        return `rgb(${Math.round(230 * t + 60)},${Math.round(215 * (1 - t) + 40)},${Math.round(90 * (1 - t) + 40)})`;
      };
    }
    if (layer === "cutfill") {
      // blue = cut, neutral = at grade, orange = fill
      return (p) => {
        const d = p.z - p.groundZ;
        const t = Math.max(-1, Math.min(1, d / 8));
        if (t < 0) return `rgb(${Math.round(230 * (1 + t))},${Math.round(230 * (1 + t))},${Math.round(230 + 25 * -t)})`;
        return `rgb(${Math.round(230 + 25 * t)},${Math.round(200 * (1 - t * 0.6))},${Math.round(120 * (1 - t))})`;
      };
    }
    if (layer === "grade") {
      return (p) => {
        const i = track.samples.indexOf(p);
        const a = track.samples[(i - 1 + track.samples.length) % track.samples.length];
        const b = track.samples[(i + 1) % track.samples.length];
        const g = (b.z - a.z) / (2 * track.ds);
        const t = Math.max(-1, Math.min(1, g / 0.12));
        return t > 0
          ? `rgb(${Math.round(120 + 135 * t)},${Math.round(90 * (1 - t) + 60)},80)`
          : `rgb(80,${Math.round(90 * (1 + t) + 60)},${Math.round(120 - 135 * t)})`;
      };
    }
    const [mn, mx] = vMinMax();
    const span = Math.max(1e-9, mx - mn);
    return (p) => {
      let v = 0;
      if (layer === "speed") v = p.speed;
      else if (layer === "elevation") v = p.z;
      else if (layer === "banking") v = p.bank;
      const t = (v - mn) / span;
      // blue -> cyan -> green -> yellow -> red
      const hue = (1 - t) * 240;
      return `hsl(${hue}, 85%, 55%)`;
    };
  }

  private drawCornerNumbers(track: Track): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.font = `${9.5 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const c of track.corners) {
      const idx = Math.round(c.sApex / track.ds) % track.samples.length;
      const p = track.samples[idx];
      const nx = -Math.sin(p.heading);
      const ny = Math.cos(p.heading);
      const side = c.direction === "L" ? -1 : 1;
      const off = p.width / 2 + 26 / this.scale * 0.4 + 12;
      const x = this.wx(p.x + nx * off * side);
      const y = this.wy(p.y + ny * off * side);
      const r = 8 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = "#101216";
      ctx.fill();
      ctx.strokeStyle = "#6a727e";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#d6d9de";
      ctx.fillText(String(c.id), x, y);
    }
  }

  private drawStartFinish(track: Track): void {
    const ctx = this.ctx;
    const p = track.samples[0];
    const nx = -Math.sin(p.heading);
    const ny = Math.cos(p.heading);
    const hw = p.width / 2 + 4;
    ctx.beginPath();
    ctx.moveTo(this.wx(p.x + nx * hw), this.wy(p.y + ny * hw));
    ctx.lineTo(this.wx(p.x - nx * hw), this.wy(p.y - ny * hw));
    ctx.strokeStyle = "#4fc3f7";
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  private drawDebug(track: Track): void {
    // element-boundary markers from the DNA (structural view)
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = "#ffb454";
    const samples = track.samples;
    // walk the element list, mapping lengths to s
    const total = track.length;
    let sAcc = 0;
    const scale = total / elementListLength(track);
    for (const el of track.dna.elements) {
      const len = (el.type === "straight" ? el.length : el.radius * el.angle) * scale;
      const idx = Math.round(sAcc / track.ds) % samples.length;
      const p = samples[idx];
      const x = this.wx(p.x);
      const y = this.wy(p.y);
      ctx.beginPath();
      ctx.arc(x, y, 2.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
      sAcc += len;
    }
  }

  private drawHoverMarker(track: Track, sHover: number, dpr: number): void {
    const ctx = this.ctx;
    const idx = Math.round(sHover / track.ds) % track.samples.length;
    const p = track.samples[idx];
    const x = this.wx(p.x);
    const y = this.wy(p.y);
    ctx.beginPath();
    ctx.arc(x, y, 5 * dpr, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffb454";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private showTooltip(state: AppState, sHover: number, px: number, py: number): void {
    const track = state.track!;
    const idx = Math.round(sHover / track.ds) % track.samples.length;
    const p = track.samples[idx];
    const i1 = (idx + 1) % track.samples.length;
    const grade = ((track.samples[i1].z - p.z) / track.ds) * 100;
    const radius = Math.abs(p.kappa) > 1e-9 ? 1 / Math.abs(p.kappa) : Infinity;
    const lines = [
      `Station      ${p.s.toFixed(0).padStart(6)} m`,
      `Elevation    ${p.z.toFixed(1).padStart(6)} m`,
    ];
    if (track.terrain) {
      lines.push(`Ground       ${p.groundZ.toFixed(1).padStart(6)} m`);
      lines.push(`Cut/Fill     ${(p.z - p.groundZ >= 0 ? "+" : "") + (p.z - p.groundZ).toFixed(1).padStart(5)} m`);
    }
    lines.push(
      `Grade        ${grade.toFixed(1).padStart(6)} %`,
      `Radius       ${(Number.isFinite(radius) ? radius.toFixed(0) : "  ---").padStart(6)} m`,
      `Banking      ${((p.bank * 180) / Math.PI).toFixed(1).padStart(6)} °`,
      `Speed        ${(Number.isFinite(p.speed) ? (p.speed * 3.6).toFixed(0) : "---").padStart(6)} km/h`,
    );
    this.tooltip.textContent = lines.join("\n");
    this.tooltip.style.display = "block";
    const parent = this.canvas.parentElement!;
    const tw = 170;
    this.tooltip.style.left = `${Math.min(px + 16, parent.clientWidth - tw)}px`;
    this.tooltip.style.top = `${Math.max(8, py - 20)}px`;
  }
}

function elementListLength(track: Track): number {
  let L = 0;
  for (const el of track.dna.elements) {
    L += el.type === "straight" ? el.length : el.radius * el.angle;
  }
  return Math.max(1, L);
}
