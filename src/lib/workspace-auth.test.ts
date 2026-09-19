import { afterEach, describe, expect, it, vi } from "vitest";
import { isEmailAllowed } from "./workspace-auth";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isEmailAllowed", () => {
  it("closes production when allowlist is empty and open registration is off", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANVIL_ALLOWED_EMAILS", "");
    vi.stubEnv("ANVIL_OPEN_REGISTRATION", "");

    expect(isEmailAllowed("user@example.com")).toBe(false);
  });

  it("opens production empty allowlist only when open registration is explicit", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANVIL_ALLOWED_EMAILS", "");
    vi.stubEnv("ANVIL_OPEN_REGISTRATION", "1");

    expect(isEmailAllowed("user@example.com")).toBe(true);
  });

  it("allows non-production empty allowlist for local development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ANVIL_ALLOWED_EMAILS", "");
    vi.stubEnv("ANVIL_OPEN_REGISTRATION", "");

    expect(isEmailAllowed("user@example.com")).toBe(true);
  });

  it("allows populated allowlist matches", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANVIL_ALLOWED_EMAILS", "alpha@example.com,beta@example.com");
    vi.stubEnv("ANVIL_OPEN_REGISTRATION", "");

    expect(isEmailAllowed("beta@example.com")).toBe(true);
  });

  it("rejects emails outside a populated allowlist", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANVIL_ALLOWED_EMAILS", "alpha@example.com,beta@example.com");
    vi.stubEnv("ANVIL_OPEN_REGISTRATION", "1");

    expect(isEmailAllowed("gamma@example.com")).toBe(false);
  });

  it("matches case-insensitively", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANVIL_ALLOWED_EMAILS", "Alpha@Example.com");

    expect(isEmailAllowed("alpha@example.com")).toBe(true);
    expect(isEmailAllowed("ALPHA@EXAMPLE.COM")).toBe(true);
  });

  it("trims whitespace and quote wrappers in the allowlist and input", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANVIL_ALLOWED_EMAILS", "  'alpha@example.com' , \"beta@example.com\"  ");

    expect(isEmailAllowed(" alpha@example.com ")).toBe(true);
    expect(isEmailAllowed("beta@example.com")).toBe(true);
  });
});
