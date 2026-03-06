export interface EnkryptifyConfig {
  apiKey: string;
  workspaceId: string;
  projectId: string;
  environment: string;
}

export interface Secret {
  key: string;
  value: string;
}
