import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiGet } from "../api-client";
import BlueprintsPage from "./page";

vi.mock("../api-client", () => ({
  apiGet: vi.fn(),
  apiBaseUrl: "http://localhost:4000"
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() })
}));

vi.stubGlobal("React", React);

const mockedApiGet = vi.mocked(apiGet);

describe("BlueprintsPage", () => {
  beforeEach(() => mockedApiGet.mockReset());

  it("renders the dedicated Blueprint upload desk before the empty state", async () => {
    mockedApiGet.mockResolvedValue({ items: [] });

    const html = renderToStaticMarkup(await BlueprintsPage());

    expect(mockedApiGet).toHaveBeenCalledWith("/api/blueprints?limit=100");
    expect(html).toContain("Add a rules document");
    expect(html).toContain("Drop a Blueprint document here");
    expect(html).toContain("No Blueprint documents yet.");
  });

  it("groups document cards by board while retaining the upload desk", async () => {
    mockedApiGet.mockResolvedValue({
      items: [
        {
          id: "blueprint-1",
          title: "Class X Mathematics",
          originalFilename: "math.pdf",
          board: "CBSE",
          subject: "Mathematics",
          academicLevel: "10",
          primaryLanguage: "en",
          primaryLanguageSource: "INFERRED",
          status: "READY",
          pageCount: 2,
          updatedAt: "2026-07-29T00:00:00.000Z"
        }
      ]
    });

    const html = renderToStaticMarkup(await BlueprintsPage());

    expect(html).toContain("Add a rules document");
    expect(html).toContain("CBSE");
    expect(html).toContain("Class X Mathematics");
    expect(html).toContain("2 pages");
  });
});
