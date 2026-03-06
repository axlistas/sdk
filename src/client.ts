import type { EnkryptifyConfig, Secret } from "./types.js";
import { EnkryptifyError } from "./errors.js";

export class Enkryptify {
  private config: EnkryptifyConfig;

  constructor(config: EnkryptifyConfig) {
    if (!config.apiKey) {
      throw new EnkryptifyError("apiKey is required");
    }
    if (!config.workspaceId) {
      throw new EnkryptifyError("workspaceId is required");
    }
    if (!config.projectId) {
      throw new EnkryptifyError("projectId is required");
    }
    if (!config.environment) {
      throw new EnkryptifyError("environment is required");
    }

    this.config = config;
  }

  async get(key: string): Promise<string> {
    // TODO: Replace with actual API call
    const secrets = await this.fetchSecrets();
    const secret = secrets.find((s) => s.key === key);

    if (!secret) {
      throw new EnkryptifyError(`Secret "${key}" not found`);
    }

    return secret.value;
  }

  private async fetchSecrets(): Promise<Secret[]> {
    // TODO: Replace with actual API call to Enkryptify
    // Stubbed for now — returns fake data
    void this.config;
    return [
      { key: "DATABASE_URL", value: "postgres://localhost:5432/mydb" },
      { key: "API_KEY", value: "sk-fake-api-key-12345" },
      { key: "JWT_SECRET", value: "super-secret-jwt-value" },
    ];
  }
}

export default Enkryptify;
