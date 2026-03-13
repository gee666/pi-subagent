# AGENTS.md

Simple guidance for coding agents working in this repository.

## Repository setup

- Requirements: Node.js + npm
- Install dependencies:

```bash
npm install
```

- Check what would be published:

```bash
npm pack --dry-run
npm publish --dry-run --access public
```

## Local validation

- This package is a Pi extension (entry point: `index.ts`).
- Quick manual check with local package:

```bash
pi -e .
```


## Commit format (important)

Use the repository's existing style:

- Imperative mood
- Sentence case
- No prefix like `feat:` / `fix:` / `chore:`

Examples:

- `Add depth-limited subagent delegation`
- `Scope npm package name`
- `Add npm install option to README`

Keep commits focused (one logical change per commit).


