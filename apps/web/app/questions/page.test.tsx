import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiGet } from "../api-client";
import QuestionsPage from "./page";

vi.mock("../api-client", () => ({
  apiGet: vi.fn()
}));

vi.stubGlobal("React", React);

const mockedApiGet = vi.mocked(apiGet);

describe("QuestionsPage", () => {
  beforeEach(() => {
    mockedApiGet.mockReset();
  });

  it("shows the load error instead of the empty question-bank state", async () => {
    mockedApiGet.mockRejectedValue(new Error("API request failed: database unavailable"));

    const html = renderToStaticMarkup(await QuestionsPage());

    expect(mockedApiGet).toHaveBeenCalledWith("/api/questions");
    expect(html).toContain("API request failed: database unavailable");
    expect(html).not.toContain("No approved questions yet.");
  });
});
