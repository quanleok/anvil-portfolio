import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("admin auth status route", () => {
  it("rejects requests when the admin token is missing", async () => {
    vi.stubEnv("ANVIL_ADMIN_TOKEN", "");

    const response = await GET(new Request("https://example.test/api/admin/auth-status"));

    expect(response.status).toBe(401);
  });

  it("rejects requests with the wrong admin token", async () => {
    vi.stubEnv("ANVIL_ADMIN_TOKEN", "correct");

    const response = await GET(
      new Request("https://example.test/api/admin/auth-status", {
        headers: { authorization: "Bearer wrong" },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("returns non-PII auth configuration and recent counters with the correct token", async () => {
    vi.stubEnv("ANVIL_ADMIN_TOKEN", "correct");
    vi.stubEnv("ANVIL_ALLOWED_EMAILS", "alpha@example.com,beta@example.com");
    vi.stubEnv("ANVIL_OPEN_REGISTRATION", "");

    const response = await GET(
      new Request("https://example.test/api/admin/auth-status", {
        headers: { authorization: "Bearer correct" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      allowedEmailsConfigured: true,
      allowedEmailsCount: 2,
      openRegistration: false,
      recentSignInStats: {
        last24h: {
          success: expect.any(Number),
          rejected: expect.any(Number),
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("alpha@example.com");
  });
});
