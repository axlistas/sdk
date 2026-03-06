import { describe, it, expect } from "vitest";
import { Enkryptify, EnkryptifyError } from "../src/index.js";

const validConfig = {
  apiKey: "test-api-key",
  workspaceId: "ws-123",
  projectId: "proj-456",
  environment: "development",
};

describe("Enkryptify", () => {
  it("should create an instance with valid config", () => {
    const client = new Enkryptify(validConfig);
    expect(client).toBeInstanceOf(Enkryptify);
  });

  it("should throw on missing apiKey", () => {
    expect(() => new Enkryptify({ ...validConfig, apiKey: "" })).toThrow(EnkryptifyError);
  });

  it("should throw on missing workspaceId", () => {
    expect(() => new Enkryptify({ ...validConfig, workspaceId: "" })).toThrow(EnkryptifyError);
  });

  it("should throw on missing projectId", () => {
    expect(() => new Enkryptify({ ...validConfig, projectId: "" })).toThrow(EnkryptifyError);
  });

  it("should throw on missing environment", () => {
    expect(() => new Enkryptify({ ...validConfig, environment: "" })).toThrow(EnkryptifyError);
  });

  it("should return a string from get()", async () => {
    const client = new Enkryptify(validConfig);
    const value = await client.get("DATABASE_URL");
    expect(typeof value).toBe("string");
    expect(value.length).toBeGreaterThan(0);
  });

  it("should throw when secret is not found", async () => {
    const client = new Enkryptify(validConfig);
    await expect(client.get("NONEXISTENT_KEY")).rejects.toThrow(EnkryptifyError);
  });
});
