/**
 * SVG top-down circuit drawing.
 */

import type { Track } from "../core/types";

export interface SvgOptions {
  width?: number;
  drawEdges?: boolean;
  drawCornerNumbers?: boolean;
  drawSectors?: boolean;
  drawGrid?: boolean;
  dark?: boolean;
}

export function trackToSvg(track: Track, opts: SvgOptions = {}): string {
  const W = opts.width ?? 1200;
  const dark = opts.dark ?? true;
  const samples = track.samples;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of samples) {
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x;
    if (s.y > maxY) maxY = s.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const pad = w * 0.06 + 20;
  const H = (W * (h + 2 * pad)) / (w + 2 * pad);
  const sx = (x: number) => ((x - minX + pad) / (w + 2 * pad)) * W;
  const sy = (y: number) => H - ((y - minY + pad) / (h + 2 * pad)) * H;

  const stroke = dark ? "#e8e8e8" : "#1a1a1a";
  const edge = dark ? "#8a8f98" : "#555";
  const bg = dark ? "#14161a" : "#ffffff";
  const accent = "#4fc3f7";
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}">`,
  );
  parts.push(`<rect width="100%" height="100%" fill="${bg}"/>`);

  if (opts.drawGrid) {
    const gridLines: string[] = [];
    const step = 200; // meters
    for (let gx = Math.floor(minX / step) * step; gx <= maxX; gx += step) {
      gridLines.push(
        `<line x1="${sx(gx).toFixed(1)}" y1="0" x2="${sx(gx).toFixed(1)}" y2="${H.toFixed(0)}" stroke="${dark ? "#22262c" : "#e0e0e0"}" stroke-width="1"/>`,
      );
    }
    for (let gy = Math.floor(minY / step) * step; gy <= maxY; gy += step) {
      gridLines.push(
        `<line x1="0" y1="${sy(gy).toFixed(1)}" x2="${W.toFixed(0)}" y2="${sy(gy).toFixed(1)}" stroke="${dark ? "#22262c" : "#e0e0e0"}" stroke-width="1"/>`,
      );
    }
    parts.push(`<g id="grid">${gridLines.join("")}</g>`);
  }

  // track band (filled per segment, colored by surface kind)
  if (opts.drawEdges !== false) {
    const SURF_DARK = ["#26272c", "#3a3936", "#7a7870", "#2b2c31"];
    const segs: string[] = [];
    const n2 = samples.length;
    const step2 = Math.max(1, Math.round(n2 / 600));
    for (let i = 0; i < n2; i += step2) {
      const a = samples[i];
      const b = samples[(i + step2) % n2];
      const sk = track.props?.surface[i] ?? 0;
      const col = dark ? SURF_DARK[sk] ?? SURF_DARK[0] : ["#555", "#777", "#aaa", "#666"][sk] ?? "#555";
      const an = { x: -Math.sin(a.heading), y: Math.cos(a.heading) };
      const bn = { x: -Math.sin(b.heading), y: Math.cos(b.heading) };
      const aw = a.width / 2;
      const bw = b.width / 2;
      const pts = [
        `${sx(a.x + an.x * aw).toFixed(1)},${sy(a.y + an.y * aw).toFixed(1)}`,
        `${sx(b.x + bn.x * bw).toFixed(1)},${sy(b.y + bn.y * bw).toFixed(1)}`,
        `${sx(b.x - bn.x * bw).toFixed(1)},${sy(b.y - bn.y * bw).toFixed(1)}`,
        `${sx(a.x - an.x * aw).toFixed(1)},${sy(a.y - an.y * aw).toFixed(1)}`,
      ];
      segs.push(`<polygon points="${pts.join(" ")}" fill="${col}"/>`);
    }
    parts.push(`<g id="track-band">${segs.join("")}</g>`);
    // outline
    const left: string[] = [];
    const right: string[] = [];
    for (const s of samples) {
      const nx = -Math.sin(s.heading);
      const ny = Math.cos(s.heading);
      const hw = s.width / 2;
      left.push(`${sx(s.x + nx * hw).toFixed(1)},${sy(s.y + ny * hw).toFixed(1)}`);
      right.push(`${sx(s.x - nx * hw).toFixed(1)},${sy(s.y - ny * hw).toFixed(1)}`);
    }
    parts.push(`<polyline points="${left.join(" ")}" fill="none" stroke="${edge}" stroke-width="1.2"/>`);
    parts.push(`<polyline points="${right.join(" ")}" fill="none" stroke="${edge}" stroke-width="1.2"/>`);
  }

  // sector tinting of the centerline
  if (opts.drawSectors && track.sectors.length === 3) {
    const colors = ["#e0533d", "#3de08b", "#4f9ff7"];
    track.sectors.forEach((sec, i) => {
      const pts: string[] = [];
      const n = samples.length;
      const i0 = Math.round(sec.sStart / track.ds);
      const i1 = Math.round(sec.sEnd / track.ds);
      for (let k = i0; k !== (i1 + 1) % n; k = (k + 1) % n) {
        pts.push(`${sx(samples[k].x).toFixed(1)},${sy(samples[k].y).toFixed(1)}`);
        if (pts.length > n) break;
      }
      parts.push(
        `<polyline points="${pts.join(" ")}" fill="none" stroke="${colors[i]}" stroke-width="3" stroke-opacity="0.55"/>`,
      );
    });
  }

  // centerline
  const center = samples.map((s) => `${sx(s.x).toFixed(1)},${sy(s.y).toFixed(1)}`).join(" ");
  parts.push(
    `<polyline points="${center}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>`,
  );

  // start/finish: checkered marker
  const sf = samples[0];
  const sfX = sx(sf.x);
  const sfY = sy(sf.y);
  parts.push(`<g id="start-finish">
<circle cx="${sfX.toFixed(1)}" cy="${sfY.toFixed(1)}" r="9" fill="none" stroke="${accent}" stroke-width="2.5"/>
<circle cx="${sfX.toFixed(1)}" cy="${sfY.toFixed(1)}" r="3" fill="${accent}"/>
</g>`);

  // corner numbers
  if (opts.drawCornerNumbers !== false) {
    const labels: string[] = [];
    for (const c of track.corners) {
      const idx = Math.round(c.sApex / track.ds) % samples.length;
      const s = samples[idx];
      const nx = -Math.sin(s.heading);
      const ny = Math.cos(s.heading);
      const off = s.width / 2 + 22;
      const lx = sx(s.x + nx * off * (c.direction === "L" ? -1 : 1));
      const ly = sy(s.y + ny * off * (c.direction === "L" ? -1 : 1));
      labels.push(
        `<g><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="10" fill="${bg}" stroke="${edge}" stroke-width="1"/>` +
          `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" font-family="ui-monospace, monospace" font-size="11" fill="${stroke}" text-anchor="middle">T${c.id}</text></g>`,
      );
    }
    parts.push(`<g id="corners">${labels.join("")}</g>`);
  }

  // feature place labels
  if (track.features && track.features.length > 0) {
    const labels: string[] = [];
    for (const f of track.features) {
      const sMid = ((f.sStart + f.sEnd) / 2) % track.length;
      const idx = Math.round(sMid / track.ds) % samples.length;
      const s = samples[idx];
      const nx = -Math.sin(s.heading);
      const ny = Math.cos(s.heading);
      const off = s.width / 2 + 30;
      const lx = sx(s.x + nx * off);
      const ly = sy(s.y + ny * off);
      labels.push(
        `<line x1="${sx(s.x + nx * (s.width / 2 + 4)).toFixed(1)}" y1="${sy(s.y + ny * (s.width / 2 + 4)).toFixed(1)}" x2="${lx.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="#ffb454" stroke-width="0.8" stroke-opacity="0.6"/>` +
          `<text x="${lx.toFixed(1)}" y="${(ly - 3).toFixed(1)}" font-family="Georgia, serif" font-style="italic" font-size="12" fill="#ffb454">${f.name}</text>`,
      );
    }
    parts.push(`<g id="features">${labels.join("")}</g>`);
  }

  // metadata footer
  const meta = `${(track.length / 1000).toFixed(2)} km · ${track.corners.length} corners · seed ${track.seed}`;
  parts.push(
    `<text x="14" y="${(H - 12).toFixed(1)}" font-family="ui-monospace, monospace" font-size="13" fill="${edge}">${meta}</text>`,
  );

  parts.push("</svg>");
  return parts.join("\n");
}
