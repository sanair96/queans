import { describe, expect, it } from "vitest";

import { normalizeTaxonomyName } from "./taxonomy.js";

describe("normalizeTaxonomyName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeTaxonomyName("  Linear   Equations  ")).toBe("Linear Equations");
  });

  it("drops blank taxonomy names", () => {
    expect(normalizeTaxonomyName("   ")).toBeUndefined();
    expect(normalizeTaxonomyName(undefined)).toBeUndefined();
  });
});
