/**
 * Central app state with tiny pub/sub. UI components subscribe to the
 * slices they care about; the engine stays UI-agnostic.
 */

import type { CircuitMetrics } from "../core/metrics";
import type { SpeedProfile } from "../core/vehicle";
import type { ValidationReport } from "../core/validate";
import type { SiteRef, Track, TrackParams } from "../core/types";
import type { TerrainGrid } from "../core/terrain";
import type { Candidate } from "../core/search";
import { defaultParams } from "../core/types";

export type ViewMode = "2d" | "3d" | "map" | "drive";
export type HeatLayer =
  | "none"
  | "curvature"
  | "speed"
  | "elevation"
  | "grade"
  | "cutfill"
  | "banking";

export interface HistoryEntry {
  track: Track;
  label: string;
  time: number;
}

export interface AppState {
  view: ViewMode;
  seed: number;
  params: TrackParams;
  track: Track | null;
  metrics: CircuitMetrics | null;
  profile: SpeedProfile | null;
  validation: ValidationReport | null;
  vehicleId: string;
  candidates: Candidate[];
  candidatesSelected: Set<number>;
  terrain: TerrainGrid | null;
  site: SiteRef | null;
  history: HistoryEntry[];
  historyIndex: number;
  heatLayer: HeatLayer;
  showSectors: boolean;
  showCorners: boolean;
  showControlPoints: boolean;
  showTerrainHeat: boolean;
  selectedS: number | null;
  /** Locked section (stations kept when regenerating the rest). */
  lockRange: { sStart: number; sEnd: number } | null;
  busy: string | null;
  progress: number | null;
}

type Listener = (state: AppState, changed: string[]) => void;

export class Store {
  state: AppState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = {
      view: "2d",
      seed: (Math.random() * 0xffffffff) >>> 0,
      params: defaultParams(),
      track: null,
      metrics: null,
      profile: null,
      validation: null,
      vehicleId: "gt3",
      candidates: [],
      candidatesSelected: new Set(),
      terrain: null,
      site: null,
      history: [],
      historyIndex: -1,
      heatLayer: "curvature",
      showSectors: true,
      showCorners: true,
      showControlPoints: false,
      showTerrainHeat: true,
      selectedS: null,
      lockRange: null,
      busy: null,
      progress: null,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<AppState>, ...changed: string[]): void {
    // immutable update: reference identity lets subscribers detect changes
    this.state = { ...this.state, ...patch };
    const keys = changed.length > 0 ? changed : Object.keys(patch);
    for (const fn of this.listeners) fn(this.state, keys);
  }

  /** Push current track onto the undo history. */
  pushHistory(label: string): void {
    const t = this.state.track;
    if (!t) return;
    const hist = this.state.history.slice(0, this.state.historyIndex + 1);
    hist.push({ track: t, label, time: Date.now() });
    if (hist.length > 60) hist.shift();
    this.set({ history: hist, historyIndex: hist.length - 1 }, "history");
  }
}
