/**
 * Right-hand parameter sidebar. Morphable sliders morph the existing
 * circuit live; structural sliders re-synthesize on release.
 */

import { el, section, sliderRow } from "./dom";
import { MORPHABLE_PARAMS, type TrackParams } from "../core/types";
import type { AppState } from "./state";

export interface SidebarCallbacks {
  onMorphParam: (key: keyof TrackParams, value: number) => void;
  onStructuralParam: (key: keyof TrackParams, value: number | string) => void;
  onVehicle: (id: string) => void;
  onDisplay: (patch: Partial<AppState>) => void;
  onUndo: () => void;
  onRedo: () => void;
  onHistoryJump: (index: number) => void;
  onLockSet: (which: "start" | "end") => void;
  onLockClear: () => void;
  onLockRegen: () => void;
  onClearSite: () => void;
}

const P = (v: number) => `${Math.round(v * 100)}`;
const PCT = (v: number) => `${Math.round(v * 100)}%`;

export function buildSidebar(state: AppState, cb: SidebarCallbacks): HTMLElement {
  const p = state.params;
  const wrap = el("div", { className: "sidebar" });

  const morph = (key: keyof TrackParams) => (v: number) => cb.onMorphParam(key, v);
  const morphCommit = (key: keyof TrackParams) => (v: number) => cb.onMorphParam(key, v);
  const struct = (key: keyof TrackParams) => (v: number) => cb.onStructuralParam(key, v);

  // ---------------------------------------------------------- structure
  const structureBody: HTMLElement[] = [];
  {
    const row = el("div", { className: "ctl" });
    const label = el("label", { textContent: "target length (km)" });
    const input = el("input", { type: "number", min: 1.5, max: 12, step: 0.1, value: (p.targetLength / 1000).toFixed(1) });
    input.addEventListener("change", () => cb.onStructuralParam("targetLength", Number(input.value) * 1000));
    row.append(label, input);
    structureBody.push(row);
  }
  structureBody.push(
    sliderRow("corner count", {
      min: 4, max: 26, step: 1, value: p.cornerCount, badge: "struct",
      format: (v) => String(Math.round(v)),
      onInput: () => {}, onCommit: struct("cornerCount"),
    }),
  );
  // geometry mode radio
  const modeRow = el("div", { className: "radio-row" }, [
    el("span", { textContent: "geometry:", style: "color:var(--text-faint)" }),
  ]);
  for (const m of ["experimental", "realistic"] as const) {
    const id = `mode-${m}`;
    const radio = el("input", { type: "radio", name: "geomode", id, value: m });
    if (p.mode === m) radio.checked = true;
    radio.addEventListener("change", () => cb.onStructuralParam("mode", m));
    modeRow.append(el("label", {}, [radio, m]));
  }
  structureBody.push(modeRow);
  {
    const row = el("div", { className: "ctl" });
    const label = el("label", { textContent: "direction" });
    const sel = el("select");
    for (const d of ["random", "ccw", "cw"] as const) {
      const opt = el("option", { value: d, textContent: d });
      if (p.direction === d) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener("change", () => cb.onStructuralParam("direction", sel.value));
    row.append(label, sel);
    structureBody.push(row);
  }
  wrap.append(section("Structure", structureBody, true));

  // ---------------------------------------------------------- character
  wrap.append(
    section("Character", [
      sliderRow("flow", { min: 0, max: 1, step: 0.01, value: p.flow, badge: "morph", format: P, onInput: morph("flow"), onCommit: morphCommit("flow") }),
      sliderRow("technicality", { min: 0, max: 1, step: 0.01, value: p.technicality, badge: "morph", format: P, onInput: morph("technicality"), onCommit: morphCommit("technicality") }),
      sliderRow("corner variety", { min: 0, max: 1, step: 0.01, value: p.cornerVariety, badge: "morph", format: P, onInput: morph("cornerVariety"), onCommit: morphCommit("cornerVariety") }),
      sliderRow("curvature severity", { min: 0, max: 1, step: 0.01, value: p.curvatureSeverity, badge: "morph", format: P, onInput: morph("curvatureSeverity"), onCommit: morphCommit("curvatureSeverity") }),
      sliderRow("long straight bias", { min: 0, max: 1, step: 0.01, value: p.longStraightBias, badge: "morph", format: P, onInput: morph("longStraightBias"), onCommit: morphCommit("longStraightBias") }),
      sliderRow("hairpin freq", { min: 0, max: 1, step: 0.01, value: p.hairpinFreq, badge: "struct", format: P, onInput: () => {}, onCommit: struct("hairpinFreq") }),
      sliderRow("sweeper freq", { min: 0, max: 1, step: 0.01, value: p.sweeperFreq, badge: "struct", format: P, onInput: () => {}, onCommit: struct("sweeperFreq") }),
      sliderRow("esses freq", { min: 0, max: 1, step: 0.01, value: p.essesFreq, badge: "struct", format: P, onInput: () => {}, onCommit: struct("essesFreq") }),
      sliderRow("chicane freq", { min: 0, max: 1, step: 0.01, value: p.chicaneFreq, badge: "struct", format: P, onInput: () => {}, onCommit: struct("chicaneFreq") }),
    ], true),
  );

  // ---------------------------------------------------------- shape
  wrap.append(
    section("Shape", [
      sliderRow("compactness", { min: 0, max: 1, step: 0.01, value: p.compactness, badge: "morph", format: P, onInput: morph("compactness"), onCommit: morphCommit("compactness") }),
      sliderRow("elongation", { min: 0, max: 1, step: 0.01, value: p.elongation, badge: "morph", format: P, onInput: morph("elongation"), onCommit: morphCommit("elongation") }),
      sliderRow("asymmetry", { min: 0, max: 1, step: 0.01, value: p.asymmetry, badge: "morph", format: P, onInput: morph("asymmetry"), onCommit: morphCommit("asymmetry") }),
      sliderRow("left/right balance", { min: 0, max: 1, step: 0.01, value: p.leftRightBalance, badge: "struct", format: P, onInput: () => {}, onCommit: struct("leftRightBalance") }),
    ], false),
  );

  // ---------------------------------------------------------- elevation
  wrap.append(
    section("Elevation & Cross Section", [
      sliderRow("elevation intensity", { min: 0, max: 1, step: 0.01, value: p.elevationIntensity, badge: "morph", format: P, onInput: morph("elevationIntensity"), onCommit: morphCommit("elevationIntensity") }),
      sliderRow("corner coupling", { min: 0, max: 1, step: 0.01, value: p.elevationCoupling, badge: "morph", format: P, onInput: morph("elevationCoupling"), onCommit: morphCommit("elevationCoupling") }),
      sliderRow("max grade", { min: 0.03, max: 0.22, step: 0.005, value: p.maxGrade, badge: "morph", format: (v) => PCT(v), onInput: morph("maxGrade"), onCommit: morphCommit("maxGrade") }),
      sliderRow("banking", { min: 0, max: 1, step: 0.01, value: p.banking, badge: "morph", format: P, onInput: morph("banking"), onCommit: morphCommit("banking") }),
      sliderRow("off-camber", { min: 0, max: 1, step: 0.01, value: p.offCamber, badge: "morph", format: P, onInput: morph("offCamber"), onCommit: morphCommit("offCamber") }),
      sliderRow("track width (m)", { min: 9, max: 18, step: 0.5, value: p.width, badge: "morph", format: (v) => v.toFixed(1), onInput: morph("width"), onCommit: morphCommit("width") }),
    ], false),
  );

  // ---------------------------------------------------------- terrain
  if (state.terrain) {
    wrap.append(
      section("Terrain", [
        sliderRow("terrain adherence", { min: 0, max: 1, step: 0.01, value: p.terrainAdherence, badge: "morph", format: P, onInput: morph("terrainAdherence"), onCommit: morphCommit("terrainAdherence") }),
        sliderRow("earthwork tolerance", { min: 0, max: 1, step: 0.01, value: p.earthworkTolerance, badge: "morph", format: P, onInput: morph("earthworkTolerance"), onCommit: morphCommit("earthworkTolerance") }),
        sliderRow("max cut (m)", { min: 2, max: 40, step: 1, value: p.maxCut, badge: "morph", format: (v) => v.toFixed(0), onInput: morph("maxCut"), onCommit: morphCommit("maxCut") }),
        sliderRow("max fill (m)", { min: 2, max: 40, step: 1, value: p.maxFill, badge: "morph", format: (v) => v.toFixed(0), onInput: morph("maxFill"), onCommit: morphCommit("maxFill") }),
        sliderRow("contour following", { min: 0, max: 1, step: 0.01, value: p.contourFollowing, badge: "morph", format: P, onInput: morph("contourFollowing"), onCommit: morphCommit("contourFollowing") }),
        (() => {
          const row = el("div", { className: "toggle-row" });
          row.append(el("span", { className: "hint", textContent: "avoid buildings:", style: "align-self:center" }));
          for (const mode of ["off", "soft", "hard"] as const) {
            const b = el("button", { textContent: mode });
            if (state.avoidBuildings === mode) b.classList.add("active");
            b.addEventListener("click", () => {
              cb.onDisplay({ avoidBuildings: mode });
              row.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
              b.classList.add("active");
            });
            row.append(b);
          }
          return row;
        })(),
        el("div", { className: "hint", textContent: "adherence = route follows the land; earthwork = how far the road elevation may deviate from ground (civil engineering freedom)." }),
        (() => {
          const b = el("button", { textContent: "CLEAR SITE (blank canvas)" });
          b.addEventListener("click", cb.onClearSite);
          return b;
        })(),
      ], true),
    );
  }

  // ---------------------------------------------------------- vehicle
  const vehicleBody: HTMLElement[] = [];
  const vRow = el("div", { className: "toggle-row" });
  for (const id of ["gt3", "prototype", "formula", "road"] as const) {
    const names = { gt3: "GT3", prototype: "Prototype", formula: "Formula", road: "Road Car" };
    const b = el("button", { textContent: names[id] });
    if (state.vehicleId === id) b.classList.add("active");
    b.addEventListener("click", () => {
      cb.onVehicle(id);
      vRow.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    });
    vRow.append(b);
  }
  vehicleBody.push(vRow);
  wrap.append(section("Vehicle", vehicleBody, false));

  // ---------------------------------------------------------- display
  const displayBody: HTMLElement[] = [];
  const heatRow = el("div", { className: "toggle-row" });
  const layers: [string, string][] = [
    ["curvature", "Curvature"],
    ["speed", "Speed"],
    ["elevation", "Elevation"],
    ["grade", "Grade"],
    ["cutfill", "Cut/Fill"],
    ["banking", "Banking"],
    ["none", "Plain"],
  ];
  for (const [id, name] of layers) {
    const b = el("button", { textContent: name });
    if (state.heatLayer === id) b.classList.add("active");
    b.addEventListener("click", () => {
      cb.onDisplay({ heatLayer: id as AppState["heatLayer"] });
      heatRow.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    });
    heatRow.append(b);
  }
  displayBody.push(el("div", { className: "hint", textContent: "heat layer" }));
  displayBody.push(heatRow);
  const toggleRow2 = el("div", { className: "toggle-row" });
  const toggles: [string, string, boolean][] = [
    ["showSectors", "Sectors", state.showSectors],
    ["showCorners", "Corners", state.showCorners],
    ["showControlPoints", "Debug DNA", state.showControlPoints],
    ["showTerrainHeat", "Terrain", state.showTerrainHeat],
  ];
  for (const [key, name, val] of toggles) {
    const b = el("button", { textContent: name });
    if (val) b.classList.add("active");
    b.addEventListener("click", () => {
      const cur = !(state as unknown as Record<string, boolean>)[key];
      cb.onDisplay({ [key]: cur } as Partial<AppState>);
      b.classList.toggle("active", cur);
    });
    toggleRow2.append(b);
  }
  displayBody.push(toggleRow2);
  wrap.append(section("Display", displayBody, false));

  // ---------------------------------------------------------- section lock
  const lock = state.lockRange;
  const lockBody: HTMLElement[] = [];
  lockBody.push(
    el("div", {
      className: "hint",
      textContent: lock
        ? `locked: ${lock.sStart.toFixed(0)} m \u2192 ${lock.sEnd.toFixed(0)} m (hover the track in 2D, then set)`
        : "hover the track in 2D, set a range, then regenerate everything outside it.",
    }),
  );
  const lockRow = el("div", { className: "toggle-row" });
  const setStart = el("button", { textContent: "set start" });
  setStart.addEventListener("click", () => cb.onLockSet("start"));
  const setEnd = el("button", { textContent: "set end" });
  setEnd.addEventListener("click", () => cb.onLockSet("end"));
  const clear = el("button", { textContent: "clear" });
  clear.addEventListener("click", cb.onLockClear);
  lockRow.append(setStart, setEnd, clear);
  lockBody.push(lockRow);
  const regen = el("button", { className: "primary", textContent: "REGENERATE OUTSIDE LOCK" });
  regen.disabled = !lock;
  regen.addEventListener("click", cb.onLockRegen);
  lockBody.push(regen);
  wrap.append(section("Section Lock", lockBody, false));

  // ---------------------------------------------------------- history
  const histBody: HTMLElement[] = [];
  const ur = el("div", { className: "toggle-row" });
  const undoB = el("button", { textContent: "⟲ undo" });
  const redoB = el("button", { textContent: "⟳ redo" });
  undoB.addEventListener("click", cb.onUndo);
  redoB.addEventListener("click", cb.onRedo);
  ur.append(undoB, redoB);
  histBody.push(ur);
  const histList = el("div", { className: "history-list" });
  state.history.forEach((h, i) => {
    const item = el("div", {
      className: `history-item${i === state.historyIndex ? " current" : ""}`,
    }, [
      el("span", { textContent: h.label }),
      el("span", { textContent: `${(h.track.length / 1000).toFixed(2)}km` }),
    ]);
    item.addEventListener("click", () => cb.onHistoryJump(i));
    histList.append(item);
  });
  histBody.push(histList);
  wrap.append(section("History", histBody, false));

  return wrap;
}

export { MORPHABLE_PARAMS };
