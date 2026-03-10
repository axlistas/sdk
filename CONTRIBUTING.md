# Contributing to @enkryptify/sdk

Thank you for your interest in contributing! Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before contributing.

## Development Setup

1. Clone the repository:

    ```bash
    git clone https://github.com/enkryptify/sdk.git
    cd sdk
    ```

2. Install dependencies:

    ```bash
    pnpm install
    ```

3. Verify your setup:

    ```bash
    pnpm check && pnpm lint && pnpm test && pnpm build
    ```

## Development Workflow

- **Build:** `pnpm build`
- **Test:** `pnpm test` (or `pnpm test:watch` for watch mode)
- **Lint:** `pnpm lint` (fix with `pnpm lint:fix`)
- **Format:** `pnpm format` (check with `pnpm format:check`)
- **Typecheck:** `pnpm check`

## Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/). All commit messages are validated by commitlint via a Git hook.

Examples:

- `feat: add batch secret retrieval`
- `fix: handle network timeout gracefully`
- `docs: update API reference`
- `chore: update dependencies`

## Submitting a Pull Request

1. Fork the repository and create your branch from `main`.
2. Make your changes and add tests if applicable.
3. Ensure all checks pass: `pnpm check && pnpm lint && pnpm test && pnpm build`
4. Push your branch and open a pull request against `main`.

## Reporting Issues

Use [GitHub Issues](https://github.com/enkryptify/sdk/issues) to report bugs or request features.
