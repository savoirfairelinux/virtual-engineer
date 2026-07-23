---
applyTo: "src/config.ts"
description: "Keep configuration documentation and copilot-instructions env tables in sync with ConfigSchema."
---
# Keep configuration docs in sync

When editing `src/config.ts`:

1. If a key was added to `ConfigSchema`, add it to the corresponding table in [.github/context/configuration.md](../context/configuration.md) **and** to the **Key Configuration** table in [.github/copilot-instructions.md](../copilot-instructions.md).
2. If a `superRefine` rule was added/removed/changed, update the conditional-required notes in `configuration.md`.
3. If a default value changed, update both files.
4. If `fromEnv()` mappings changed, the new env var name(s) must appear in `configuration.md`.
5. Empty-string-as-undefined preprocessing is documented; preserve that note unless the behaviour actually changes.
