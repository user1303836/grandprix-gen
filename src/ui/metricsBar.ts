/**
 * Bottom status bar: headline metrics + character scores.
 */

import { el, fmtTime } from "./dom";
import type { AppState } from "./state";

function cell(label: string, value: string, cls = ""): HTMLElement {
  return el("div", { className: "metric-cell" }, [
    el("div", { className: "m-label", textContent: label }),
    el("div", { className: `m-value ${cls}`, textContent: value }),
  ]);
}

function scoreCell(label: string, value: number): HTMLElement {
  return el("div", { className: "metric-cell score-cell" }, [
    el("div", { className: "m-label", textContent: label }),
    el("div", { className: "m-value", textContent: value.toFixed(0) }),
    el("div", { className: "score-bar" }, [
      (() => {
        const d = el("div");
        d.style.width = `${Math.max(0, Math.min(100, value))}%`;
        return d;
      })(),
    ]),
  ]);
}

export function buildStatusBar(state: AppState): HTMLElement {
  const bar = el("div", { className: "statusbar" });
  const m = state.metrics;
  if (!m) {
    bar.append(cell("STATUS", state.busy ?? "no circuit yet"));
    if (state.validation && !state.validation.valid) {
      bar.append(cell("VALIDITY", state.validation.issues.join("; "), "warn"));
    }
    return bar;
  }
  bar.append(cell("LAP", fmtTime(m.lapTime), "accent"));
  bar.append(cell("LENGTH", `${m.lengthKm.toFixed(2)} km`));
  bar.append(cell("CORNERS", String(m.cornerCount)));
  bar.append(cell("AVG", `${m.avgSpeedKmh.toFixed(0)} km/h`));
  bar.append(cell("VMAX", `${m.maxSpeedKmh.toFixed(0)} km/h`));
  bar.append(cell("VMIN", `${m.minSpeedKmh.toFixed(0)} km/h`));
  bar.append(cell("FULL THR", `${m.fullThrottlePct.toFixed(0)}%`));
  bar.append(cell("BRAKE ZONES", `${m.brakingZoneCount} (${m.heavyBrakingZones} hard)`));
  bar.append(cell("Δ ELEV", `${m.elevationRange.toFixed(0)} m`));
  bar.append(cell("MAX GRADE", `${m.maxGradePct.toFixed(1)}%`));
  if (m.meanAbsCutFill > 0.01) {
    bar.append(cell("EARTHWORK", `${m.meanAbsCutFill.toFixed(1)} m avg`));
    bar.append(cell("CUT/FILL", `${m.maxCut.toFixed(0)}/${m.maxFill.toFixed(0)} m`));
  }
  bar.append(scoreCell("FLOW", m.flow));
  bar.append(scoreCell("TECH", m.technicality));
  bar.append(scoreCell("VARIETY", m.cornerDiversity));
  bar.append(scoreCell("RHYTHM", m.rhythmicComplexity));
  bar.append(scoreCell("OVERTAKE", m.overtakingPotential));
  if (state.validation && !state.validation.valid) {
    bar.append(cell("⚠ VALIDITY", state.validation.issues.join("; "), "warn"));
  }
  return bar;
}
