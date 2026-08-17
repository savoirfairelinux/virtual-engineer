# Virtual Engineer — design-sync notes

## Repo shape

- Full-stack Hono/React app; admin UI lives in `src/admin/ui/`
- UI components are NOT compiled to a distributable — `tsconfig.admin-ui.json` has `"noEmit": true` (required by `"allowImportingTsExtensions": true`)
- No `.d.ts` output → all props declared via `dtsPropsFor` in config
- No pre-built `dist/` → `--entry .design-sync/bundle-entry.tsx` (synth-entry mode)

## Vite-only feature shims

Two source files use `import.meta.glob` which esbuild cannot handle:
- `src/admin/ui/components/Icon.tsx` → shimmed at `.design-sync/shims/Icon.tsx`
- `src/admin/ui/components/ProviderGlyph.tsx` → shimmed at `.design-sync/shims/ProviderGlyph.tsx`

`Stat`, `Drawer`, and `Modal` import `Icon` internally — they also have shims in `.design-sync/shims/` with corrected import paths. If you add a new component that imports `Icon`, check if it needs a shim too.

## CSS entry

`global.css` has `@import "@fontsource/..."` and `@import "./tokens.css"` which are bare module specifiers that don't resolve in the bundle context. Fixed by:
- `cssEntry: ".design-sync/style-entry.css"` — manually merged copy of `global.css` + `tokens.css` with @fontsource imports removed
- `extraFonts: [...]` — @fontsource CSS files processed by the converter to extract @font-face rules and copy woff2 files to `fonts/`

If `tokens.css` or `global.css` change significantly, update `.design-sync/style-entry.css` to match.

## Component grouping

The converter places components based on their source file path relative to `srcDir = src/admin/ui`. Since all components are in `src/admin/ui/components/` and `components` is a generic dir name (in GENERIC_DIR), all components fall into the `general` group. Shim components (in `.design-sync/shims/`) are placed in the `shims` group. This is a cosmetic distinction — the design agent sees both equally.

## Fonts

39 `@font-face` rules from 7 @fontsource CSS files. Both woff and woff2 formats are included (79 font files total). The @fontsource packages cover 5 unicode subsets for IBM Plex Mono and 6 for IBM Plex Sans.

## States and tones

`TONE` palette and `STATES` catalog live in `src/admin/ui/states.ts`. The shim at `.design-sync/shims/states.ts` is a copy with the `"../types.ts"` import corrected to `"./types.ts"`. If states change upstream, update both files.

## GuidedTour (added 2026-08-13)

`src/admin/ui/tour/GuidedTour.tsx` is a spotlight product-tour overlay — esbuild-clean (no `import.meta.glob`), so it's exported directly from `bundle-entry.tsx`, no shim needed. It renders `null` until `enabled` + not-yet-seen (or `restartToken` bumped) AND a real DOM element matches `steps[i].target` via `document.querySelector` — the crash-prevention floor-card props alone can't show anything meaningful, so it's authored (`.design-sync/previews/GuidedTour.tsx`) rather than left on the floor card: each story composes a small mock nav/sidebar with matching `data-tour` targets alongside the component, copied verbatim from the real `MAIN_NAV_TOUR`/`CONFIG_WORKFLOW_TOUR` step data in `src/admin/ui/tour/tourSteps.ts`. `cfg.overrides.GuidedTour` sets `cardMode: "single"` + `primaryStory: "MainNav"` + a fixed `viewport` since it's a full-viewport-dimming overlay, not a normal inline component.

## Icon shim gaps (found + fixed 2026-08-13)

The real `Icon.tsx` derives its path table from every `.svg` in `src/admin/ui/icons/` via `import.meta.glob`; the shim (`.design-sync/shims/Icon.tsx`) hand-copies path data and drifts whenever an icon is added upstream — exactly the risk this file warned about below. Found 3 missing at this sync: `question` (new, used by the tutorial-launcher button in `TopBar.tsx`), plus `eye-off` and `user` (pre-existing gaps — `user` was already used in `GroupsSection`/`UsersSection`/`TopBar` before this sync but never made it into the shim). All 3 added. Icon path list in `shims/Icon.tsx` now covers 36 icons as of 2026-08-13.

Separately, the authored `Icon` preview (`.design-sync/previews/Icon.tsx`) referenced several icon names that never existed in this DS at all (`gear`, `branch`, `commit`, `pr`, `lock`, `robot`, `zap`, `tag`) — they silently rendered as invisible fallback-to-`dot` glyphs, so half the Grid/Tones cells were blank. Not caught by the render check (no error, just an empty path) — only visible by eyeballing the screenshot. Swapped for real names. **If re-authoring any preview that lists icon names by hand, cross-check against `src/admin/ui/icons/*.svg` — a typo'd or stale name fails silently, not loudly.**

## Fork: `.design-sync/overrides/detect.mjs` (added 2026-08-13)

The stock `lib/detect.mjs` walks the whole repo root (depth 4) hunting for `.storybook/` dirs, with no permission guard on `readdirSync`. This repo has `data/openshell-gateway-state/{pki,openshell,.local}` — root-owned, `0700`, real runtime PKI state for a local gateway container — and the walk crashes with `EACCES` the moment it reaches it. Since `cfg.shape` is already pinned to `"package"`, the detection result is discarded anyway; the fork just catches `EACCES`/`EPERM` and skips the unreadable dir instead of throwing. Declared in `cfg.libOverrides`. **If this data directory's permissions or existence ever change, re-check whether the fork is still needed** — but it's a no-op skip on any machine where the walk never hits a permission wall, so it's safe to keep regardless.

## Re-sync risks

- `style-entry.css` is a manual copy — will silently drift if `global.css` or `tokens.css` change
- Shim files (Icon, ProviderGlyph, Stat, Drawer, Modal, states) are manual copies — will drift if originals change
- `dtsPropsFor` in config is hand-written — needs update when component APIs change
- Icon path list in `shims/Icon.tsx` covers 36 icons as of 2026-08-13; new icons added to `src/admin/ui/icons/` won't appear in the shim automatically — and nothing fails loudly when a preview references a name that's missing or never existed, so a periodic eyeball of the Icon card's contact sheet is the only real check
- `states.ts` shim covers 17 TaskState values as of 2026-07-02; new states need to be added to both the shim and the shim's `dtsPropsFor` entry
- Re-copying `.ds-sync/` scripts on any re-sync changes `scriptsSha`, but that field is informational-only in the key recipe (see `lib/sync-hashes.mjs`) — it does NOT itself force a re-verify. What did cascade a full 23-component re-verify this sync was editing `.design-sync/config.json` (new `componentSrcMap`/`dtsPropsFor`/`overrides` entries for `GuidedTour`) and adding the `detect.mjs` fork — both feed the sourceKey's shared `globalSlice`/`componentSlice`, so any config or fork-file edit invalidates every component's grade together, not just the one being changed. Expected, not a bug — but budget for it when editing config.json on a future sync.

## Build command

```
node .ds-sync/package-build.mjs \
  --config .design-sync/config.json \
  --node-modules ./node_modules \
  --entry .design-sync/bundle-entry.tsx \
  --out ./ds-bundle
```
