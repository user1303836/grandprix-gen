/**
 * Candidate strip: mini track thumbnails with labels + selection for
 * adoption and breeding.
 */

import { el } from "./dom";
import type { Candidate } from "../core/search";
import type { Track } from "../core/types";

export interface CandidateCallbacks {
  onAdopt: (index: number) => void;
  onToggleSelect: (index: number) => void;
}

export function drawTrackThumbnail(canvas: HTMLCanvasElement, track: Track): void {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0c0e11";
  ctx.fillRect(0, 0, w, h);
  const s = track.samples;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of s) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const sc = Math.min((w - 16) / Math.max(1, maxX - minX), (h - 16) / Math.max(1, maxY - minY));
  const ox = (w - (maxX - minX) * sc) / 2;
  const oy = (h - (maxY - minY) * sc) / 2;
  const px = (x: number) => (x - minX) * sc + ox;
  const py = (y: number) => h - ((y - minY) * sc + oy);
  // curvature heat centerline
  const n = s.length;
  const step = Math.max(1, Math.round(n / 400));
  ctx.lineWidth = 1.6;
  for (let i = 0; i < n; i += step) {
    const a = s[i];
    const b = s[(i + step) % n];
    const t = Math.min(1, Math.abs(a.kappa) / 0.025);
    ctx.strokeStyle = `rgb(${Math.round(230 * t + 60)},${Math.round(215 * (1 - t) + 40)},${Math.round(90 * (1 - t) + 40)})`;
    ctx.beginPath();
    ctx.moveTo(px(a.x), py(a.y));
    ctx.lineTo(px(b.x), py(b.y));
    ctx.stroke();
  }
  // start/finish
  ctx.fillStyle = "#4fc3f7";
  ctx.beginPath();
  ctx.arc(px(s[0].x), py(s[0].y), 2.5, 0, Math.PI * 2);
  ctx.fill();
}

export function buildCandidateStrip(
  candidates: Candidate[],
  selected: Set<number>,
  cb: CandidateCallbacks,
): HTMLElement {
  const strip = el("div", { className: "candidate-strip" });
  candidates.forEach((c, i) => {
    const card = el("div", { className: `candidate-card${selected.has(i) ? " selected" : ""}` });
    const cv = el("canvas", { width: 190 * 2, height: 110 * 2 });
    cv.style.width = "190px";
    cv.style.height = "110px";
    drawTrackThumbnail(cv, c.track);
    cv.addEventListener("click", () => cb.onAdopt(i));
    card.append(cv);
    card.append(el("div", { className: "cc-label", textContent: c.label || "CANDIDATE" }));
    card.append(
      el("div", {
        className: "cc-stats",
        textContent:
          `${c.metrics.lapTime.toFixed(1)}s · ${c.metrics.cornerCount}T · ` +
          `flow ${c.metrics.flow.toFixed(0)} tech ${c.metrics.technicality.toFixed(0)}`,
      }),
    );
    const actions = el("div", { className: "cc-actions" });
    const adopt = el("button", { textContent: "adopt" });
    adopt.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onAdopt(i);
    });
    const select = el("button", { textContent: selected.has(i) ? "✓ breed" : "breed?" });
    select.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onToggleSelect(i);
    });
    actions.append(adopt, select);
    card.append(actions);
    strip.append(card);
  });
  return strip;
}
