# Decisions

Short log of choices made where the brief left room. Newest at the bottom of each section.

## Tooling

- **D1. `@cloudflare/vitest-plugin` instead of `@cloudflare/vitest-pool-workers`.** The
  latter is deprecated and renamed; the plugin is the same project (tests run in workerd
  against a real D1). Vitest is pinned to 4.1.x: plugin 1.4.0 fails to start with Vitest 5.
  Storage is shared by the tests of a file, so `test/setup.ts` empties every table before each test.
- **D2. Biome for lint and format.** One dev dependency instead of ESLint + typescript-eslint
  + Prettier. `noDangerouslySetInnerHtml` is an error.
- **D3. TypeScript 7 (native compiler).** Current stable; typechecks Hono JSX fine.
- **D4. Runtime types from `@cloudflare/workers-types`**, and `wrangler types --include-runtime=false`
  for the small generated `Env` (`worker-configuration.d.ts`, committed). Generating runtime
  types too would commit a 600 KB file.
- **D5. htmx is vendored from the `htmx.org` npm package** (dev dependency, `npm run vendor:htmx`),
  so the version is tracked and updatable, and nothing is loaded from a CDN.
- **D6. Accepted dev-only audit findings.** `npm audit` reports esbuild (via drizzle-kit) and
  sharp (via miniflare). Both are local tooling, never bundled into the Worker.

### Dependencies

