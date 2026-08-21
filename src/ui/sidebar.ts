/**
 * Right-hand parameter sidebar. Morphable sliders morph the existing
 * circuit live; structural sliders re-synthesize on release.
 */

import { el, section, sliderRow } from "./dom";
import { FeatureColors, FeatureLabels, ZoneLabels } from "../core/character";
import { MORPHABLE_PARAMS, type TrackParams } from "../core/types";
import type { AppState } from "./state";

export interface SidebarCallbacks {
  onMorphParam: (key: keyof TrackParams, value: number) => void;
  onStructuralParam: (key: keyof TrackParams, value: number | string) => void;
  onFacilityParam: (key: string, value: number | string) => void;
  onRegenerateFacilities: () => void;
  onVehicle: (id: string) => void;
  onDisplay: (patch: Partial<AppState>) => void;
  onUndo: () => void;
  onRedo: () => void;
  onHistoryJump: (index: number) => void;
  onLockSet: (which: "start" | "end") => void;
  onLockClear: () => void;
  onLockRegen: () => void;
  onClearSite: () => void;
  onPlaceJump: (feature: import("../core/character").TrackFeature) => void;

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
      sliderRow("hairpin freq", { min: 0, max: 1, step: 0.01, value: p.hairpinFreq, badge: "morph", format: P, onInput: () => {}, onCommit: struct("hairpinFreq") }),
      sliderRow("sweeper freq", { min: 0, max: 1, step: 0.01, value: p.sweeperFreq, badge: "morph", format: P, onInput: () => {}, onCommit: struct("sweeperFreq") }),
      sliderRow("esses freq", { min: 0, max: 1, step: 0.01, value: p.essesFreq, badge: "morph", format: P, onInput: () => {}, onCommit: struct("essesFreq") }),
      sliderRow("chicane freq", { min: 0, max: 1, step: 0.01, value: p.chicaneFreq, badge: "morph", format: P, onInput: () => {}, onCommit: struct("chicaneFreq") }),
    ], true),
  );

  // ---------------------------------------------------------- shape
  wrap.append(
    section("Shape", [
      sliderRow("compactness", { min: 0, max: 1, step: 0.01, value: p.compactness, badge: "morph", format: P, onInput: morph("compactness"), onCommit: morphCommit("compactness") }),
      sliderRow("elongation", { min: 0, max: 1, step: 0.01, value: p.elongation, badge: "morph", format: P, onInput: morph("elongation"), onCommit: morphCommit("elongation") }),
      sliderRow("asymmetry", { min: 0, max: 1, step: 0.01, value: p.asymmetry, badge: "morph", format: P, onInput: morph("asymmetry"), onCommit: morphCommit("asymmetry") }),
      sliderRow("left/right balance", { min: 0, max: 1, step: 0.01, value: p.leftRightBalance, badge: "morph", format: P, onInput: () => {}, onCommit: struct("leftRightBalance") }),
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

  // ---------------------------------------------------------- identity
  wrap.append(
    section("Identity", [
      sliderRow("heritage", { min: 0, max: 1, step: 0.01, value: p.heritage ?? 0.45, badge: "morph", format: P, onInput: () => {}, onCommit: struct("heritage") }),
      sliderRow("feature richness", { min: 0, max: 1, step: 0.01, value: p.featureRichness ?? 0.65, badge: "morph", format: P, onInput: () => {}, onCommit: struct("featureRichness") }),
      el("div", { className: "hint", textContent: "heritage: era/roughness/width variation tendencies. richness: how many distinctive named places (karussell, crests, wall runs…) the lap develops." }),
    ], false),
  );

  // ---------------------------------------------------------- engineering
  if (state.terrain) {
    const body: HTMLElement[] = [];
    const mkSelect = (label: string, key: string, options: string[], current: string) => {
      const row = el("div", { className: "ctl" });
      row.append(el("label", { textContent: label }));
      const sel = el("select");
      for (const o of options) {
        const opt = el("option", { value: o, textContent: o });
        if (o === current) opt.selected = true;
        sel.append(opt);
      }
      sel.addEventListener("change", () => cb.onStructuralParam(key as keyof import("../core/types").TrackParams, sel.value));
      row.append(sel);
      return row;
    };
    body.push(mkSelect("civil style", "civilStyle", ["auto", "terrain-following", "heritage", "mountain-club", "modern", "viaduct-heavy", "megaproject"], p.civilStyle ?? "auto"));
    body.push(mkSelect("feasibility", "civilFeasibility", ["auto", "realistic", "permissive", "megaproject"], p.civilFeasibility ?? "auto"));
    body.push(sliderRow("construction budget", { min: 0, max: 1, step: 0.05, value: p.civilBudget < 0 ? 0.5 : p.civilBudget, badge: "morph", format: P, onInput: morph("civilBudget"), onCommit: morphCommit("civilBudget") }));
    body.push(sliderRow("runoff standard", { min: 0, max: 1, step: 0.05, value: p.runoffStandard < 0 ? 0.5 : p.runoffStandard, badge: "morph", format: P, onInput: morph("runoffStandard"), onCommit: morphCommit("runoffStandard") }));
    body.push(sliderRow("viaduct preference", { min: -1, max: 1, step: 0.1, value: p.viaductPref ?? 0, badge: "morph", format: P, onInput: morph("viaductPref"), onCommit: morphCommit("viaductPref") }));
    body.push(sliderRow("platform preference", { min: -1, max: 1, step: 0.1, value: p.platformPref ?? 0, badge: "morph", format: P, onInput: morph("platformPref"), onCommit: morphCommit("platformPref") }));
    body.push(sliderRow("tunnel preference", { min: -1, max: 1, step: 0.1, value: p.tunnelPref ?? 0, badge: "morph", format: P, onInput: morph("tunnelPref"), onCommit: morphCommit("tunnelPref") }));
    const civ = state.track?.civil;
    if (civ) {
      const info = el("div", { className: "hint" });
      info.textContent = `${civ.feasible ? "feasible" : "INFEASIBLE"} · cost ${civ.cost.toFixed(0)}/km · earth ${(civ.analysis.volumeCut / 1000).toFixed(0)}k/${(civ.analysis.volumeFill / 1000).toFixed(0)}k m³`;
      if (!civ.feasible) info.style.color = "#e06848";
      info.title = civ.violations.join("\n");
      body.push(info);
    }
    wrap.append(section("Engineering", body, true));
  }

  // ---------------------------------------------------------- facilities
  {
    const f = state.facility;
    const body: HTMLElement[] = [];
    const mkSelect = (label: string, options: string[], current: string, onChange: (v: string) => void) => {
      const row = el("div", { className: "ctl" });
      row.append(el("label", { textContent: label }));
      const sel = el("select");
      for (const o of options) {
        const opt = el("option", { value: o, textContent: o });
        if (o === current) opt.selected = true;
        sel.append(opt);
      }
      sel.addEventListener("change", () => onChange(sel.value));
      row.append(sel);
      return row;
    };
    body.push(mkSelect("style", ["auto", "historic-low-rise", "utilitarian", "modern-linear", "monumental", "desert-canopy", "temporary-modular", "private-club", "experimental"], f.style, (v) => cb.onFacilityParam("style", v)));
    body.push(sliderRow("scale", { min: 0, max: 1, step: 0.05, value: f.scale, badge: undefined, format: P, onInput: () => {}, onCommit: (v) => cb.onFacilityParam("scale", v) }));
    body.push(sliderRow("architecture variation", { min: 0, max: 1, step: 0.05, value: f.variation, badge: undefined, format: P, onInput: () => {}, onCommit: (v) => cb.onFacilityParam("variation", v) }));
    body.push(sliderRow("grandstand density", { min: 0, max: 1, step: 0.05, value: f.grandstandDensity, badge: undefined, format: P, onInput: () => {}, onCommit: (v) => cb.onFacilityParam("grandstandDensity", v) }));
    body.push(sliderRow("crowd density", { min: 0, max: 1, step: 0.05, value: f.crowdDensity, badge: undefined, format: P, onInput: () => {}, onCommit: (v) => cb.onFacilityParam("crowdDensity", v) }));
    body.push(sliderRow("night readiness", { min: 0, max: 1, step: 0.05, value: f.nightReadiness, badge: undefined, format: P, onInput: () => {}, onCommit: (v) => cb.onFacilityParam("nightReadiness", v) }));
    const seedRow = el("div", { className: "ctl" });
    seedRow.append(el("label", { textContent: "facility seed" }));
    const seedInput = el("input", { value: String(f.seed), style: "width:110px" }) as HTMLInputElement;
    seedInput.addEventListener("change", () => cb.onFacilityParam("seed", Number(seedInput.value) >>> 0));
    seedRow.append(seedInput);
    body.push(seedRow);
    const regen = el("button", { className: "mini-btn", textContent: "Regenerate Facilities" });
    regen.addEventListener("click", () => cb.onRegenerateFacilities());
    body.push(regen);
    const plan = state.track?.facilities;
    if (plan) {
      const info = el("div", { className: "hint" });
      info.textContent = `${plan.identity.architectureStyle} · ${plan.feasible ? "feasible" : "INFEASIBLE"} · site ${(plan.site.score * 100).toFixed(0)}% ${plan.site.side} @ ${(plan.site.sStart / 1000).toFixed(1)}k`;
      if (!plan.feasible) info.style.color = "#e06848";
      info.title = plan.violations.map((v) => `${v.kind}: ${v.detail}`).join("\n") || "no violations";
      body.push(info);
    }
    wrap.append(section("Facilities", body, true));
  }

  // ---------------------------------------------------------- places
  if (state.track && (state.track.features.length > 0 || (state.track.zones ?? []).length > 0)) {
    const list = el("div", { className: "history-list", style: "max-height:200px" });
    for (const z of state.track.zones ?? []) {
      const dot = el("span", { className: "place-dot" });
      dot.style.background = "#8a97a8";
      const item = el("div", { className: "history-item" }, [
        el("span", {}, [dot, el("span", { textContent: z.name, style: "color:#9aa8b8;font-style:italic" })]),
        el("span", { textContent: `${(z.sStart / 1000).toFixed(1)}k` }),
      ]);
      item.title = `section · ${ZoneLabels[z.kind]} · ${z.sStart.toFixed(0)}–${z.sEnd.toFixed(0)} m`;
      list.append(item);
    }
    for (const f of state.track.features) {
      const dot = el("span", { className: "place-dot" });
      dot.style.background = FeatureColors[f.kind];
      const item = el("div", { className: "history-item" }, [
        el("span", {}, [dot, el("span", { textContent: f.name })]),
        el("span", { textContent: `${(f.sStart / 1000).toFixed(1)}k` }),
      ]);
      item.title = `${FeatureLabels[f.kind]} · station ${f.sStart.toFixed(0)}–${f.sEnd.toFixed(0)} m`;
      item.addEventListener("click", () => cb.onPlaceJump(f));
      list.append(item);
    }
    wrap.append(section(`Places (${state.track.features.length})`, [list], true));
  }

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
    ["debugCivil", "Civil", state.debugCivil],
    ["showSatellite", "Satellite", state.showSatellite],
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
