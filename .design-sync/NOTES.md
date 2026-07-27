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

## Re-sync risks

- `style-entry.css` is a manual copy — will silently drift if `global.css` or `tokens.css` change
- Shim files (Icon, ProviderGlyph, Stat, Drawer, Modal, states) are manual copies — will drift if originals change
- `dtsPropsFor` in config is hand-written — needs update when component APIs change
- Icon path list in `shims/Icon.tsx` covers 33 icons as of 2026-07-02; new icons added to `src/admin/ui/icons/` won't appear in the shim automatically
- `states.ts` shim covers 17 TaskState values as of 2026-07-02; new states need to be added to both the shim and the shim's `dtsPropsFor` entry

## Build command

```
node .ds-sync/package-build.mjs \
  --config .design-sync/config.json \
  --node-modules ./node_modules \
  --entry .design-sync/bundle-entry.tsx \
  --out ./ds-bundle
```