| Package | Why |
| --- | --- |
| `hono` | Router + JSX server rendering (brief). |
| `drizzle-orm` | Typed queries and schema (brief). |
| `zod` | Validation of every form and import row (brief). |
| `jose` | Access JWT verification against the team JWKS (brief). |
| dev: `wrangler`, `drizzle-kit`, `typescript`, `vitest`, `@cloudflare/vitest-plugin`, `@cloudflare/workers-types` | Build, migrations, types, tests. |
| dev: `@biomejs/biome` | Lint + format (D2). |
| dev: `htmx.org` | Source of the vendored `htmx.min.js` (D5). |
| `lucide` | Icons (shadcn/ui's default set), rendered as inline SVG on the server (D85). |
| `tailwind-merge` | `cn()`: a caller's classes override a component's defaults, as in shadcn/ui (D86). |
| dev: `tailwindcss`, `@tailwindcss/cli` | Build `public/static/app.css` from `src/styles/app.css` (D81). |

## Data model

- **D10. Whole domain schema in the first migration.** The model is fully specified, so the first
  real deployment gets a stable database; later milestones add migrations only when needed.
- **D11. `moq_milli` and `pack_size_milli`.** The brief names them `moq`/`pack_size`; quantities
  are thousandths everywhere, so the columns say so. CSV columns stay `moq` and `pack_size`.
  `pack_size_milli = 0` means "no pack constraint".
- **D12. `updated_by` on every table** in addition to `created_by`, so the email is stored on
  every write, not only on creation.
- **D13. Timestamps are ISO-8601 UTC text, dates `YYYY-MM-DD` text.** Readable in exports and
  sortable as text.
- **D14. `cost_cents = NULL` means unknown cost.** Zero is a real cost (free parts); unknown
  makes roll-ups incomplete.
- **D15. Free-text columns are `NOT NULL DEFAULT ''`.** Simpler forms and comparisons.
- **D16. `builds.qty_milli`** (default 1 unit) so sub-assemblies can be pre-built in batches.
  A serial-tracked product is built one unit per build (enforced in M4).
- **D17. A build posts its `build_output` move exactly once**, enforced by a partial unique index
  on `stock_moves(ref_type, ref_id) WHERE reason = 'build_output'`. A double submit aborts the
  whole completion batch instead of double-counting.
- **D18. Part refs are case-sensitive, but a ref differing from an existing one only by case is
  rejected** (form and import), to avoid near-duplicates like `abc-1` / `ABC-1`.
  Supplier names are unique case-insensitively (checked in the app).
- **D19. Kind rules.** Only `buy` and `make` parts can be serial-tracked. A part with stock moves
  cannot become a `kit` or a `fee` (they are never stocked).
- **D20. Serial numbers are recorded, not inventoried (v1).** Serials are stored on moves and
  as-built lines and are searchable, but a build does not require the serial to be "in stock".
  The company can start without scanning every receipt.

## BoMs

- **D21. Explosion and cost roll-up run in TypeScript over an in-memory graph** (`src/domain/bom-graph.ts`),
  loaded once per request: easy to unit-test and to extend with per-line choices. Recursive CTEs are used
  where SQL is the natural fit: where-used and the cycle check on save (`src/domain/boms.ts`).
- **D22. Which BoM is used below the top level:** the part's active `std` variant, else its only active
  BoM, else the active BoM with the lowest id. Variants are chosen explicitly only for the top-level BoM
  (e.g. when planning a build).
- **D23. Active BoMs stay editable**, with a warning; archived BoMs are read-only. "New revision" copies the
  lines into a draft; activating it archives the previous active BoM of the same parent and code (one batch).
  Done builds keep their as-built record, so editing a BoM never rewrites history.
- **D24. Cycle checks cover draft and active BoMs** (archived ones are ignored), on every line added, when
  an archived BoM is activated or restored, and on import (whole resulting graph checked in memory).
- **D25. Costs are rolled up in millicents** (cents × 1000) so fractional quantities (0.35 m of cable)
  stay exact to a thousandth of a cent; display rounds half away from zero. A `make`/`kit` part without an
  active BoM falls back to its standard cost; any missing cost marks the result incomplete and names the parts.
- **D26. Exploded quantities round up** to the thousandth (never under-pick).
- **D27. `boms.csv` replaces the lines of each BoM it mentions**, grouped by (parent_ref, code, revision).
  Defaults: code `std`, revision `Rev1`, status `draft`. All rows of a group must share a status; an `active`
  group archives the previous active BoM of the same parent and code.
- **D28. The tree view shows the full structure** (no stock consumption); the exploded list can optionally
  take sub-assemblies from stock, as builds will.

## Stock

- **D50. One count engine** (`planCounts` in `src/domain/stock.ts`) for `stock.csv` and the count screen:
  the counted quantity becomes a `count` move for the difference with on-hand at commit time.
- **D51. Adjustments need a reason** (stored in the move's note) and refuse `kit`/`fee` parts. A serial on a
  serial-tracked part implies a quantity of ±1. Negative on-hand is allowed (the stock list flags it): the
  ledger records reality rather than blocking the shop floor.
- **D52. Every move snapshots `unit_cost_cents`** (standard cost for adjustments and counts, PO price for
  receipts), for later audits. Valuation itself uses current costs: buy parts at standard cost, make parts at
  their BoM roll-up (or standard cost without BoM), with an "as of" date that sums moves up to the end of that
  day (UTC). Missing costs are flagged and make the total understated.
- **D53. JSON backup = every table, in foreign-key order, with ids**, plus the last applied D1 migration.
  Restore is admin-only, shows the row counts first, refuses backups from another schema version, whitelists
  columns against the Drizzle schema, and replaces everything in one D1 batch (deferred foreign keys, multi-row
  inserts sized for D1's 100-parameter limit).

## Builds

- **D60. Pick-list choices and serials are plain form fields** (`choice:<path>`, `serial:<partId>:<n>`),
  like the import preview. Changing a "use stock / build now" choice re-renders the pick list (htmx GET with
  the form's values, or a Recalculate button without JavaScript). Completion never trusts client quantities:
  it re-explodes the build with current stock and the submitted choices, then validates.
- **D61. Completion rules:** every unit of a serial-tracked requirement (buy part, or make part taken from
  stock) needs a non-empty serial, no duplicates; a serial-tracked product needs its own serial and is built
  one unit at a time; a sub-assembly that must be built but has no active BoM blocks completion. The
  "picked" checkboxes are a shop-floor aid, not validated. Consuming below zero is allowed with a warning.
- **D62. One batch, fixed order:** consume moves → output move → as-built lines → status update
  (`WHERE status IN ('planned','in_progress')`). A second completion fails on the unique `build_output`
  index and the whole batch rolls back.
- **D63. The as-built record** has one line per serial for tracked parts (qty 1 each) and one aggregated line
  otherwise. Each line freezes the unit cost at completion; the output move freezes the build's unit cost
  including fees. Sub-assemblies "built now" inside a build are not recorded as lines: their components are.
- **D64. Serial traceability:** a component serial that was itself produced by a build links to that build
  (sub-assembly genealogy); the builds search also matches component serials ("where did LED X go?").
- **D65. Cancelling a build frees its serial** (the unique index ignores cancelled builds — migration 0001).
- **D66. Build numbers** are sequential `B-0001`, computed as max + 1 with one retry on a unique conflict.

## Purchasing

- **D70. Shortages = all planned and in-progress builds**, exploded in planned-date order with one shared
  availability map, so sub-assemblies in stock are allotted once. Only `buy` parts are netted:
  `need − on_hand − on_order`; make parts taken from stock are already covered, and make parts that must be
  built without an active BoM are listed apart. A buy part below zero is short of its deficit even when no
  build needs it.
- **D71. "On order" = remaining quantities of draft, sent and partly received POs.** Counting drafts means
  "create draft POs" can be clicked twice without ordering twice; cancelling a draft brings the shortage back.
- **D72. Draft POs** are created per selected supplier at the part's standard cost, rounded to MOQ and pack
  size, expected date = today + the longest lead time of their lines. Parts without supplier cannot be
  ordered until a supplier is set (`supplier_id` is required on a PO).
- **D73. Receiving** is allowed from draft, sent or partial POs (receiving a draft marks it sent). One batch
  posts the receipt moves at the PO price (one +1 move per serial when serials are entered; their count must
  match the quantity), increments `received_qty_milli` in SQL and recomputes the PO status from its lines.
  Over-delivery is accepted.
- **D74. Short shipments:** a sent or partial PO can be **closed** (status `received`) without moves; its
  remainder stops counting as on order. Cancelling is only possible before anything is received; deleting is
  for draft POs and admins only.
- **D75. Numbers** `PO-0001`… are sequential (max + 1, one retry on a unique conflict).

## CSV import / export

- **D30. Dialects.** Delimiter auto-detected (`,` `;` tab), decimals with `.` or `,`, UTF-8 with
  a fallback to Windows-1252 (Excel on Windows). Exports follow the UI language: French uses `;`
  and decimal commas, English `,` and points. Exports start with a UTF-8 BOM and neutralise cells
  that a spreadsheet would run as formulas.
- **D31. Upsert keeps absent columns.** Only `ref` (parts) / `name` (suppliers) is required in
  the header; columns missing from the file keep their current values. New rows still need
  `name` and `kind`.
- **D32. Unknown supplier in `parts.csv` is a row error**, not an automatic creation: typos would
  otherwise create duplicate suppliers. Import suppliers first.
- **D33. Stateless preview.** The preview page carries the CSV text in a hidden field; the commit
  re-parses and re-validates it against the current database, then writes everything in one D1
  batch. No server-side session or temporary storage.
- **D34. `stock.csv` sets on-hand to the counted quantity** via one `count` move for the
  difference (`ref_type = 'import'`). Serial rows (one per serial, qty 1) are accepted only for
  serial-tracked parts that have no stock yet; afterwards, use adjustments.

## Security & UI

- **D40. CSRF: every non-GET/HEAD/OPTIONS request needs an `Origin` equal to the app's origin.**
  A missing Origin is rejected too (all supported browsers send it on POST).
- **D41. Language:** `DEFAULT_LOCALE` from config, overridable per browser with a cookie set from
  the footer. No Accept-Language sniffing, so a shop-floor tablet behaves predictably.
- **D42. Plain forms + POST-redirect-GET; htmx only where it clearly helps** (live search,
  editors). No `hx-boost`; htmx history cache disabled so back/forward always re-fetches.
- **D43. Deploy config is generated** by `scripts/gen-wrangler-config.mjs`, which forces
  `ENVIRONMENT=production`, an empty `DEV_AUTH_EMAIL`, `workers_dev: false`,
  `preview_urls: false`, and refuses `*.workers.dev` hostnames.
- **D44. Money display** uses the `CURRENCY` var (default EUR) for the symbol; amounts are
  formatted from integers without floating point.

## UI refresh

- **D80. shadcn/ui as the design system, ported to Hono JSX.** The app stays server-rendered with htmx and
  a strict CSP, and every feature works as a plain form. shadcn components are React + Radix: they need
  client-side React and set inline styles, which would mean an SPA and a weaker CSP. Instead,
  `src/views/ui.tsx` ports their anatomy (`data-slot`), variants and Tailwind recipes, read from the
  registry with `npx shadcn@latest view @shadcn/<name>`. The official agent skill is committed in
  `.claude/skills/shadcn` (`npx skills add shadcn/ui`, pinned by `skills-lock.json`) for its rules and
  references; there is deliberately no `components.json` (no React project for `shadcn init`/`add`).
- **D81. Tailwind CSS v4 as a build step.** `@tailwindcss/cli` compiles `src/styles/app.css` (shadcn neutral
  theme in OKLCH, `@theme inline` mapping, base layer) to `public/static/app.css`, still one static file under
  `style-src 'self'`. The output is gitignored and built by `npm run css`, chained in `dev`, `deploy` and
  `check`, run in CI and the deploy workflow, and declared as wrangler's `build` command (rebuilt on change
  during `wrangler dev`). Sources are listed explicitly (`source(none)` + `@source`), so class names must be
  literal. Every page now composes the components; the stylesheet keeps only value-keyed hooks
  (`.num`, `.kind-*`, `.status-*`).
- **D82a. Nested `<details>` chevrons use `[details[open]>summary_&]:rotate-90`**, not `group-open:`, which
  matches any open ancestor (a closed child under an open parent would show as open). Collapsible cards, the
  pick-list choice (radios styled as a segmented control) and the BoM tree all work without JavaScript.
- **D82. Theme and sidebar state are cookies set by plain links.** A client-side theme switch needs an inline
  pre-paint script to avoid a flash of the wrong theme, which the CSP forbids. `/theme/:mode` (system, light,
  dark) and `/sidebar/:state` set a cookie and redirect back to a local path, like `/lang`; the layout renders
  `class="dark"`/`"light"` and `data-sidebar` on `<html>`. "system" sets no class and follows
  `prefers-color-scheme` (the dark tokens are declared for `.dark` and for `:root:not(.light)` in a media
  query). app.js applies the change in place and calls the same URL in the background.
- **D83. Control sizes follow the pointer.** shadcn's dense 36px controls are kept for mouse users; on touch
  screens (`@media (pointer: coarse)`) `--control-h` is 48px, which keeps the tablet-first touch-target rule.
- **D84. Status colours are extra tokens** (`--success`, `--warning`, `--info`, light and dark) next to the
  neutral theme, for part kinds, statuses, stock alerts and the diagram. No raw palette colours in markup.
- **D85. Icons: the vanilla `lucide` package, rendered as inline SVG on the server** and imported by name
  (only the icons in `src/views/icons.tsx` are bundled). Lucide is shadcn's default icon set (ISC licence).
- **D86. `tailwind-merge` at runtime for `cn()`.** A few KB in the Worker, so `<Button class="w-full">` and
  similar overrides behave as in shadcn without hand-ordered class strings.
- **D87. The BoM diagram is server-rendered SVG.** Mermaid or D3 would need client code and inject `<style>`
  elements (CSP). `src/domain/tree-layout.ts` is a pure, unit-tested left-to-right layout (leaves on their own
  rows, parents centred on their children, so boxes never overlap); the SVG is styled with Tailwind
  `fill-*`/`stroke-*` classes and app.js adds zoom, fit and drag-to-pan. Like the tree view it shows the
  structure without stock: a part used in two places appears twice, each with its branch quantity. Depth and
  "sub-assemblies and kits only" are URL parameters, so every view is a link.
- **D88. Global search reuses each list's own filter** (parts, BoMs, builds with component serials, POs,
  suppliers) and includes archived and closed records, with an exact part reference first.
- **D89. The mobile sidebar is a native popover** (`popover="auto"` opened by `popovertarget`): off-canvas
  with a backdrop, light dismiss and Escape, without JavaScript. From the `lg` breakpoint CSS shows the same
  element as a sticky column, collapsible to icons.
