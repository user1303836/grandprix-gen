/**
 * Instrumentation: profile graphs along the lap distance s (curvature,
 * elevation, speed, grade, cut/fill, banking) with hover-station sync.
 */

import { FeatureColors } from "../core/character";
import { el } from "./dom";
import type { AppState } from "./state";

export type GraphChannel = "kappa" | "z" | "speed" | "grade" | "cutfill" | "bank";

const CHANNELS: [GraphChannel, string][] = [
  ["kappa", "κ curvature"],
  ["speed", "speed"],
  ["z", "elevation"],
  ["grade", "grade"],
  ["cutfill", "cut/fill"],
  ["bank", "banking"],
];

export class ProfileGraph {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private channel: GraphChannel = "kappa";
  private lastState: AppState | null = null;
  hoverS: number | null = null;

  constructor() {
    this.root = el("div", { style: "background:var(--bg-panel);border-top:1px solid var(--border);display:flex;align-items:stretch;" });
    const tabs = el("div", { style: "display:flex;flex-direction:column;justify-content:center;gap:2px;padding:4px 6px;border-right:1px solid var(--border);" });
    for (const [id, name] of CHANNELS) {
      const b = el("button", { textContent: name, style: "font-size:9.5px;padding:1px 6px;text-align:left;" });
      if (id === this.channel) b.classList.add("active");
      b.addEventListener("click", () => {
        this.channel = id;
        tabs.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this.redraw();
      });
      tabs.append(b);
    }
    this.canvas = el("canvas", { style: "flex:1;height:86px;display:block;" });
    this.root.append(tabs, this.canvas);
  }

  setState(state: AppState): void {
    this.lastState = state;
    this.redraw();
  }

  redraw(): void {
    const state = this.lastState;
    const cv = this.canvas;
    const parent = cv.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0) return;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr;
      cv.height = h * dpr;
    }
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "#0c0e11";
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!state?.track) {
      ctx.fillStyle = "#3a4048";
      ctx.font = `${10 * dpr}px ui-monospace, monospace`;
      ctx.fillText("no circuit", 12 * dpr, cv.height / 2);
      return;
    }
    const track = state.track;
    const n = track.samples.length;
    const L = track.length;

    // feature tick marks across the top of the strip
    if (track.features && track.features.length > 0) {
      for (const f of track.features) {
        const x0 = (f.sStart / L) * cv.width;
        const x1 = (f.sEnd / L) * cv.width;
        ctx.fillStyle = FeatureColors[f.kind] ?? "#ffb454";
        ctx.globalAlpha = 0.75;
        ctx.fillRect(x0, 0, Math.max(2, x1 - x0), 3 * dpr);
        ctx.globalAlpha = 1;
      }
    }

    // extract channel values
    const vals = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = track.samples[i];
      switch (this.channel) {
        case "kappa":
          vals[i] = p.kappa;
          break;
        case "z":
          vals[i] = p.z;
          break;
        case "speed":
          vals[i] = Number.isFinite(p.speed) ? p.speed * 3.6 : 0;
          break;
        case "grade": {
          const j = (i + 1) % n;
          vals[i] = ((track.samples[j].z - p.z) / track.ds) * 100;
          break;
        }
        case "cutfill":
          vals[i] = track.terrain ? p.z - p.groundZ : 0;
          break;
        case "bank":
          vals[i] = (p.bank * 180) / Math.PI;
          break;
      }
    }
    let mn = Infinity;
    let mx = -Infinity;
    for (const v of vals) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (this.channel === "kappa" || this.channel === "bank" || this.channel === "grade" || this.channel === "cutfill") {
      const a = Math.max(Math.abs(mn), Math.abs(mx), 1e-6);
      mn = -a;
      mx = a;
    }
    const span = Math.max(1e-9, mx - mn);
    const pad = 14 * dpr;
    const yOf = (v: number) => cv.height - pad - ((v - mn) / span) * (cv.height - 2 * pad);
    const xOf = (i: number) => (i / n) * cv.width;

    // zero line for signed channels
    if (mn < 0 && mx > 0) {
      ctx.strokeStyle = "#2c313a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yOf(0));
      ctx.lineTo(cv.width, yOf(0));
      ctx.stroke();
    }

    // corner shading
    ctx.fillStyle = "rgba(255,180,84,0.07)";
    for (const c of track.corners) {
      const x0 = (c.sStart / L) * cv.width;
      const x1 = (c.sEnd / L) * cv.width;
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), cv.height);
    }

    // main polyline
    ctx.beginPath();
    const colors: Record<GraphChannel, string> = {
      kappa: "#e0533d",
      z: "#8bc34a",
      speed: "#4fc3f7",
      grade: "#ffb454",
      cutfill: "#ce93d8",
      bank: "#80cbc4",
    };
    ctx.strokeStyle = colors[this.channel];
    ctx.lineWidth = 1.4 * dpr;
    const step = Math.max(1, Math.round(n / 2000));
    for (let i = 0; i < n; i += step) {
      const x = xOf(i);
      const y = yOf(vals[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // min/max labels
    ctx.fillStyle = "#5a606b";
    ctx.font = `${9 * dpr}px ui-monospace, monospace`;
    const unit =
      this.channel === "kappa" ? "1/m" : this.channel === "speed" ? "km/h" : this.channel === "z" ? "m" : this.channel === "grade" || this.channel === "cutfill" ? "m/%" : "°";
    ctx.fillText(`${mx.toFixed(this.channel === "kappa" ? 4 : 1)}${unit}`, 6 * dpr, 11 * dpr);
    ctx.fillText(`${mn.toFixed(this.channel === "kappa" ? 4 : 1)}`, 6 * dpr, cv.height - 4 * dpr);
    // s labels
    ctx.fillText("0", cv.width - 60 * dpr, cv.height - 4 * dpr);
    ctx.fillText(`${(L / 2000).toFixed(1)}k`, cv.width - 34 * dpr, cv.height - 4 * dpr);

    // hover marker
    if (this.hoverS !== null) {
      const x = (this.hoverS / L) * cv.width;
      ctx.strokeStyle = "#ffb454";
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cv.height);
      ctx.stroke();
    }
  }
}
