import { describe, expect, it } from "vitest";

import { loadR2ConfigFromEnv, maxR2PresignExpiresSeconds, r2EndpointForAccount } from "./r2.js";

const requiredR2Env = {
  R2_ACCOUNT_ID: "account-123",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  R2_BUCKET: "question-papers"
};

describe("r2EndpointForAccount", () => {
  it("derives the account endpoint when no custom endpoint is configured", () => {
    expect(r2EndpointForAccount("account-123", undefined)).toBe("https://account-123.r2.cloudflarestorage.com");
    expect(r2EndpointForAccount("account-123", "  ")).toBe("https://account-123.r2.cloudflarestorage.com");
  });

  it("normalizes the copied example placeholder to the account endpoint", () => {
    expect(r2EndpointForAccount("account-123", "https://<account-id>.r2.cloudflarestorage.com")).toBe(
      "https://account-123.r2.cloudflarestorage.com"
    );
  });

  it("preserves a real custom endpoint", () => {
    expect(r2EndpointForAccount("account-123", "https://r2.internal.example")).toBe("https://r2.internal.example");
  });
});

describe("loadR2ConfigFromEnv", () => {
  it("loads defaults that work with a copied env file", () => {
    expect(
      loadR2ConfigFromEnv({
        ...requiredR2Env,
        R2_ENDPOINT: "",
        R2_PRESIGN_EXPIRES_SECONDS: ""
      })
    ).toEqual({
      accountId: "account-123",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      bucket: "question-papers",
      endpoint: "https://account-123.r2.cloudflarestorage.com",
      region: "auto",
      presignExpiresSeconds: 900
    });
  });

  it("loads custom endpoint, region, and presign expiry", () => {
    expect(
      loadR2ConfigFromEnv({
        ...requiredR2Env,
        R2_ENDPOINT: "https://r2.internal.example",
        R2_REGION: "wnam",
        R2_PRESIGN_EXPIRES_SECONDS: "120"
      })
    ).toMatchObject({
      endpoint: "https://r2.internal.example",
      region: "wnam",
      presignExpiresSeconds: 120
    });
  });

  it("accepts the maximum SigV4 presign expiry", () => {
    expect(
      loadR2ConfigFromEnv({
        ...requiredR2Env,
        R2_PRESIGN_EXPIRES_SECONDS: String(maxR2PresignExpiresSeconds)
      })
    ).toMatchObject({
      presignExpiresSeconds: maxR2PresignExpiresSeconds
    });
  });

  it.each(["0", "-1", "1.5", "abc", String(maxR2PresignExpiresSeconds + 1)])(
    "rejects invalid presign expiry %s",
    (presignExpiresSeconds) => {
      expect(() =>
        loadR2ConfigFromEnv({
          ...requiredR2Env,
          R2_PRESIGN_EXPIRES_SECONDS: presignExpiresSeconds
        })
      ).toThrow(`R2_PRESIGN_EXPIRES_SECONDS must be an integer between 1 and ${maxR2PresignExpiresSeconds}`);
    }
  );
});
