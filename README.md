# @enkryptify/sdk

[![CI](https://github.com/enkryptify/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/enkryptify/sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@enkryptify/sdk)](https://www.npmjs.com/package/@enkryptify/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Official TypeScript SDK for [Enkryptify](https://enkryptify.com) — fetch and manage secrets from the Enkryptify API.

## Installation

```bash
pnpm add @enkryptify/sdk
```

```bash
npm install @enkryptify/sdk
```

```bash
yarn add @enkryptify/sdk
```

## Usage

```typescript
import Enkryptify from "@enkryptify/sdk";

const client = new Enkryptify({
  apiKey: "your-api-key",
  workspaceId: "your-workspace-id",
  projectId: "your-project-id",
  environment: "production",
});

const dbUrl = await client.get("DATABASE_URL");
console.log(dbUrl);
```

## API Reference

### `new Enkryptify(config)`

Creates a new Enkryptify client.

| Parameter     | Type     | Description                           |
| ------------- | -------- | ------------------------------------- |
| `apiKey`      | `string` | Your Enkryptify API key               |
| `workspaceId` | `string` | The workspace ID                      |
| `projectId`   | `string` | The project ID                        |
| `environment` | `string` | The environment (e.g. `"production"`) |

### `client.get(key): Promise<string>`

Fetches a secret by key. Throws `EnkryptifyError` if the secret is not found.

### `EnkryptifyError`

Custom error class for all SDK errors.

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Lint
pnpm lint

# Format
pnpm format

# Typecheck
pnpm check
```

## Contributing

Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a pull request.

## License

[MIT](LICENSE)
