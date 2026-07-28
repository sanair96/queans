import { describe, expect, it } from "vitest";

import { isBlueprintJsonValue } from "./blueprint-json-editor";

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
