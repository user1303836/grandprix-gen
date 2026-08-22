/**
 * LandXML 1.2 export: horizontal alignment (CoordGeom), vertical profile
 * (ProfAlign), existing ground profile, and terrain surface (TIN).
 * Importable into Autodesk Civil 3D and other civil tools.
 */

import type { TerrainSurface } from "../core/terrain";
import type { Track } from "../core/types";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** LandXML point order: "northing easting elevation" space separated. */
export function trackToLandXML(
  track: Track,
  opts: { terrain?: TerrainSurface | null; name?: string } = {},
): string {
  const name = opts.name ?? "grandprix-gen circuit";
  const s = track.samples;
  const n = s.length;
  const out: string[] = [];

  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(
    `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="${new Date().toISOString().slice(0, 10)}" time="00:00:00">`,
  );
  out.push(
    `  <Units><Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="kPa" diameterUnit="millimeter" angularUnit="decimal dd.mm.ss" directionUnit="decimal dd.mm.ss"/></Metric>`,
  );
  out.push(`  <Project name="${xmlEscape(name)}"/>`);

  if (track.site) {
    out.push(
      `  <CoordinateSystem horizontalCoordinateSystemName="WGS84-Local(lat=${track.site.lat},lon=${track.site.lon})" ` +
        `location="${track.site.lat.toFixed(7)} ${track.site.lon.toFixed(7)}" description="Local ENU meters referenced to WGS84 site origin"/>`,
    );
  }

  // alignment
  out.push(`  <Alignments name="${xmlEscape(name)}">`);
  out.push(
    `    <Alignment name="circuit_centerline" length="${track.length.toFixed(3)}" staStart="0" desc="seed ${track.seed} generated circuit">`,
  );
  out.push(`      <CoordGeom>`);
  // piecewise-linear element list (matches canonical samples)
  for (let i = 0; i < n; i++) {
    const a = s[i];
    const b = s[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    out.push(
      `        <Line dir="${((Math.atan2(dx, dy) + 2 * Math.PI) % (2 * Math.PI)).toFixed(8)}" length="${len.toFixed(4)}">` +
        `<Start>${a.y.toFixed(4)} ${a.x.toFixed(4)}</Start><End>${b.y.toFixed(4)} ${b.x.toFixed(4)}</End></Line>`,
    );
  }
  out.push(`      </CoordGeom>`);

  // vertical design profile
  out.push(`      <Profile name="circuit_profile">`);
  out.push(`        <ProfAlign name="design">`);
  const step = Math.max(1, Math.round(25 / track.ds)); // every ~25 m
  for (let i = 0; i < n; i += step) {
    out.push(`          <PVI>${s[i].s.toFixed(3)} ${s[i].z.toFixed(3)}</PVI>`);
  }
  out.push(`        </ProfAlign>`);
  // existing ground profile (site mode)
  if (track.terrain) {
    out.push(`        <ProfAlign name="existing_ground">`);
    for (let i = 0; i < n; i += step) {
      if (Number.isFinite(s[i].groundZ)) {
        out.push(`          <PVI>${s[i].s.toFixed(3)} ${s[i].groundZ.toFixed(3)}</PVI>`);
      }
    }
    out.push(`        </ProfAlign>`);
  }
  out.push(`      </Profile>`);
  out.push(`    </Alignment>`);
  out.push(`  </Alignments>`);

  // terrain surface (TIN)
  if (opts.terrain) {
    const g = opts.terrain;
    const maxPnts = 20000;
    const totalCells = g.width * g.height;
    const stride = Math.max(1, Math.floor(Math.sqrt(totalCells / maxPnts)));
    const pids = new Map<string, number>();
    const pnts: string[] = [];
    const faces: string[] = [];
    let pid = 1;
    const gw = Math.floor(g.width / stride);
    const gh = Math.floor(g.height / stride);
    const idAt = (ix: number, iy: number): number => {
      const key = `${ix},${iy}`;
      const existing = pids.get(key);
      if (existing !== undefined) return existing;
      const x = g.originX + ix * stride * g.resolution;
      const y = g.originY + iy * stride * g.resolution;
      const z = g.elevationAt(x, y);
      const id = pid++;
      pids.set(key, id);
      pnts.push(`<P id="${id}">${y.toFixed(3)} ${x.toFixed(3)} ${(Number.isFinite(z) ? z : 0).toFixed(3)}</P>`);
      return id;
    };
    for (let iy = 0; iy < gh - 1; iy++) {
      for (let ix = 0; ix < gw - 1; ix++) {
        const a = idAt(ix, iy);
        const b = idAt(ix + 1, iy);
        const c = idAt(ix, iy + 1);
        const d = idAt(ix + 1, iy + 1);
        faces.push(`<F>${a} ${c} ${b}</F>`);
        faces.push(`<F>${b} ${c} ${d}</F>`);
      }
    }
    out.push(`  <Surfaces>`);
    out.push(
      `    <Surface name="existing_terrain" desc="Mapterhorn DEM resampled to ${g.resolution.toFixed(1)} m">`,
    );
    out.push(`      <Definition surfType="TIN">`);
    out.push(`        <Pnts>${pnts.join("")}</Pnts>`);
    out.push(`        <Faces>${faces.join("")}</Faces>`);
    out.push(`      </Definition>`);
    out.push(`    </Surface>`);
    out.push(`  </Surfaces>`);
  }

  out.push(`</LandXML>`);
  return out.join("\n");
}
