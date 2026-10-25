# Repository instructions

## Repository synchronization

- Before starting any work, pull the latest changes from `origin` with `git pull --ff-only`. Preserve local edits; stop and resolve safely if the pull is blocked.
- After each completed, validated piece of work, commit your changes and push to `origin` immediately. Work happens on multiple machines; do not leave finished work unsynchronized.

## Pi compatibility and releases

- Test only against the latest npm Pi release. Do not maintain an older-version test matrix or claim compatibility with an untested minimum.
- Before each release, run `npm test`. Its `pretest` hook installs every directly used Pi SDK package at `@latest` with `--save-dev --ignore-scripts`, then runs `npm run typecheck`. Keep typechecking independent of tests so the hooks cannot recurse.
- After the checks pass, keep one standalone README line in exactly this form: `Tested against Pi <actual version>`. Replace the placeholder with the installed, successfully tested `@earendil-works/pi-coding-agent` version. Update it on every release; never claim a failed run as tested.
- Keep the Pi `peerDependencies` ranges in `package.json` aligned with the README's supported Pi baseline. The current tested baseline must be at least `>=1.4.0`, not an untested `>=1.0.0`. Update the Pi development dependencies and lockfile together.
- Run all available repository checks before committing or releasing. If any fail, report the failure and do not publish.

## Code quality bar

Apply this to all new or rewritten code. Review correctness and these requirements:

- Delete unused, unreachable and half-wired code, or wire it in properly. Do not keep code "just in case".
- Keep clear TypeScript/Node boundaries between extension registration, agent execution, persistence, protocol validation and UI. Put behavior in its owning layer, not in configuration or entry points.
- Use the simplest solution that fixes the root cause. Do not hide bugs with sleeps, blind retries, catch-all handlers or compiler suppression.
- Extract genuinely shared behavior instead of copying it to change a few lines. Explain intentional duplication briefly.
- Follow existing repository patterns. Discuss a new dependency, architecture or coding style before introducing it.
- Keep configurable URLs, model names, thresholds and prompts in the repository's typed settings or environment handling. Name fixed protocol constants. Never commit secrets or expose credentials in logs, fixtures or docs.
- Use strict, meaningful types. Validate untrusted JSON, files, environment values and process messages at runtime. No `any`, unsafe casts, `@ts-ignore`, `@ts-expect-error` or non-null assertions to avoid a real check.
- Keep files focused and under 350 lines. Functions and classes should do one job. Exceed the limit only when the code is genuinely cohesive and splitting it would hurt; document the reason in the change review.
- Keep comments and docs short, accurate and human-readable. Explain why when it is not obvious. Remove stale or redundant text and comment changelogs. Use the `unslop` and `write-prompts` skills when available for docs and prompts.
- Add focused regression tests for changed behavior. Run tests, typechecking, formatting and any lint/build/package checks available in `package.json`. Keep those checks warning-free; do not add a lint tool solely to satisfy this instruction.
