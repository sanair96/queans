import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiGet } from "../api-client";
import ReviewPage from "./page";

vi.mock("../api-client", () => ({
  apiGet: vi.fn()
}));

vi.stubGlobal("React", React);

const mockedApiGet = vi.mocked(apiGet);

describe("ReviewPage", () => {
  beforeEach(() => {
    mockedApiGet.mockReset();
  });

  it("shows the load error instead of the empty review queue state", async () => {
    mockedApiGet.mockRejectedValue(new Error("API request failed: database unavailable"));

    const html = renderToStaticMarkup(await ReviewPage());

    expect(mockedApiGet).toHaveBeenCalledWith("/api/review/tasks");
    expect(html).toContain("API request failed: database unavailable");
    expect(html).not.toContain("No open review items.");
  });
});
