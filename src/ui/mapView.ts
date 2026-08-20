/**
 * Real-world site selection: MapLibre + OpenFreeMap basemap. The user
 * navigates, clicks to drop a site center, drags to size the radius, then
 * confirms -> Mapterhorn DEM is fetched into a TerrainGrid.
 */

import maplibregl, { Map as MLMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { makeLocalFrame, geoDistance } from "../core/geo";
import { fetchMapterhornGrid, type TerrainGrid } from "../core/terrain";
import { el } from "./dom";

export interface SiteSelection {
  lat: number;
  lon: number;
  radiusMeters: number;
}

export class MapView {
  private map: MLMap | null = null;
  private marker: Marker | null = null;
  private panel: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private center: { lat: number; lon: number } | null = null;
  private radiusM = 1800;
  private circleSource = "site-circle";
  onConfirm: ((sel: SiteSelection, grid: TerrainGrid) => void) | null = null;
  onBusy: ((msg: string | null, progress: number | null) => void) | null = null;
  private fetching = false;

  constructor(container: HTMLElement) {
    const mapDiv = el("div", { className: "map-container" });
    // inline styles win against maplibre's own .maplibregl-map rules
    mapDiv.style.position = "absolute";
    mapDiv.style.inset = "0";
    mapDiv.style.width = "100%";
    mapDiv.style.height = "100%";
    container.appendChild(mapDiv);

    this.map = new MLMap({
      container: mapDiv,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [138.9, 35.4], // Fuji-ish mountains of Japan
      zoom: 8.5,
      attributionControl: {},
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    this.map.addControl(new maplibregl.ScaleControl({}), "bottom-left");

    this.map.on("load", () => {
      this.map!.addSource(this.circleSource, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      this.map!.addLayer({
        id: "site-circle-fill",
        type: "fill",
        source: this.circleSource,
        paint: { "fill-color": "#4fc3f7", "fill-opacity": 0.12 },
      });
      this.map!.addLayer({
        id: "site-circle-line",
        type: "line",
        source: this.circleSource,
        paint: { "line-color": "#4fc3f7", "line-width": 2, "line-dasharray": [2, 2] },
      });
    });

    this.map.on("click", (e) => {
      if (this.fetching) return;
      this.center = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      if (!this.marker) {
        this.marker = new Marker({ color: "#4fc3f7" }).setLngLat(e.lngLat).addTo(this.map!);
      } else {
        this.marker.setLngLat(e.lngLat);
      }
      this.updateCircle();
      this.renderPanel();
    });

    // panel
    this.panel = el("div", { className: "map-controls" });
    container.appendChild(this.panel);
    this.statusEl = el("div", { className: "hint" });
    this.renderPanel();
  }

  private renderPanel(): void {
    this.panel.innerHTML = "";
    this.panel.append(
      el("div", { textContent: "SITE SELECTION", className: "hint" }),
      (() => {
        const row = el("div", { className: "ctl" });
        const label = el("label", { textContent: "site radius" });
        const out = el("output", { textContent: `${(this.radiusM / 1000).toFixed(1)} km` });
        const input = el("input", {
          type: "range",
          min: 600,
          max: 4000,
          step: 100,
          value: this.radiusM,
        });
        input.addEventListener("input", () => {
          this.radiusM = Number(input.value);
          out.textContent = `${(this.radiusM / 1000).toFixed(1)} km`;
          this.updateCircle();
        });
        row.append(label, out, input);
        return row;
      })(),
    );
    const confirm = el("button", {
      className: "primary",
      textContent: this.center ? "LOAD TERRAIN + CREATE SITE" : "CLICK MAP TO PLACE CENTER",
    });
    confirm.disabled = !this.center || this.fetching;
    confirm.addEventListener("click", () => void this.confirm());
    this.panel.append(confirm);
    this.panel.append(this.statusEl);
    this.updatePanel();
  }

  private updatePanel(): void {
    if (this.center) {
      this.statusEl.textContent =
        `center ${this.center.lat.toFixed(5)}, ${this.center.lon.toFixed(5)} — ` +
        `radius ${(this.radiusM / 1000).toFixed(1)} km`;
    } else {
      this.statusEl.textContent =
        "Navigate anywhere (e.g. mountainous Japan), click to place the circuit site, then load terrain.";
    }
  }

  private circleGeoJSON(center: { lat: number; lon: number }, radiusM: number): GeoJSON.Feature {
    const steps = 72;
    const coords: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
      const ang = (i / steps) * Math.PI * 2;
      // approximate meters -> degrees
      const dLat = (Math.sin(ang) * radiusM) / 111320;
      const dLon = (Math.cos(ang) * radiusM) / (111320 * Math.cos((center.lat * Math.PI) / 180));
      coords.push([center.lon + dLon, center.lat + dLat]);
    }
    return {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [coords] },
    };
  }

  private updateCircle(): void {
    if (!this.map || !this.center) return;
    const src = this.map.getSource(this.circleSource) as maplibregl.GeoJSONSource | undefined;
    src?.setData(this.circleGeoJSON(this.center, this.radiusM));
  }

  private async confirm(): Promise<void> {
    if (!this.center || this.fetching) return;
    this.fetching = true;
    this.renderPanel();
    this.onBusy?.("LOADING TERRAIN (Mapterhorn DEM)", 0);
    try {
      const frame = makeLocalFrame(this.center);
      const grid = await fetchMapterhornGrid(frame, this.radiusM, 30, (d, t) => {
        this.onBusy?.(`LOADING TERRAIN ${d}/${t} tiles`, d / t);
      });
      this.onBusy?.(null, null);
      this.onConfirm?.({ lat: this.center.lat, lon: this.center.lon, radiusMeters: this.radiusM }, grid);
    } catch (e) {
      this.onBusy?.(null, null);
      this.statusEl.textContent = `terrain load failed: ${e instanceof Error ? e.message : e}`;
    } finally {
      this.fetching = false;
      this.renderPanel();
    }
  }

  /** Programmatic jump (e.g. from a "locate me" or preset). */
  flyTo(lat: number, lon: number, zoom = 11): void {
    this.map?.flyTo({ center: [lon, lat], zoom });
  }

  resize(): void {
    this.map?.resize();
  }
}

export { geoDistance };
