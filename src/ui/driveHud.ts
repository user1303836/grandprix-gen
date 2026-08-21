/**
 * Drive-mode HUD: speed, synthetic gear/rpm, lap time, throttle/brake
 * trace, mini track map with position dot, and feature-name flashes.
 * HTML overlay driven from the 3D tick.
 */

import { FeatureColors, FeatureLabels } from "../core/character";
import type { AppState } from "./state";
import type { Track } from "../core/types";

export class DriveHUD {
  private root: HTMLDivElement;
  private speedEl: HTMLDivElement;
  private gearEl: HTMLDivElement;
  private rpmFill: HTMLDivElement;
  private pedalEl: HTMLDivElement;
  private lapEl: HTMLDivElement;
  private placeEl: HTMLDivElement;
  private mapCanvas: HTMLCanvasElement;
  private mapCtx: CanvasRenderingContext2D;
  private outline: { x: number; y: number }[] | null = null;
  private mapBounds = { minX: 0, minY: 0, scale: 1 };
  private lastFeatureIdx = -1;
  private flashT = 0;
  private lapStartS = 0;
  private lapTimes: number[] = [];

  constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "drive-hud";
    this.root.style.display = "none";

    const left = document.createElement("div");
    left.className = "hud-left";
    this.speedEl = document.createElement("div");
    this.speedEl.className = "hud-speed";
    this.gearEl = document.createElement("div");
    this.gearEl.className = "hud-gear";
    const rpmBar = document.createElement("div");
    rpmBar.className = "hud-rpmbar";
    this.rpmFill = document.createElement("div");
    this.rpmFill.className = "hud-rpmfill";
    rpmBar.appendChild(this.rpmFill);
    this.pedalEl = document.createElement("div");
    this.pedalEl.className = "hud-pedal";
    this.lapEl = document.createElement("div");
    this.lapEl.className = "hud-lap";
    left.append(this.speedEl, this.gearEl, rpmBar, this.pedalEl, this.lapEl);

    this.placeEl = document.createElement("div");
    this.placeEl.className = "hud-place";

    this.mapCanvas = document.createElement("canvas");
    this.mapCanvas.className = "hud-map";
    this.mapCanvas.width = 200;
    this.mapCanvas.height = 200;
    this.mapCtx = this.mapCanvas.getContext("2d")!;

    this.root.append(left, this.placeEl, this.mapCanvas);
    container.appendChild(this.root);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? "grid" : "none";
    if (v) {
      this.lastFeatureIdx = -1;
      this.lapStartS = 0;
      this.lapTimes = [];
    }
  }

  private prepareMap(track: Track): void {
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
    const span = Math.max(maxX - minX, maxY - minY, 1);
    this.mapBounds = { minX, minY, scale: 176 / span };
    this.outline = track.samples.map((s) => ({
      x: (s.x - minX) * this.mapBounds.scale + 12,
      y: 188 - (s.y - minY) * this.mapBounds.scale,
    }));
  }

  update(state: AppState, driveS: number, v: number, dt: number): void {
    const track = state.track;
    if (!track) return;
    if (!this.outline) this.prepareMap(track);

    // speed + synthetic gear/rpm
    const kmh = v * 3.6;
    const gears = [0, 62, 92, 124, 158, 196, 238, 292, 340];
    let gear = 1;
    while (gear < 8 && kmh > gears[gear]) gear++;
    const lo = gears[gear - 1];
    const hi = gears[gear];
    const rpm = Math.max(0.12, Math.min(1, (kmh - lo) / (hi - lo)));
    this.speedEl.innerHTML = `${kmh.toFixed(0)}<span class="unit"> km/h</span>`;
    this.gearEl.textContent = `${gear}`;
    this.rpmFill.style.width = `${(rpm * 100).toFixed(1)}%`;
    this.rpmFill.style.background = rpm > 0.92 ? "#e04838" : "#4ab8ff";

    // pedal trace from the speed profile derivative
    const i = Math.floor(driveS / track.ds) % track.samples.length;
    const i2 = (i + 2) % track.samples.length;
    const accel = Number.isFinite(track.samples[i2].speed) ? track.samples[i2].speed - track.samples[i].speed : 0;
    const isBrake = accel < -0.35;
    const isFull = accel > -0.05;
    this.pedalEl.className = `hud-pedal ${isBrake ? "brake" : isFull ? "throttle" : "coast"}`;
    this.pedalEl.textContent = isBrake ? "BRAKE" : isFull ? "FULL THROTTLE" : "COAST";

    // lap timer
    if (driveS < this.lapStartS) {
      this.lapTimes.push(performance.now() / 1000 - this.lapClock);
      if (this.lapTimes.length > 3) this.lapTimes.shift();
      this.lapClock = performance.now() / 1000;
    }
    if (this.lapClock === undefined) this.lapClock = performance.now() / 1000;
    this.lapStartS = driveS;
    const tNow = performance.now() / 1000 - this.lapClock;
    const best = this.lapTimes.length > 0 ? Math.min(...this.lapTimes) : null;
    this.lapEl.textContent = `LAP ${fmtTime(tNow)}${best !== null ? `   BEST ${fmtTime(best)}` : ""}`;

    // feature flash
    const fi = track.props?.featureIdx?.[i] ?? -1;
    if (fi !== this.lastFeatureIdx) {
      this.lastFeatureIdx = fi;
      if (fi >= 0 && track.features[fi]) {
        this.flashT = 2.4;
        const f = track.features[fi];
        this.placeEl.innerHTML = `<span class="name" style="color:${FeatureColors[f.kind]}">${f.name}</span><span class="kind">${FeatureLabels[f.kind]}</span>`;
      }
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.placeEl.style.opacity = `${Math.min(1, this.flashT)}`;
    } else {
      this.placeEl.style.opacity = "0";
    }

    // mini map
    const ctx = this.mapCtx;
    ctx.clearRect(0, 0, 200, 200);
    ctx.fillStyle = "rgba(10,13,17,0.72)";
    ctx.beginPath();
    ctx.roundRect(0, 0, 200, 200, 12);
    ctx.fill();
    if (this.outline) {
      ctx.strokeStyle = "#8a94a2";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(this.outline[0].x, this.outline[0].y);
      for (const p of this.outline) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.stroke();
      // position dot
      const smp = track.samples[i];
      const dx = (smp.x - this.mapBounds.minX) * this.mapBounds.scale + 12;
      const dy = 188 - (smp.y - this.mapBounds.minY) * this.mapBounds.scale;
      ctx.fillStyle = "#ffb454";
      ctx.beginPath();
      ctx.arc(dx, dy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private lapClock!: number;
}

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}
