/**
 * ASAM OpenDRIVE export (.xodr).
 *
 * The canonical samples map to a piecewise-linear reference line with
 * per-segment elevation and superelevation polynomials, plus a single
 * driving lane with piecewise width sections. Road-like by construction.
 */

import type { Track } from "../core/types";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function trackToOpenDrive(track: Track, name = "grandprix-gen circuit"): string {
  const s = track.samples;
  const n = s.length;
  const L = track.length;

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

  const out: string[] = [];
  out.push(`<?xml version="1.0" standalone="yes"?>`);
  out.push(`<OpenDRIVE>`);
  const date = new Date().toISOString();
  out.push(
    `  <header revMajor="1" revMinor="6" name="${xmlEscape(name)}" version="1.00" date="${date}" ` +
      `north="${maxY.toFixed(2)}" south="${minY.toFixed(2)}" east="${maxX.toFixed(2)}" west="${minX.toFixed(2)}">`,
  );
  if (track.site) {
    const proj =
      `+proj=tmerc +lat_0=${track.site.lat} +lon_0=${track.site.lon} +k=1 +x_0=0 +y_0=0 ` +
      `+datum=WGS84 +units=m +no_defs`;
    out.push(`    <geoReference><![CDATA[${proj}]]></geoReference>`);
  }
  out.push(`  </header>`);
  out.push(`  <road name="${xmlEscape(name)}" length="${L.toFixed(3)}" id="1" junction="-1">`);
  out.push(`    <link/>`);
  out.push(`    <planView>`);

  // one line geometry per segment (closed: last segment returns to sample 0)
  for (let i = 0; i < n; i++) {
    const a = s[i];
    const b = s[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const hdg = Math.atan2(dy, dx);
    out.push(
      `      <geometry s="${a.s.toFixed(4)}" x="${a.x.toFixed(4)}" y="${a.y.toFixed(4)}" ` +
        `hdg="${hdg.toFixed(8)}" length="${len.toFixed(4)}"><line/></geometry>`,
    );
  }
  out.push(`    </planView>`);

  // elevation profile: linear polynomial per segment
  out.push(`    <elevationProfile>`);
  for (let i = 0; i < n; i++) {
    const a = s[i];
    const b = s[(i + 1) % n];
    const dz = b.z - a.z;
    const bCoef = dz / track.ds;
    out.push(
      `      <elevation s="${a.s.toFixed(4)}" a="${a.z.toFixed(4)}" b="${bCoef.toFixed(8)}" c="0" d="0"/>`,
    );
  }
  out.push(`    </elevationProfile>`);

  // superelevation: linear per segment (bank in radians)
  out.push(`    <lateralProfile>`);
  for (let i = 0; i < n; i++) {
    const a = s[i];
    const b = s[(i + 1) % n];
    // unwrap bank delta
    let db = b.bank - a.bank;
    while (db > Math.PI) db -= 2 * Math.PI;
    while (db < -Math.PI) db += 2 * Math.PI;
    const bCoef = db / track.ds;
    // OpenDRIVE superelevation: positive = road banks right-down; our bank
    // is positive when tilting into a left turn, hence the sign flip.
    out.push(
      `      <superelevation s="${a.s.toFixed(4)}" a="${(-a.bank).toFixed(8)}" b="${(-bCoef).toFixed(10)}" c="0" d="0"/>`,
    );
  }
  out.push(`    </lateralProfile>`);

  // lanes: sections with piecewise-constant half widths
  const sectionLen = 250;
  out.push(`    <lanes>`);
  for (let s0 = 0; s0 < L; s0 += sectionLen) {
    const idx = Math.min(n - 1, Math.round(s0 / track.ds));
    const halfW = s[idx].width / 2;
    out.push(`      <laneSection s="${s0.toFixed(4)}">`);
    out.push(
      `        <left><lane id="1" type="driving" level="false">` +
        `<width sOffset="0" a="${halfW.toFixed(3)}" b="0" c="0" d="0"/>` +
        `<roadMark sOffset="0" type="solid" color="white" width="0.12"/></lane></left>`,
    );
    out.push(`        <center><lane id="0" type="none" level="false"/></center>`);
    out.push(
      `        <right><lane id="-1" type="driving" level="false">` +
        `<width sOffset="0" a="${halfW.toFixed(3)}" b="0" c="0" d="0"/>` +
        `<roadMark sOffset="0" type="solid" color="white" width="0.12"/></lane></right>`,
    );
    out.push(`      </laneSection>`);
  }
  out.push(`    </lanes>`);
  out.push(`  </road>`);
  out.push(`</OpenDRIVE>`);
  return out.join("\n");
}
