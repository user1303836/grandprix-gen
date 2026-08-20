/**
 * App controller: layout composition, view switching, and all user
 * actions (generate / search / breed / morph / export / history).
 */

import { Store, type ViewMode } from "./state";
import { el } from "./dom";
import { buildToolbar } from "./toolbar";
import { buildSidebar } from "./sidebar";
import { buildStatusBar } from "./metricsBar";
import { buildCandidateStrip } from "./candidates";
import { View2D } from "./view2d";
import { View3D } from "./view3d";
import { MapView, type SiteSelection } from "./mapView";
import { EngineClient } from "../engine/client";
import { gridToData, type AnalysisOut } from "../engine/jobs";
import { deserializeProject, serializeProject } from "../export/json";
import { downloadFile, buildTrackPackage } from "../export/package";
import { trackToSvg } from "../export/svg";
import { trackToCsv } from "../export/csv";
import { trackToGeoJSON } from "../export/geojson";
import { trackToDxf } from "../export/dxf";
import { trackToLandXML } from "../export/landxml";
import { trackToObj, trackMtl } from "../export/obj";
import { trackToBlenderScript } from "../export/blender";
import { trackToOpenDrive } from "../export/opendrive";
import { trackToGlb } from "../export/glb";
import { MORPHABLE_PARAMS, type TrackParams } from "../core/types";
import { hashSeed } from "../core/prng";

export class App {
  private store = new Store();
  private engine = new EngineClient();
  private view2d: View2D;
  private view3d: View3D;
  private mapView: MapView;
  private toolbarRef: { root: HTMLElement; seedInput: HTMLInputElement; setView: (v: ViewMode) => void };
  private sidebarEl: HTMLElement;
  private statusEl: HTMLElement;
  private viewportEl: HTMLElement;
  private stripEl: HTMLElement | null = null;
  private overlayEl: HTMLElement;
  private dirty2d = true;
  private morphQueued: TrackParams | null = null;
  private morphInFlight = false;

