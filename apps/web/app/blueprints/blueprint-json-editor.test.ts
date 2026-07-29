import { describe, expect, it } from "vitest";

import { blueprintRuleSections, isBlueprintJsonValue } from "./blueprint-json-editor";

describe("isBlueprintJsonValue", () => {
  it.each([null, true, false, 42, "rule", [], {}, { sections: [{ title: "भाग अ", marks: 10 }, null] }])(
    "accepts valid JSON value %#",
    (value) => {
      expect(isBlueprintJsonValue(value)).toBe(true);
    }
  );

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(), () => "rule"])(
    "rejects a non-JSON value %#",
    (value) => {
      expect(isBlueprintJsonValue(value)).toBe(false);
    }
  );
});

describe("blueprintRuleSections", () => {
  it("turns top-level extracted object fields into focused editor sections", () => {
    expect(
      blueprintRuleSections({
        instructions: ["Answer all questions"],
        confidence: 0.98,
        source_references: []
      })
    ).toEqual([
      { id: "instructions", label: "instructions" },
      { id: "confidence", label: "confidence" },
      { id: "source_references", label: "source_references" }
    ]);
  });

  it("keeps primitive and empty extracted documents in one readable root section", () => {
    expect(blueprintRuleSections("निर्देश")).toEqual([{ id: "__root__", label: "Blueprint rules" }]);
    expect(blueprintRuleSections({})).toEqual([{ id: "__root__", label: "Blueprint rules" }]);
  });
});
