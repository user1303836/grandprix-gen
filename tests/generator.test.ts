import { describe, it, expect } from "vitest";
import { generateValidTrack } from "../src/core/generator";
import { validateTrack } from "../src/core/validate";
import { defaultParams } from "../src/core/types";

describe("generator smoke", () => {
  it("generates a valid deterministic track", () => {
    const params = defaultParams();
    const r1 = generateValidTrack(12345, params);
    expect(r1.track).not.toBeNull();
    const t = r1.track!;
    console.log(
      `seed=12345 length=${t.length.toFixed(0)}m corners=${t.corners.length} ` +
        `closureErr=${r1.closureError.toFixed(2)}m attempts=${r1.attempts}`,
    );
    const v = validateTrack(t, params);
    if (!v.valid) console.log("issues:", v.issues);
    expect(v.valid).toBe(true);

    // determinism
    const r2 = generateValidTrack(12345, params);
    expect(r2.track!.samples[100].x).toBe(t.samples[100].x);
    expect(r2.track!.length).toBe(t.length);
  });

  it("generates valid tracks for many seeds (with rejection)", () => {
    const params = defaultParams();
    let ok = 0;
    const fails: string[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      const r = generateValidTrack(seed * 7919, params);
      if (!r.track) {
        fails.push(`seed ${seed * 7919}: build failed ${r.failReason}`);
        continue;
      }
      const v = validateTrack(r.track, params);
      if (v.valid) ok++;
      else fails.push(`seed ${seed * 7919}: ${v.issues.join("; ")} (${r.attempts} attempts)`);
    }
    console.log(`valid: ${ok}/30`);
    if (fails.length) console.log(fails.slice(0, 10).join("\n"));
    expect(ok).toBeGreaterThanOrEqual(28);
  });
});