  constructor(root: HTMLElement) {
    const shell = el("div", { className: "app-shell" });

    // toolbar
    this.toolbarRef = buildToolbar(this.store.state.seed, this.store.state.view, {
      onGenerate: () => this.generate(),
      onSearch: () => this.search(),
      onBreed: () => this.breed(),
      onSeedChange: (seed) => {
        this.store.set({ seed }, "seed");
        this.generate();
      },
      onRandomSeed: () => {
        const seed = (Math.random() * 0xffffffff) >>> 0;
        this.toolbarRef.seedInput.value = String(seed);
        this.store.set({ seed }, "seed");
        this.generate();
      },
      onView: (view) => this.setView(view),
      onExport: (kind) => void this.export(kind),
      onSave: () => this.save(),
      onLoad: (file) => void this.load(file),
      canBreed: () => this.store.state.candidatesSelected.size >= 2,
    });
    shell.append(this.toolbarRef.root);

    // main
    const main = el("div", { className: "main" });
    this.viewportEl = el("div", { className: "viewport" });
    this.view2d = new View2D(this.viewportEl);
    this.view3d = new View3D(this.viewportEl);
    this.view3d.resize();
    this.mapView = new MapView(this.viewportEl);
    this.mapView.onConfirm = (sel, grid) => this.onSiteConfirm(sel, grid);
    this.mapView.onBusy = (msg, p) => this.setBusy(msg, p);

    this.overlayEl = el("div", { className: "progress-overlay", style: "display:none" });
    this.viewportEl.append(this.overlayEl);

    this.sidebarEl = el("div");
    main.append(this.viewportEl, this.sidebarEl);
    shell.append(main);

    // status bar
    this.statusEl = el("div");
    shell.append(this.statusEl);

    root.append(shell);

    // hover station -> status detail (2D tooltip handles display)
    this.view2d.onStationHover = () => {
      this.dirty2d = true;
    };

    // state subscriptions
    this.store.subscribe((state, changed) => {
      if (
        changed.includes("track") ||
        changed.includes("metrics") ||
        changed.includes("terrain") ||
        changed.includes("heatLayer") ||
        changed.includes("showSectors") ||
        changed.includes("showCorners") ||
        changed.includes("showControlPoints") ||
        changed.includes("showTerrainHeat")
      ) {
        this.dirty2d = true;
        this.view3d.setState(state);
      }
      if (changed.includes("track") || changed.includes("metrics") || changed.includes("validation") || changed.includes("busy")) {
        this.renderStatus();
      }
      if (changed.includes("candidates") || changed.includes("candidatesSelected")) {
        this.renderStrip();
      }
      if (changed.includes("view")) {
        this.applyViewVisibility();
      }
      if (changed.includes("params") || changed.includes("terrain") || changed.includes("history") || changed.includes("historyIndex") || changed.includes("vehicleId")) {
        this.renderSidebar();
      }
    });

    // keyboard
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "g") this.generate();
      if (e.key === "1") this.setView("2d");
      if (e.key === "2") this.setView("3d");
      if (e.key === "3") this.setView("drive");
      if (e.key === "z" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.undo();
      }
      if (e.key === "y" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.redo();
      }
    });

    window.addEventListener("resize", () => {
      this.dirty2d = true;
      this.view3d.resize();
      this.mapView.resize();
    });

    // render loop for 2D
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.dirty2d && this.store.state.view === "2d") {
        this.dirty2d = false;
        this.view2d.render(this.store.state);
      }
    };
    requestAnimationFrame(loop);

    this.renderSidebar();
    this.renderStatus();
    this.applyViewVisibility();

    // initial generation
    void this.generate();
  }

  // ------------------------------------------------------------ views
  private setView(view: ViewMode): void {
    if (view === "drive") {
      this.view3d.driveActive = true;
      this.view3d.driveS = 0;
    } else {
      this.view3d.driveActive = false;
    }
    this.store.set({ view }, "view");
    this.toolbarRef.setView(view);
  }

  private applyViewVisibility(): void {
    const view = this.store.state.view;
    const show2d = view === "2d";
    const show3d = view === "3d" || view === "drive";
    const showMap = view === "map";
    this.view2d.canvas.style.display = show2d ? "block" : "none";
    (this.view3d as unknown as { renderer: { domElement: HTMLElement } }).renderer.domElement.style.display =
      show3d ? "block" : "none";
    const mapContainer = this.viewportEl.querySelector(".map-container") as HTMLElement | null;
    if (mapContainer) mapContainer.style.display = showMap ? "block" : "none";
    const mapControls = this.viewportEl.querySelector(".map-controls") as HTMLElement | null;
    if (mapControls) mapControls.style.display = showMap ? "flex" : "none";
    this.dirty2d = true;
    if (show3d) {
      this.view3d.resize();
      this.view3d.setState(this.store.state);
    }
    if (showMap) this.mapView.resize();
  }

  // ------------------------------------------------------------ busy
  private setBusy(msg: string | null, progress: number | null): void {
    this.store.set({ busy: msg, progress }, "busy");
    if (!msg) {
      this.overlayEl.style.display = "none";
      return;
    }
    this.overlayEl.style.display = "flex";
    this.overlayEl.innerHTML = "";
    this.overlayEl.append(el("div", { textContent: msg }));
    const bar = el("div", { className: "progress-bar" });
    const fill = el("div");
    fill.style.width = `${Math.round((progress ?? 0) * 100)}%`;
    bar.append(fill);
    this.overlayEl.append(bar);
  }

  // ------------------------------------------------------------ actions
  private terrainData() {
    const t = this.store.state.terrain;
    return t ? gridToData(t) : null;
  }

  private adoptAnalysis(out: AnalysisOut, label: string): void {
    this.store.set(
      {
        track: out.track,
        metrics: out.metrics,
        profile: out.profile,
        validation: out.validation,
        params: { ...out.track.params },
        selectedS: null,
      },
      "track",
      "metrics",
      "validation",
      "params",
    );
    this.store.pushHistory(label);
    this.dirty2d = true;
  }

  async generate(): Promise<void> {
    const s = this.store.state;
    this.setBusy(s.terrain ? "GENERATING ON TERRAIN" : "GENERATING", 0.2);
    try {
      const out = await this.engine.run<AnalysisOut | null>(
        "generate",
        {
          seed: s.seed,
          params: s.params,
          vehicleId: s.vehicleId,
          site: s.site,
          terrain: this.terrainData(),
          terrainCandidates: 12,
        },
        (d, t) => this.setBusy("GENERATING", d / t),
      );
      if (out) this.adoptAnalysis(out, `gen ${s.seed.toString(36)}`);
    } catch (e) {
      console.error(e);
    } finally {
      this.setBusy(null, null);
    }
  }

  async search(): Promise<void> {
    const s = this.store.state;
    this.setBusy("SEARCHING CANDIDATES", 0);
    try {
      const out = await this.engine.run<{ candidates: import("../core/search").Candidate[] }>(
        "search",
        {
          seed: s.seed,
          params: s.params,
          vehicleId: s.vehicleId,
          count: 24,
          keep: 6,
          site: s.site,
          terrain: this.terrainData(),
        },
        (d, t) => this.setBusy(`SEARCHING CANDIDATES ${d}/${t}`, d / t),
      );
      this.store.set({ candidates: out.candidates, candidatesSelected: new Set() }, "candidates");
    } catch (e) {
      console.error(e);
    } finally {
      this.setBusy(null, null);
    }
  }

  async breed(): Promise<void> {
    const s = this.store.state;
    const sel = [...s.candidatesSelected];
    if (sel.length < 2) {
      this.setBusy("SELECT 2 CANDIDATES TO BREED (breed? buttons)", null);
      setTimeout(() => this.setBusy(null, null), 1600);
      return;
    }
    const a = s.candidates[sel[0]];
    const b = s.candidates[sel[1]];
    this.setBusy("BREEDING OFFSPRING", 0.4);
    try {
      const out = await this.engine.run<{ offspring: import("../core/search").Candidate[] }>("breed", {
        parentA: a.track,
        parentB: b.track,
        seed: s.seed ^ 0xbeef,
        params: s.params,
        vehicleId: s.vehicleId,
        count: 6,
        mutation: 0.5,
        terrain: this.terrainData(),
      });
      if (out.offspring.length > 0) {
        this.store.set(
          { candidates: out.offspring, candidatesSelected: new Set() },
          "candidates",
        );
      } else {
        this.setBusy("NO VALID OFFSPRING — try different parents", null);
        setTimeout(() => this.setBusy(null, null), 1600);
      }
    } catch (e) {
      console.error(e);
      this.setBusy(null, null);
    }
  }

  onMorphParam(key: keyof TrackParams, value: number): void {
    const params = { ...this.store.state.params, [key]: value };
    this.store.set({ params }, "params");
    const s = this.store.state;
    if (!s.track) return;
    if (!MORPHABLE_PARAMS.has(key)) return;
    this.morphQueued = params;
    void this.pumpMorph();
  }

  private async pumpMorph(): Promise<void> {
    if (this.morphInFlight) return;
    const params = this.morphQueued;
    if (!params) return;
    this.morphQueued = null;
    this.morphInFlight = true;
    try {
      const s = this.store.state;
      const out = await this.engine.run<AnalysisOut | null>("morph", {
        track: s.track,
        params,
        vehicleId: s.vehicleId,
        structural: false,
        terrain: this.terrainData(),
      });
      if (out) {
        this.store.set(
          { track: out.track, metrics: out.metrics, profile: out.profile, validation: out.validation },
          "track",
          "metrics",
          "validation",
        );
        this.dirty2d = true;
      }
    } catch (e) {
      console.error(e);
    } finally {
      this.morphInFlight = false;
      if (this.morphQueued) void this.pumpMorph();
    }
  }

  onStructuralParam(key: keyof TrackParams, value: number | string): void {
    const params = { ...this.store.state.params, [key]: value } as TrackParams;
    this.store.set({ params }, "params");
    const s = this.store.state;
    if (!s.track) return;
    void (async () => {
      this.setBusy("RE-SYNTHESIZING STRUCTURE", 0.4);
      try {
        const out = await this.engine.run<AnalysisOut | null>("morph", {
          track: s.track,
          params,
          vehicleId: s.vehicleId,
          structural: true,
          terrain: this.terrainData(),
        });
        if (out) {
          this.adoptAnalysis(out, `struct ${String(key)}`);
        }
      } finally {
        this.setBusy(null, null);
      }
    })();
  }

  private onVehicle(id: string): void {
    this.store.set({ vehicleId: id }, "vehicleId");
    // recompute analysis with the new vehicle (cheap, main thread)
    const s = this.store.state;
    if (!s.track) return;
    void (async () => {
      const out = await this.engine.run<AnalysisOut | null>("morph", {
        track: s.track,
        params: s.params,
        vehicleId: id,
        structural: false,
        terrain: this.terrainData(),
      });
      if (out) {
        this.store.set(
          { track: out.track, metrics: out.metrics, profile: out.profile, validation: out.validation },
          "track",
          "metrics",
          "validation",
        );
        this.dirty2d = true;
      }
    })();
  }

  private onSiteConfirm(sel: SiteSelection, grid: import("../core/terrain").TerrainGrid): void {
    const site = { lat: sel.lat, lon: sel.lon, radiusMeters: sel.radiusMeters };
    this.store.set({ terrain: grid, site }, "terrain", "site");
    this.setView("2d");
    void this.generate();
  }

  // ------------------------------------------------------------ history
  private undo(): void {
    const s = this.store.state;
    if (s.historyIndex <= 0) return;
    const idx = s.historyIndex - 1;
    const entry = s.history[idx];
    this.store.set(
      { historyIndex: idx, track: entry.track, params: { ...entry.track.params } },
      "historyIndex",
      "track",
      "params",
    );
    this.reanalyzeCurrent();
  }

  private redo(): void {
    const s = this.store.state;
    if (s.historyIndex >= s.history.length - 1) return;
    const idx = s.historyIndex + 1;
    const entry = s.history[idx];
    this.store.set(
      { historyIndex: idx, track: entry.track, params: { ...entry.track.params } },
      "historyIndex",
      "track",
      "params",
    );
    this.reanalyzeCurrent();
  }

  private onHistoryJump(index: number): void {
    const s = this.store.state;
    const entry = s.history[index];
    if (!entry) return;
    this.store.set(
      { historyIndex: index, track: entry.track, params: { ...entry.track.params } },
      "historyIndex",
      "track",
      "params",
    );
    this.reanalyzeCurrent();
  }

  private reanalyzeCurrent(): void {
    const s = this.store.state;
    if (!s.track) return;
    void (async () => {
      const out = await this.engine.run<AnalysisOut | null>("morph", {
        track: s.track!,
        params: s.track!.params,
        vehicleId: s.vehicleId,
        structural: false,
        terrain: this.terrainData(),
      });
      if (out) {
        this.store.set(
          { track: out.track, metrics: out.metrics, profile: out.profile, validation: out.validation },
          "track",
          "metrics",
          "validation",
        );
        this.dirty2d = true;
      }
    })();
  }

  // ------------------------------------------------------------ save/load/export
  private save(): void {
    const t = this.store.state.track;
    if (!t) return;
    downloadFile(`track-seed${t.seed}.track.json`, serializeProject(t), "application/json");
  }

  private async load(file: File): Promise<void> {
    try {
      const text = await file.text();
      const track = deserializeProject(text);
      this.store.set(
        { track, seed: track.seed, params: track.params },
        "track",
        "seed",
        "params",
      );
      this.toolbarRef.seedInput.value = String(track.seed);
      this.reanalyzeCurrent();
      this.store.pushHistory("loaded");
    } catch (e) {
      alert(`could not load project: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async export(kind: string): Promise<void> {
    const s = this.store.state;
    const t = s.track;
    if (!t) return;
    const base = `track-seed${t.seed}`;
    const terrain = s.terrain ?? undefined;
    switch (kind) {
      case "json":
        downloadFile(`${base}.track.json`, serializeProject(t), "application/json");
        break;
      case "svg":
        downloadFile(`${base}.svg`, trackToSvg(t, { drawSectors: true }), "image/svg+xml");
        break;
      case "csv":
        downloadFile(`${base}.csv`, trackToCsv(t), "text/csv");
        break;
      case "geojson":
        downloadFile(`${base}.geojson`, trackToGeoJSON(t), "application/geo+json");
        break;
      case "dxf":
        downloadFile(`${base}.dxf`, trackToDxf(t), "application/dxf");
        break;
      case "landxml":
        downloadFile(`${base}.landxml`, trackToLandXML(t, { terrain }), "application/xml");
        break;
      case "obj":
        downloadFile(`${base}.obj`, trackToObj(t, { terrain }), "text/plain");
        downloadFile(`track.mtl`, trackMtl(), "text/plain");
        break;
      case "blender":
        downloadFile(`${base}_blender.py`, trackToBlenderScript(t, { terrain }), "text/x-python");
        break;
      case "xodr":
        downloadFile(`${base}.xodr`, trackToOpenDrive(t), "application/xml");
        break;
      case "glb": {
        this.setBusy("BUILDING GLB", 0.5);
        try {
          const glb = await trackToGlb(t, terrain);
          downloadFile(`${base}.glb`, glb, "model/gltf-binary");
        } finally {
          this.setBusy(null, null);
        }
        break;
      }
      case "package": {
        this.setBusy("BUILDING PACKAGE", 0.5);
        try {
          const zip = await buildTrackPackage(t, { terrain });
          downloadFile(`${base}-package.zip`, zip, "application/zip");
        } finally {
          this.setBusy(null, null);
        }
        break;
      }
    }
  }

  // ------------------------------------------------------------ rendering
  private renderSidebar(): void {
    const s = this.store.state;
    const elSidebar = buildSidebar(s, {
      onMorphParam: (k, v) => this.onMorphParam(k, v),
      onStructuralParam: (k, v) => this.onStructuralParam(k, v),
      onVehicle: (id) => this.onVehicle(id),
      onDisplay: (patch) => this.store.set(patch, ...Object.keys(patch)),
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
      onHistoryJump: (i) => this.onHistoryJump(i),
    });
    this.sidebarEl.replaceWith(elSidebar);
    this.sidebarEl = elSidebar;
  }

  private renderStatus(): void {
    const bar = buildStatusBar(this.store.state);
    this.statusEl.replaceWith(bar);
    this.statusEl = bar;
  }

  private renderStrip(): void {
    const s = this.store.state;
    if (this.stripEl) {
      this.stripEl.remove();
      this.stripEl = null;
    }
    if (s.candidates.length === 0) return;
    this.stripEl = buildCandidateStrip(s.candidates, s.candidatesSelected, {
      onAdopt: (i) => {
        const c = s.candidates[i];
        this.store.set(
          { track: c.track, metrics: c.metrics, seed: c.track.seed, params: { ...c.track.params } },
          "track",
          "metrics",
          "seed",
          "params",
        );
        this.toolbarRef.seedInput.value = String(c.track.seed);
        this.reanalyzeCurrent();
        this.store.pushHistory(`adopt ${c.label.toLowerCase()}`);
      },
      onToggleSelect: (i) => {
        const next = new Set(s.candidatesSelected);
        if (next.has(i)) next.delete(i);
        else {
          if (next.size >= 2) next.delete([...next][0]);
          next.add(i);
        }
        this.store.set({ candidatesSelected: next }, "candidatesSelected");
      },
    });
    this.viewportEl.append(this.stripEl);
  }
}

export { hashSeed };
