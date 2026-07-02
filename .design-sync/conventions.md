# Virtual Engineer UI — Design Conventions

## Design system overview

Virtual Engineer uses a **dark-first OKLCH token system** with a light-theme override via `[data-theme="light"]`. The palette is cool-neutral (hue 258°) with a purple accent (hue 248°) and semantic state hues for ok/warn/danger/info/muted.

## Token system

All tokens are CSS custom properties on `:root`. Key categories:

| Group | Tokens |
|---|---|
| Accent | `--accent`, `--accent-strong`, `--accent-soft`, `--accent-line` (hue controllable via `--accent-h`) |
| Backgrounds | `--bg`, `--bg-grad`, `--panel`, `--panel-2`, `--panel-3`, `--rail` |
| Borders | `--border`, `--border-soft`, `--border-strong` |
| Text | `--text`, `--text-dim`, `--text-faint`, `--text-ghost` |
| State | `--ok/--ok-soft`, `--warn/--warn-soft`, `--danger/--danger-soft`, `--info/--info-soft`, `--muted-state/--muted-state-soft` |
| Shape | `--radius` (10px), `--radius-sm` (7px), `--radius-lg` (14px), `--ease` |
| Typography | `--font-sans` (IBM Plex Sans), `--font-mono` (IBM Plex Mono) |

State tones map to the `ToneKey` type: `"active" | "ok" | "warn" | "danger" | "info" | "muted"`.

## Typography

- **Body**: IBM Plex Sans, 14px, 1.45 line-height
- **Monospace** (code, commit hashes, branch names): IBM Plex Mono — apply via `.mono` class or `font-family: var(--font-mono)`
- **Eyebrow** labels: use `.eyebrow` class (10.5px, 600, uppercase, letter-spacing)

## Component groups

- **`general/`** — app-level primitives: `Bars`, `Meta`, `RowCard`, `StatePill`, `Tabs`/`TabPanel`, `Tag`, `Toggle`
- **`shims/`** — overlays and form system: `Drawer` (+`DetailSection`, `DetailRow`, `StatusBanner`), `Icon`, `Modal` (+`Field`, `FieldInput`, `FieldSelect`, `FieldTextarea`, `FormError`, `FormRow`, `FormActions`), `ProviderGlyph`, `Stat`

## CSS utility classes

Available globally via `styles.css`:

| Class | Purpose |
|---|---|
| `.btn` / `.btn.primary` / `.btn.danger` / `.btn.sm` | Standard button variants |
| `.iconbtn` | Square icon-only button (30×30px) |
| `.card` | Surface with panel background and soft border |
| `.pill` | Compact label with optional `.dot` |
| `.eyebrow` | Section heading / label text |
| `.mono` | Monospace text |
| `.fade-up` | Entrance animation |
| `.live-dot` | Pulsing status indicator |
| `.metric-val` | Tabular numeral formatting |
| `.modal-scrim` / `.modal` / `.modal-head` / `.modal-body` / `.modal-foot` | Modal layout skeleton |
| `.drawer-scrim` / `.drawer` / `.drawer-head` / `.drawer-body` / `.drawer-foot` | Drawer layout skeleton |
| `.detail-rows` / `.detail-row` / `.detail-key` / `.detail-val` | Key-value detail lists |
| `.pick-card` / `.pick-card.sel` | Selectable option cards |

## State machine

`StatePill` takes a `state` prop from the full `TaskState` union (17 values). States group into:
- **Generation**: `DETECTED → CONTEXT_BUILDING → AGENT_RUNNING → IN_REVIEW → FEEDBACK_PROCESSING → RETRY_CYCLE → MERGED → CLOSING → DONE / FAILED / ABANDONED`
- **Review**: `REVIEW_PENDING → REVIEW_RUNNING → REVIEW_COMMENTING → REVIEW_WATCHING → REVIEW_DONE / REVIEW_FAILED`

## Layout patterns

- **Drawer**: slides from the right; app shell shifts left via `body.ve-drawer-open → .app { padding-right: 460px }`. Use `Drawer` + `DetailSection` + `DetailRow` for entity detail panels.
- **Modal**: centered overlay with backdrop blur; uses `Modal` + `FormRow` + `Field` + form atoms for forms.
- **Stats grid**: `Stat` components in a flex row with `flex: 1` each.
- **Row list**: `RowCard` in a vertical stack for table-like entity lists.
