import { describe, expect, it } from "vitest";
import { scaleQuantity } from "../src/agent/tools.js";

describe("scaleQuantity — grocery serving scale", () => {
  it("scales up when planning more servings than the recipe default", () => {
    // recipe serves 2, planning 6 → 3×
    expect(scaleQuantity(200, 6, 2)).toBe(600);
  });

  it("scales down when planning fewer servings", () => {
    expect(scaleQuantity(4, 1, 2)).toBe(2);
  });

  it("rounds to 2 decimals", () => {
    // 1 clove for 2 servings, planning 3 → 1.5
    expect(scaleQuantity(1, 3, 2)).toBe(1.5);
    // 0.25 cup for 4, planning 3 → 0.19 (0.1875 rounded)
    expect(scaleQuantity(0.25, 3, 4)).toBe(0.19);
  });

  it("passes quantity through unchanged when servings info is missing", () => {
    expect(scaleQuantity(3, null, 2)).toBe(3);
    expect(scaleQuantity(3, 6, null)).toBe(3);
    expect(scaleQuantity(3, 6, 0)).toBe(3); // guard against divide-by-zero
  });

  it("keeps null quantity null (e.g. 'a pinch')", () => {
    expect(scaleQuantity(null, 6, 2)).toBeNull();
  });
});
