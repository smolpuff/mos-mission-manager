## Scope and authorization

- Implement only behavior the user explicitly requests or that is strictly necessary to make that requested behavior work.
- Never invent or add unsolicited features, dialogs, prompts, setup steps, gates, recovery flows, or other user-facing behavior. Ask before adding anything outside the requested scope.
- Internal implementation needs do not authorize new product behavior. In particular, do not add update recovery dialogs or manual recovery workflows unless explicitly requested.
- Preserve existing behavior outside the requested change. When investigating a regression, distinguish verified changes from pre-existing behavior and label hypotheses as unconfirmed.

## Explicit user scope

- Change only the files, behavior, and settings the user explicitly requests. Do not make unsolicited fixes, refactors, cleanups, improvements, or adjacent behavior changes.
- Do not infer authorization to change related functionality. If an additional change outside the explicit request is necessary, explain the specific dependency and obtain the user's explicit approval before making it.
- A request to restore a specific feature applies only to that feature. Do not restore entire files or surrounding handlers, settings, error handling, or other behavior unless the user explicitly requests them.
- For exact restorations, compare the requested feature against the identified historical revision byte for byte and report the comparison. Do not claim that matching historical code proves a runtime bug is fixed.
- Before finishing, inspect the diff and remove any changes made during the task that fall outside the explicit request. Preserve pre-existing user changes.
- Do not build, install, restart, publish, or deploy unless the user explicitly requests that action.

## Desktop update metadata

- Use the repository's `version.json` as the only remote update metadata source, including version, release notes, artifact URLs, and checksums.
- Never create, publish, or request `update.json` or `desktop-update.json` in a release directory or as a release asset.
- Keep intermediate build metadata in the runner's temporary directory, outside release output.
- Preserve the original published Windows EXE naming: `missions-v3-mcp.<version>.exe`. Do not add an architecture or portable suffix.

## Wallet tools

- Wallet creation, import, and recovery-key viewing must work while the runner is stopped. Never start the runner or require missions to run for local wallet operations, including first-time setup.
