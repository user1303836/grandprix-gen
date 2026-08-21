/**
 * Top toolbar: brand, seed control, generate/search/breed actions, view
 * tabs, export menu.
 */

import { el } from "./dom";
import type { ViewMode } from "./state";

export interface ToolbarCallbacks {
  onGenerate: () => void;
  onSearch: () => void;
  onBreed: () => void;
  onSeedChange: (seed: number) => void;
  onRandomSeed: () => void;
  onView: (view: ViewMode) => void;
  onExport: (kind: string) => void;
  onSave: () => void;
  onLoad: (file: File) => void;
  canBreed: () => boolean;
  onCinema: () => void;
  onCapture: () => void;
}

const EXPORT_ITEMS: [string, string, string][] = [
  ["head", "PROJECT", ""],
  ["json", ".track.json (lossless project)", ""],
  ["head", "2D / CAD", ""],
  ["svg", "SVG plan", ""],
  ["csv", "CSV engineering data", ""],
  ["geojson", "GeoJSON (georeferenced)", ""],
  ["dxf", "DXF (CAD layers)", ""],
  ["landxml", "LandXML (Civil 3D)", ""],
  ["head", "3D", ""],
  ["glb", "glTF / GLB scene", ""],
  ["obj", "OBJ mesh", ""],
  ["blender", "Blender reconstruction (.py)", ""],
  ["head", "SIMULATION", ""],
  ["xodr", "OpenDRIVE (.xodr)", ""],
  ["head", "EVERYTHING", ""],
  ["package", "Complete track package (.zip)", ""],
];

export function buildToolbar(
  initialSeed: number,
  view: ViewMode,
  cb: ToolbarCallbacks,
): { root: HTMLElement; seedInput: HTMLInputElement; setView: (v: ViewMode) => void } {
  const bar = el("div", { className: "toolbar" });
  bar.append(el("span", { className: "brand", textContent: "GRANDPRIX-GEN" }));

  // seed
  const seedInput = el("input", { type: "text", value: String(initialSeed), spellcheck: false });
  seedInput.title = "seed — same seed + params + version reproduces the same circuit";
  seedInput.addEventListener("change", () => {
    const v = Number(seedInput.value.replace(/[^0-9]/g, ""));
    if (Number.isFinite(v) && v > 0) cb.onSeedChange(v >>> 0);
  });
  const dice = el("button", { textContent: "⚄", title: "random seed" });
  dice.addEventListener("click", cb.onRandomSeed);
  bar.append(el("div", { className: "seed-box" }, [el("span", { textContent: "seed" }), seedInput, dice]));

  bar.append(el("div", { className: "sep" }));

  const gen = el("button", { className: "primary", textContent: "GENERATE" });
  gen.title = "generate a new circuit from this seed";
  gen.addEventListener("click", cb.onGenerate);
  const search = el("button", { textContent: "SEARCH ×24" });
  search.title = "generate 24 candidates, keep a diverse best set";
  search.addEventListener("click", cb.onSearch);
  const breed = el("button", { textContent: "BREED" });
  breed.title = "select 2 candidates below, then breed them";
  breed.addEventListener("click", cb.onBreed);
  bar.append(gen, search, breed);

  bar.append(el("div", { className: "sep" }));

  // view tabs
  const tabs = el("div", { className: "view-tabs" });
  const views: [ViewMode, string][] = [
    ["2d", "2D"],
    ["3d", "3D"],
    ["drive", "DRIVE"],
    ["map", "SITE MAP"],
  ];
  const tabButtons = new Map<ViewMode, HTMLButtonElement>();
  for (const [v, name] of views) {
    const b = el("button", { textContent: name });
    if (v === view) b.classList.add("active");
    b.addEventListener("click", () => cb.onView(v));
    tabButtons.set(v, b);
    tabs.append(b);
  }
  bar.append(tabs);

  // cinema orbit + screenshot capture
  const cinemaBtn = el("button", { textContent: "CINEMA", title: "cinematic auto-orbit" });
  cinemaBtn.addEventListener("click", () => {
    cb.onCinema();
    cinemaBtn.classList.toggle("active");
  });
  const captureBtn = el("button", { textContent: "\u{1F4F7}", title: "save PNG of the current view" });
  captureBtn.addEventListener("click", () => cb.onCapture());
  bar.append(cinemaBtn, captureBtn);

  // spacer
  bar.append(el("div", { style: "flex:1" }));

  // save / load
  const save = el("button", { textContent: "SAVE" });
  save.addEventListener("click", cb.onSave);
  const loadLabel = el("label", { style: "display:inline-block" });
  const loadBtn = el("button", { textContent: "OPEN" });
  const fileInput = el("input", { type: "file", accept: ".json,.track.json", style: "display:none" });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) cb.onLoad(f);
    fileInput.value = "";
  });
  loadBtn.addEventListener("click", () => fileInput.click());
  loadLabel.append(loadBtn, fileInput);
  bar.append(save, loadLabel);

  // export menu
  const menuWrap = el("div", { className: "menu-wrap" });
  const exportBtn = el("button", { textContent: "EXPORT ▾" });
  const menu = el("div", { className: "menu", style: "display:none" });
  for (const [id, label] of EXPORT_ITEMS) {
    if (id === "head") {
      menu.append(el("div", { className: "menu-head", textContent: label }));
      continue;
    }
    const item = el("button", { textContent: label });
    item.addEventListener("click", () => {
      menu.style.display = "none";
      cb.onExport(id);
    });
    menu.append(item);
  }
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === "none" ? "block" : "none";
  });
  document.addEventListener("click", () => (menu.style.display = "none"));
  menuWrap.append(exportBtn, menu);
  bar.append(menuWrap);

  return {
    root: bar,
    seedInput,
    setView: (v: ViewMode) => {
      for (const [key, b] of tabButtons) b.classList.toggle("active", key === v);
    },
  };
}
