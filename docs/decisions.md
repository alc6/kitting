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
| `@cloudflare/workers-oauth-provider` | OAuth 2.1 server for the MCP endpoint: client registration, PKCE, tokens, refresh, revocation, discovery metadata, grants in KV with hashed tokens and encrypted props (D115). Cloudflare's library, MIT. |
| `@modelcontextprotocol/server` | The official MCP TypeScript SDK (v2 server package): protocol, tool schemas from zod, a stateless HTTP handler for both protocol revisions (D115). Apache-2.0; depends only on zod and its own core package. |

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
  registry with `npx shadcn@latest view @shadcn/<name>`. The official agent skill is not committed (third-party
  content): contributors install it with `npx skills add shadcn/ui` into the gitignored `.claude/skills/shadcn`,
  and `skills-lock.json` records the version used; there is deliberately no `components.json` (no React project for `shadcn init`/`add`).
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

## Pricing

- **D90. Several suppliers per part, one preferred.** Offers live in `part_suppliers` (one row per part and
  supplier: reference, price, MOQ, pack size, lead time, notes). The preferred supplier is still
  `parts.supplier_id`: a pointer, so "exactly one preferred" needs no flag or partial index. The old
  `parts.supplier_ref`, `moq_milli`, `pack_size_milli` and `lead_days` columns are deprecated, never read or
  written: dropping them would rebuild `parts` (a CHECK constraint covers them) under four child tables on
  the live D1, which an additive migration avoids. Migration 0002 copies them into one offer per part.
  An offer price can be unknown: PO lines then use the standard cost, so nothing changes until supplier
  prices are entered. `parts.csv` keeps its supplier columns, meaning the preferred offer;
  `part_suppliers.csv` loads the others.
- **D91. Valuation shows two methods side by side; the company has not chosen one.** *Standard*: on-hand ×
  the standard cost valid on the "as of" date (make parts at their roll-up with today's BoM structure).
  *Weighted average* (PMP): a pure replay of the ledger (`src/domain/costing.ts`) with a running quantity
  and value per part in integer millicents (no rounded average carried over). Receipts enter at the PO
  price and reset the average on empty or negative stock; build outputs enter at the average value of what
  the build consumed plus its fees (recorded output value − recorded consumption, so no schema change);
  other entries at the current average, else the move's recorded cost, else the standard cost. Each method
  flags its own incomplete rows. Old backups no longer restore after migration 0002 (D53).
- **D92. Price history is an append-only log** (`price_history`), written in the same batch as every change
  of a standard cost, an offer price or a selling price (from a form or an import), never updated or
  deleted. Prices actually paid are not copied: they are the receipt moves (at the PO price). The `po`
  source is reserved for a future hook that would update an offer from a receipt (not done: offers change
  only when someone edits or imports them). Before migration 0002
  nothing was recorded, so each cost's history starts with a seed row dated from the part's last update; an
  "as of" date before it falls back to that first value, and the valuation page says so.
- **D93. Selling prices: one per product, optionally overridden per BoM variant**
  (`parts.sale_price_cents`, `boms.sale_price_cents`; `boms.csv` gains an optional `sale_price` column, one
  value per BoM). Prices exclude VAT. Margins are shown as an amount, as a rate on the selling price
  (*taux de marque*) and as a markup on cost (*taux de marge*), in integer basis points. Planned margin uses
  the standard cost roll-up; actual margin uses completed builds valued at weighted average cost.
- **D94. Ordering from another supplier is a per-line choice on the shortage list.** Lines stay grouped by
  preferred supplier; a line moved to another supplier is re-rounded to that supplier's MOQ and pack size
  and priced at its offer, and lands on that supplier's draft PO. Manual PO lines default to the PO
  supplier's offer price, else the standard cost.
- **D95. Margins page.** "Low margin" means a rate on the selling price under 30 % (`LOW_MARGIN_BP`), a
  starting point to adjust with the company. The stat cards always count every sellable item; the filter
  (planned only = no completed build yet, built = at least one) narrows the table and its CSV. CSV
  percentages are plain numbers with one decimal (no `%`), for spreadsheets. A build's actual cost is
  flagged incomplete when it consumed units whose cost is unknown (they stay "tainted" in the average until
  the stock is used up or a priced receipt resets it).
- **D96. Valuation CSV names both methods.** Columns `standard_unit_cost`, `standard_value`,
  `standard_incomplete` (formerly `unit_cost`, `value`, `incomplete`, same positions) are followed by
  `average_unit_cost`, `average_value`, `average_incomplete`; the dashboard card says "at standard cost" and
  shows the weighted average as its hint. On the shortage list, lines without a preferred supplier can now
  be ordered once a supplier is chosen for them.
- **D97. Part page pricing.** The Purchasing card gave way to a Suppliers card (one row per offer, with the
  last price paid) and a Prices card (standard, planned and weighted average costs, selling price, planned
  margin); the preferred supplier's contact moved to Details. Offers are only for stocked parts (buy, make).
  Unticking "preferred" never leaves a part without one: switch by making another supplier preferred.
  "Use average as standard cost" (refused while the average is incomplete) and "Use preferred offer price
  as standard cost" write the history with a note in the user's language. The price chart is server-rendered
  SVG: standard cost as a step line, prices paid as dots.
- **D98. Margin history is derived, never stored.** Each sellable item (`/margins/boms/:id`,
  `/margins/parts/:id`) replays the price history (`src/domain/margin-history.ts`, pure core): one planned
  point per day on which the standard cost of a component of its roll-up (buy and fee parts, make and kit
  parts without an active BoM; a rolled-up sub-assembly's own standard cost does not count) or its selling
  price changed, skipping days that did not move it (e.g. the part's price while a variant has its own).
  Same limits as the dated valuation (D91, D92): today's BoM structure, and costs before the history
  started use their first recorded value (flagged). Actual points are the completed builds at weighted
  average cost against the selling price valid on the day each was completed: there is no sales record.
  Snapshots were rejected: they would duplicate data the log already holds and drift from it. The chart
  is the price chart's step-line component, moved to `src/views/chart.tsx`.
- **D99. A supplier price can become the standard cost, on request.** Planned costs and margins follow the
  standard cost, not offer prices (D93), so a supplier going from 2.00 to 4.00 moves nothing until someone
  updates the standard cost. The offer form gains an unticked "Also use this price as the standard cost"
  and `part_suppliers.csv` an optional `set_standard_cost` column (one row per part at most; it needs a
  price). Off by default: the standard cost stays a deliberate choice (it may include freight, or be set
  yearly), and the change is one tick away. Both write the standard cost history with the offer's
  supplier as the note.

## Product images

- **D100. One image per part, in an optional R2 bucket.** D1 was ruled out on its limits: rows and BLOBs
  are capped at 2 MB, BLOBs come back as arrays of numbers, and the JSON backup is built in memory, so
  images would make backups fragile as the catalogue grows. The `IMAGES` binding is optional
  (`imagesBucket(env)`): existing deployments keep working untouched, the deploy workflow adds the binding
  only when `IMAGES_BUCKET` is set, and without it the UI hides image controls (admins see a hint).
  `parts.image_key` (migration 0003, additive) holds a content-addressed key
  (`parts/<id>/<sha256 prefix>.<ext>`), so `/parts/:id/image?v=<hash>` is cached privately for a year and
  a replaced image never shows stale. The object is written before the pointer; the previous object is
  deleted after it. Uploads are typed from their magic bytes: JPEG, PNG or WebP only (no SVG, which could
  carry script; no HEIC, which browsers do not display), at most 10 MB. With JavaScript, `app.js` shrinks
  photos to 1600 px (WebP, else JPEG on white) before upload; without it the server limit applies. Anyone
  can upload or replace (like editing a part); removing is admin-only. The JSON backup holds the keys, not
  the images (README); an image replaced after a backup is lost to that backup. The pages' security
  middleware keeps `Cache-Control: no-store` unless a handler set its own. The parts search now matches any
  supplier's reference on the offers (it still read the deprecated `parts.supplier_ref`, D90).

## Roles

- **D101. Four roles, decided by the app; Cloudflare Access only says who the user is.** `viewer` <
  `operator` < `planner` < `admin`, each able to do what the previous one can (`atLeast()` in
  `src/domain/users.ts`). Operators run the shop floor (builds, stock adjustments and counts, receiving POs);
  planners also edit the catalogue, BoMs, suppliers, offers, prices and POs and use Import / Export; admins
  also confirm imports, delete, archive, restore and manage users. Roles live in a `users` table (migration
  0004, additive, with `settings`), edited by admins at `/users`. Resolution order: `ADMIN_EMAILS` (always
  admin, cannot be demoted from the UI, so there is no "last admin" to protect and no lock-out), then the
  `users` row, else **viewer**: Access stays the only list of who may enter, and admins only promote people.
  Groups from the identity provider were ruled out: one-time PIN has none, and a small team does not need
  them. The role and the cost option are read in one query per request, after the database is set up.
- **D102. One default-deny access policy** *(replaced by D105)* (`accessPolicy` in `src/middleware/roles.tsx`) instead of a guard
  on each of the ~56 write routes: any write needs a planner unless its path is in `OPERATOR_WRITES`, and
  viewers never write, so a POST route added later is closed to operators until listed. Read rules close
  `/users` (admin), `/import/backup.json` (admin), the rest of `/import` (planner), the cost pages (D103)
  and the form pages (`/parts/new`, `/builds/new`, `/stock/adjust`…) to roles that could not submit them.
  `requireAdmin` stays on destructive routes. Pages hide the controls a role cannot use (`atLeast(role, …)`).
  Uploading a part image is now a planner action (editing a part), no longer anyone's (D100).
- **D103. Cost visibility is one admin switch, off by default.** Planners and admins always see costs (they
  edit prices and orders). Viewers and operators see them only when an admin ticks "Viewers and operators
  see costs" on `/users` (`settings.lower_roles_see_costs`); a per-user flag was not needed. Without it,
  pages drop cost columns, cards and sections (the stock value card, offer prices, price history, BoM and
  build costs, PO prices: an operator receives a PO without seeing them); `Money` and `CostView` render
  "Hidden" as a backstop; the moves and BoM explosion CSVs lose their cost columns; margins, valuation and
  the PO CSV are refused. `test/costs-hidden.test.ts` seeds distinctive amounts and checks every page and
  CSV an operator or a viewer can open; it was checked to fail when costs are forced visible.
- **D104. The JSON backup is admin-only** (it was open to any signed-in user, and is the whole database).
  `users` and `settings` are part of it: a restore brings roles back, `ADMIN_EMAILS` still apply. As with
  every migration, backups taken before 0004 are refused (D53).
- **D105. Permissions are named actions, so an API can reuse them** (planned: an MCP server whose OAuth
  scopes map to these names). `src/domain/permissions.ts` holds one table, `area.verb` → least role
  (`parts.edit`, `stock.adjust`, `purchasing.receive`, `costs.view`, `import.commit`, `users.manage`…), and
  `can({ role, seeCosts }, action)` works without HTTP. It replaces D102's path rules (`OPERATOR_WRITES`,
  `READ_RULES`, `requireAdmin`) and every role comparison in pages. The URL → action mapping is declared on
  the route (`requirePermission(action)`) rather than in a second, central path table: the declaration sits
  next to the handler, and `createApp()` refuses to start if a write route has none (Hono lists route
  middleware in `app.routes`), which replaces D102's role floor with a stronger net. Read-only gates are
  router-level (`/margins`, `/import`, `/users`) or route-level (valuation, PO export, form pages); the
  cost sweep (D103) guards them. `costs.view` keeps the admin option: its `min` is planner and lower roles
  get it when allowed; `seeCosts` is that check, computed once per request. Redaction is shared:
  `csvResponse` drops `MONEY_COLUMNS` from every CSV, and `redactCosts()` nulls amounts (`*Cents`,
  `*Millicents`, `rateBp`) in structured data for a future API. Pages are not run through `redactCosts`:
  they drop cost columns at render time, with `Money`/`CostView` as the backstop and the sweep as the proof.
  `test/permissions.test.ts` runs one request per action: refused just below its role, allowed from it.
  Images: the "not set up" hint now shows to whoever may edit parts, rather than to admins only (D100).

## History and undo

- **D106. Every change is a change set, recorded by SQLite triggers.** `change_sets` (who, when, source `ui` /
  `import` / `mcp` / `revert` / `migration`, MCP client name, summary, revertible, the change set an undo
  reverts) and `change_log` (table, row id, `insert` / `update` / `delete`, the full row before and after as
  JSON) are append-only once committed (migration 0005). `AFTER INSERT/UPDATE/DELETE` triggers on the ten
  catalogue and document tables (`HISTORY_TABLES` in `src/db/schema.ts`) copy each row change, cascades
  included, so no code path can forget to log, and the snapshots hold every column. They link rows to the
  change set through `change_context`, a one-row table that the first statements of a batch fill and its last
  statement empties: D1 runs a batch as one transaction and one batch at a time, so the row is never seen by
  another request, and a failed batch rolls it back (the opening statement also replaces a row that an
  interrupted manual script might have left). A write to a tracked table with no change set open is
  aborted (`RAISE(ABORT)`), which makes the history complete by construction: every page, CSV import, build,
  receipt and user change goes through `runChangeSet()` (`src/domain/history.ts`; pages use `saveChanges(c,
  summary, statements)`), which a future MCP tool calls with `source: "mcp"` and its client name; `mcp` is in
  the enum already, so that work needs no migration. Application-level logging was rejected: one missed call
  and a change is gone. A change set that changed nothing (e.g. "start" on a started build) is not kept. Rows that existed
  before 0005 get no backfilled "insert" entry: their later changes carry full before/after rows, so they
  can be undone all the same.
  The ledgers (`stock_moves`, `build_lines`) and `price_history` are not tracked: they are append-only
  already. Updates that only touch who/when (a BoM "touched" when a line changes) are not logged.
- **D107. The trigger SQL is generated from the Drizzle schema.** `npm run -s db:triggers`
  (`scripts/history-triggers.mjs`, Node 22.18+ type stripping, no new dependency) prints `DROP TRIGGER IF
  EXISTS` + `CREATE TRIGGER` for every tracked table; its output is appended to the migration. A column added
  to a tracked table therefore needs `npm run db:generate` then `npm run -s db:triggers >> migrations/<new>.sql`:
  `test/history.test.ts` fails otherwise, because it compares the columns of each table in the migrated
  database (`PRAGMA table_info`) with the columns its triggers capture, compares the triggers with the
  generator's output, and checks that every table is either tracked or listed as untracked. Data migrations
  that write to a tracked table must open a change set themselves (`source 'migration'`, see CLAUDE.md).
- **D108. `price_history` is rebuilt to accept the `revert` source.** SQLite cannot alter a CHECK
  constraint, and a revert must record the price it puts back (D109). It is the first table rebuild, allowed
  because nothing references `price_history` (dropping it deletes no other row). drizzle-kit's `PRAGMA
  foreign_keys=OFF/ON` is replaced by `PRAGMA defer_foreign_keys = on`: D1 runs a migration in a transaction,
  where `foreign_keys` is a no-op. Applied with `wrangler d1 migrations apply --local` to a database holding
  data from 0000–0004: price history rows, CHECK constraints and indexes survive.
- **D109. Undo writes a new change set that walks the old one backwards.** An update gets its old values
  back (signed and dated by whoever undoes it), an insert is deleted, a delete is re-inserted with its id and
  its original who/when (ids are never reused: AUTOINCREMENT). It is refused, changing nothing, when a row's
  data columns differ from what the change set left (who/when are ignored, so a later "touch" does not block),
  when a deleted row is used since (a stock move on a part, a line added to a BoM…), when a restored row
  points at a row that no longer exists, or when a restored unique value (a ref, a PO number) is taken. These
  are checked in TypeScript first, a few queries per table, so the message can name the row and who changed
  it; then the batch repeats them as guards (`UPDATE change_context SET conflict = 1 WHERE …` fails the
  `revert_conflict` CHECK) so that a change made in between rolls everything back. Foreign keys are deferred
  in the batch, so rows come back in any order; in-batch reference guards are only needed where a cascade
  would delete silently (lines of a BoM or PO, offers of a part). An undo is itself a change set, so undoing
  an undo re-applies the change. Undoing an import of thousands of rows is one batch of the same size as the
  import.
- **D110. Summaries are stored text, in the author's language, without amounts.** They come from the
  `history.summaries` dictionary at the time of the change ("Edit BoM LAMP-DESK std Rev3"), so the history
  reads like a log of what people did; an MCP client will write its own. Storing a message key with
  parameters and translating at read time was considered: more columns and a contract with API clients, for
  a mixed-language team that does not exist yet. Summaries never contain an amount: every role reads them.
- **D111. What cannot be undone is marked so.** A change set that writes a ledger row (build completion,
  receipts, adjustments, counts, `stock.csv`) is set non-revertible by a trigger on `stock_moves` and
  `build_lines`, so no future caller can forget: these are corrected with reverse moves, as before. Replacing
  or removing a product image deletes the previous file from R2, and so does deleting a part that has an image:
  those change sets are non-revertible too (an undo would point at a missing file). A restore is recorded as
  one non-revertible change set. Undo keeps the price history consistent: every price an undo changes back
  (standard cost, selling price of a part or BoM variant, offer price) is appended with source `revert` and
  the note `#<change set>`; a part or BoM that an undo deletes takes its price history with it, as deleting it
  from its page does.
- **D112. Anyone reads the history; undoing needs the edit rights of everything touched.** The Recent changes
  page and the History tabs are open to every role, with amounts in snapshots nulled by `redactCosts()` (which
  now also matches snake_case `*_cents` keys) and shown through `Money` ("Hidden"); the cost sweep covers the
  history pages and raw cent values. Undo is `POST /history/:id/revert`, declared `history.revert` (operator:
  the lowest role that can edit something), and `revertChangeSet()` also requires the edit action of each
  table touched (`TABLE_ACTIONS`: parts → `parts.edit`, offers → `prices.edit`, BoM lines → `boms.edit`, PO
  lines → `purchasing.order`, builds → `builds.plan`, users and settings → `users.manage`…). So an operator
  can undo the planning of a build but not a part edit. Undoing a creation deletes the row with the edit
  right, not the admin-only delete right: the deletion is logged and can itself be undone.
- **D113. Backups carry the history; a restore does not log its rows.** `change_sets` and `change_log` are in
  the JSON backup (`change_context` is not: it only exists inside a batch). A restore inserts a `suppress`
  context row first, so the triggers stay silent while every table is replaced, then appends one
  non-revertible change set saying who restored which backup. Backups taken before 0005 are refused (D53). The
  history is never pruned: each change stores the rows it touched as JSON (about 600 bytes for a part), which
  a small shop's D1 database holds for years; a pruning or archiving job can come later.
- **D114. History pages.** *Recent changes* (`/history`, in the sidebar for everyone) lists change sets with
  filters on source, user, dates and summary text, 50 per page; a change set's page shows every row it touched,
  field by field ("quantity: 1 → 3"), with names instead of ids, translated kinds, statuses and roles, and
  amounts through `Money`; who/when columns and the deprecated supplier columns of parts are not shown. Parts,
  suppliers, BoMs and POs have a History tab with their own rows and those of their offers or lines (found
  with `json_extract` on the snapshots). The Undo button shows only to those allowed (D112) on change sets
  that can be undone and are not undone already; a refused undo re-renders the page (409) with the reasons.
  The sidebar label lives in the `history` dictionary section (`NavItem.label`).

## MCP server

- **D115. An MCP server in the same Worker, stateless, on the official SDK v2.** AI assistants reach Kitting at
  `/mcp` (Streamable HTTP) on the same Worker and D1 as the app. `@modelcontextprotocol/server` 2.x is the
  current stable line of the official TypeScript SDK; its `createMcpHandler` builds a fresh `McpServer` per
  request, answers 2026-07-28 clients (per-request envelope, `server/discover`) and 2025-era clients (an
  `initialize` handshake served by its stateless fallback) from one factory, and needs no session, so no
  Durable Object. v1 (`@modelcontextprotocol/sdk`) was ruled out: a single package that depends on Express,
  cors, Hono and more, now superseded. The OAuth side is `@cloudflare/workers-oauth-provider` 1.x in its
  one-Worker form (`OAuthProvider`): dynamic client registration at `/register`, S256 PKCE only, `/token` for
  codes, refreshes and revocation, RFC 8414 and RFC 9728 metadata, everything in the `OAUTH_KV` namespace
  (tokens and secrets hashed, props encrypted). Like the images bucket (D100), the binding is optional: the
  config generator adds it only with `OAUTH_KV_ID`, and without it the app is unchanged. No migration: nothing
  of MCP lives in D1.
- **D116. A connection's scopes are a ceiling; the role decides on every request.** `src/domain/mcp-scopes.ts`
  maps each scope to its kind (read or write) and to the permission actions its tools perform (D105); a tool
  declares `{ scope, action? }`. A tool is listed and callable only when the token carries its scope AND the
  user's current access allows it: `/mcp` runs `resolveAccess(email)` on every request, so a demotion or a
  change of the cost option applies to the next call, and nothing about the role is stored in the token. The
  consent page offers only the scopes the role allows (a scope with actions needs one of them; reading needs
  none, as every page reads). This first part offers the four read scopes; write scopes (`catalog:write`,
  `prices:write`, `catalog:archive`, `stock:write`, `builds:write`, `purchasing:write`) are added later as
  table rows with their actions, without changing the checks. The server registers only the allowed tools
  (the SDK's own scope challenge keeps a tool listed, which the rule forbids). A call to a known tool outside
  the token's scopes gets the MCP step-up answer, `403 insufficient_scope` naming the granted scopes plus the
  missing one, so a client can ask again; one the role forbids gets a JSON-RPC error saying so. Never over MCP,
  now or later: user management, backup and restore, CSV import, the connections themselves
  (`NEVER_OVER_MCP`, checked by a test), and no tool deletes permanently or uploads images.
- **D117. Consent behind Access, with the provider's consent helpers.** `/authorize` is an ordinary page behind
  Access (accessAuth says who the user is, there is no second login). It shows the client's name (marked
  unverified, as dynamic registration lets a client pick any name), the redirect host, a warning for a
  loopback redirect, one checkbox per offered scope, Allow and Deny. `beginConsent()` binds the form handle to
  the browser with a cookie, single use, ten minutes; Allow re-filters the ticked scopes by role on the server
  before `approveConsent()`. Requested scopes are pre-ticked; a client that requests none (MCP clients take
  scopes from the challenge, and this server sets no required scope) gets the read scopes pre-ticked, never a
  write scope. The grant's props, encrypted, hold the email and the granted scopes; its clear metadata holds
  the email, client name and redirect host for the connected apps page; its user ID is the URI-encoded email
  (the provider forbids `:` in IDs). Two permission actions: `apps.connect` (every role: connect an assistant
  and revoke one's own) and `apps.manage` (admins: see and revoke everyone's). Errors follow the library's
  rule: redirect to the client only when `parseAuthRequest()` validated the redirect URI, else render locally.
- **D118. Only the OAuth paths skip Access, exactly.** `src/index.ts` sends `/mcp`, `/token`, `/register` and
  `/.well-known/oauth-*` to the provider, and only when `OAUTH_KV` is bound; every other path, `/authorize`
  and `/connected-apps` included, goes through the app's middleware as before (Access JWT, Origin check), so
  `/mcp/x` or `/tokens` still fail closed. Those paths are protected by OAuth instead: the provider rejects a
  missing or invalid bearer token with 401 and a `WWW-Authenticate` pointing at the resource metadata. The
  provider is built per origin and cached, because its canonical resource (`<origin>/mcp`, every token's
  audience) must be an absolute URL; the Worker only answers on its custom domain (D43), or on localhost.
  OAuth runs only over HTTPS or on a loopback host (the library refuses anything else), so `wrangler dev`
  needs `--local-upstream localhost:8787 --upstream-protocol http` (README).
- **D119. Read tools reuse the domain code and speak in references.** Eleven tools over the existing queries
  (`listParts`, `partBomSummary`, `whereUsed`, `explode`, `CostCalculator`, `listMoves`, `buildPickList`,
  `computeShortages`, `listPos`…), all annotated `readOnlyHint`. Inputs are what a person would say: part
  references (case-insensitive), a BoM by id or by the reference of the part it builds (+ variant code or
  revision), build and PO numbers; quantities as decimal strings or numbers, parsed by `parseMilli` (never
  floats); lists have a default and a maximum limit. zod validates every input; errors are sentences that say
  what to do next ("Use search_parts to find it"); unexpected errors are logged and returned without details.
- **D120. Results are redacted on the app's fields, then turned into decimals.** Tools return their data with
  the app's integer names (`*Milli`, `*Cents`, `*Millicents`, `rateBp`), so `redactCosts()` (D105) works on
  them unchanged; only then does `toWire()` turn quantities and amounts into decimal strings (`"1.5"`,
  `"12.30"`) with snake_case keys. For a user who may not see costs, amount fields are dropped rather than
  shown as null (null already means an unknown cost) and the result carries `costs_hidden: true`; the server
  instructions say so. A test sweeps every tool as a viewer and an operator for seeded amounts.
- **D121. One CSP exception: the consent form's redirect.** The consent form posts to `/authorize`, which
  redirects the browser to the client's registered redirect URI, and browsers apply `form-action` to that
  redirect. The consent page alone adds that origin (parsed by `URL`, never raw input) to `form-action`;
  everything else in the policy is unchanged, and every other page keeps `form-action 'self'`.
- **D122. Administrators list grants from the KV key layout.** The provider lists one user's grants only. To
  show admins every connection (viewers, who are not in the `users` table, can connect too), the page lists
  `grant:` keys and takes the user ID from `grant:{userId}:{grantId}`, the library's documented storage layout,
  then reads each user's grants through the provider. An admin revoke looks the grant's owner up the same way.
- **D123. Token lifetimes, and what Access removal does not do.** Access tokens last one hour; refresh tokens
  rotate and the grant expires 30 days after the code exchange however often it is used (not sliding), so a
  connection goes back through Access consent at least monthly; dynamically registered clients expire after
  90 days unused; a consent page after ten minutes. Because `/mcp` skips Access, removing someone from the
  Access policy does not stop their assistant until its grant expires: revoke it on the connected apps page
  (the README says so). Superseded in part by D130: only listed users may use MCP, and removing a user revokes
  their grants. Client ID Metadata Documents, which the 2026 authorization spec prefers to dynamic
  registration, are not enabled yet: they need the `global_fetch_strictly_public` compatibility flag, which
  changes every `fetch()` of the Worker; the provider logs a notice about it once per isolate.
- **D124. Testing MCP in workerd.** The vitest config adds an `OAUTH_KV` namespace; `test/mcp-helpers.ts`
  empties it before each test (storage is shared by a file's tests, like D1) and plays a real client:
  dynamic registration, the consent page with its binding cookie, the PKCE exchange, then JSON-RPC calls to
  `/mcp` (answers may be JSON or SSE). `{ OAUTH_KV: undefined }` checks the app without the binding, and
  `ENVIRONMENT: "production"` that every other route still needs the Access JWT.

## MCP write tools

- **D125. Archiving is its own permission.** `parts.archive` and `boms.archive` (admin, as before) are split from
  `parts.delete` and `boms.delete`: the part archive/unarchive routes and the BoM archive route declare them, and
  the `*.delete` actions now mean permanent deletes only (parts with their offers and images, suppliers, BoMs,
  POs). That lets `NEVER_OVER_MCP` list every `*.delete` action while `catalog:archive` offers archiving.
  `TABLE_ACTIONS` is unchanged: archiving is an UPDATE of `parts` or `boms`, undone with `parts.edit` or
  `boms.edit` like any edit (as D112 lets the edit right undo a creation); a planner could already bring a BoM
  back with "Set back to draft" or "Activate" (`boms.edit`).
- **D126. Write scopes are table rows with their actions.** `catalog:write` → `parts.edit`, `suppliers.edit`,
  `boms.edit`; `prices:write` → `prices.edit`; `catalog:archive` → `parts.archive`, `boms.archive`;
  `stock:write` → `stock.adjust`, `stock.count`; `builds:write` → `builds.plan`, `builds.complete`;
  `purchasing:write` → `purchasing.order`, `purchasing.receive`. As D116 planned, consent offers a scope when the
  role has at least one of its actions, and each tool declares one action of its scope (a test checks it), so an
  operator granted `purchasing:write` may `receive_po` but not `mark_po_sent`. The table is ordered by area for the
  consent page, where write scopes carry a warning badge and are pre-ticked only when the client asks for them.
  `NEVER_OVER_MCP` now also lists the permanent deletes and `history.revert`: undoing stays in the app, where its
  conflicts are shown.
- **D127. Each write tool is one change set through the pages' own rules.** A write tool builds the values its
  page would post and runs the same domain validation and statement builders. The route checks that lived in
  handlers moved to `src/domain` first (`checkPart`, `supplierNameTaken`, `newBomErrors`, `componentError`,
  `archivedBomCycles`, `buildPlanErrors`, `adjustmentErrors`, `planReceipts`, `offerFormStatements`), and the
  routes call them too. `saveChange()` (`src/mcp/kit.ts`) runs the statements with `runChangeSet()`: the user's
  email, source `mcp`, the client's name (kept in the grant's encrypted props at consent; grants made before
  show their client ID) and a summary from `history.summaries` in the deployment's `DEFAULT_LOCALE` (summaries
  are in their author's language, D110; an assistant has none), never an amount. Every result carries
  `change_set_id`, `revertible` (read back, since ledger triggers clear it), and when it can be undone
  `history_path` and `history_url` with a sentence saying how; a call that changes nothing records nothing and
  says so. Edits merge the given fields over the current values (`partToForm`, `offerToForm`, `supplierToForm`),
  so an omitted field never resets: `update_part` keeps prices and the preferred offer's terms. Refusals are
  English sentences built from the same error keys (`field: message`, every problem at once), and nothing is
  written. Inputs are references, names and numbers as people say them; decimals as strings or numbers, parsed
  by the forms' field builders. Annotations: `destructiveHint` when a tool overwrites, archives or removes data,
  or writes the stock ledger (no undo); `idempotentHint` when a second identical call changes nothing more.
  Price history rows keep the source `form`: `price_history.source` has a CHECK without `mcp`, and adding it
  would rebuild the table, which schema changes avoid on D1; the change set records the origin. Specific choices:
  `complete_build` takes serials per part and sub-assembly choices by reference (every place the part appears,
  found by exploding the BoM with no stock) or by the `path` that `get_build` now returns, and refuses serials
  the pick list would not use (the page cannot send them); `update_draft_po` sets a quantity per part (`0`
  removes the line), its expected date and notes work on any PO like its page, its lines only on drafts;
  `create_draft_pos` maps the shortage page's supplier checkboxes (`suppliers`) and "order from" selects
  (`order_from`), refusing an `order_from` the page would silently skip.
- **D128. Over MCP, BoMs change through draft revisions.** `set_bom_lines` replaces every line at once, each
  checked like the editor's (known, not archived, whole units for serial-tracked parts, no cycle), nothing written
  if one fails. It never edits an active BoM: in one change set it creates the next revision (draft, the active
  one's notes, no copied lines since they are replaced) and inserts the lines (`bom_id` by a subquery on parent,
  code and revision), and its result says the active BoM is unchanged. `activate_bom` is the separate, explicit
  step; it archives the previous active revision, which can be activated again (re-checking cycles, as the page
  does). Archived BoMs are read-only (`new_bom_revision` copies one). The pages still edit an active BoM line by
  line: a person sees each change, while an assistant's batch should be reviewed before builds use it.
- **D129. `list_recent_changes`.** On `catalog:read`, since every role reads Recent changes. Filters are the
  page's (source, user, text, dates) plus `before` for paging; each change set has its summary, source, client,
  undo state, page, and up to 50 row entries (table, operation, record name from `rowName()`, moved to the domain,
  and fields before/after). Snapshot columns are snake_case (`cost_cents`), which `toWire()` does not convert,
  so the tool formats them itself after `entryView()` redaction: decimals, names instead of ids, booleans, and an
  amount the user may not see as `{ field, hidden: true }` with no values. The cost sweep includes it, with a
  logged price change, and also looks for raw cent values.
- **D130. Offboarding: MCP needs a listed user, and removing one revokes their connections.** `/mcp` skips
  Access, so removing someone from Access left their assistant working until its grant expired (D123).
  `resolveAccess()` now also says whether the user is listed (a row on Users, or `ADMIN_EMAILS`); the consent
  page (before any consent transaction starts) and every `/mcp` request require it. The web app is unchanged:
  an unlisted person is still a viewer there, and the consent page explains why they cannot connect. `/mcp`
  answers 403 with a JSON-RPC error rather than 401, as re-authorizing would fail at consent too. Removing a user
  on the Users page revokes all their grants through the provider (when `OAUTH_KV` is bound and the origin can
  run OAuth). The README's offboarding steps: remove from Access, then from Users. Reversible: one condition in
  `mcpApiHandler` and one middleware on `/authorize`; dropping both restores D123. Known limits: undoing a
  "Remove user" restores the row, not the grants (the person reconnects); a users row removed another way (an
  undo of its creation, SQL) leaves grants that the per-call check refuses, and that would work again if the
  person were listed again before they expire (30 days at most).
- **D131. Server instructions for writes.** The instructions returned at `initialize` and `server/discover` now
  say to confirm with the user before any write, that BoM edits go through draft revisions activated
  separately, and that every change can be undone from Recent changes except stock and build ledger operations
  (corrected with reverse movements), which the assistant itself cannot undo. Tool descriptions repeat what
  matters for each tool.
- **D132. The know-how ships with the tools: a skill, in a plugin, in this repository.** `plugins/kitting` is a
  Claude plugin (`.claude-plugin/plugin.json`, the skill `skills/kitting/`, the connector `.mcp.json`), listed by
  `.claude-plugin/marketplace.json` (marketplace `kitting-plugins`, entry `kitting`, a relative source, no version
  of its own since `plugin.json`'s wins). The skill is a concise `SKILL.md` (domain primer, safety rules,
  workflows by tool name) with `references/` for what is only needed sometimes: `tools.md` (every tool: scope,
  permission, inputs, outputs, an example), `glossary.md` (English/French) and `examples.md` (conversations on the
  demo dataset only). Its frontmatter has only `name` and `description` (at most 1,024 characters, claude.ai's
  limit), so the same folder loads in Claude Code, Cowork, claude.ai and any Agent Skills client. The skill states
  what the code does, not what the tool descriptions hope: history links only when `revertible`, the several
  shapes of a refusal (a write's "Refused, nothing was changed", a failed lookup, a role or scope refusal answered
  before the tool runs), `set_bom_lines` not copying lines into the new revision. Rejected: a skill without a
  plugin (no connector bundled, two installs); documenting the tools only in the README (not loaded when needed).
- **D133. Keeping the skill honest: tests, not review.** `test/plugin.test.ts` (Vitest, `?raw` imports, so it runs
  in workerd like the rest) fails when a registered tool is missing from `references/tools.md` (one section each,
  with its scope, permission action, every input field, an example call), when the skill or a reference uses a
  snake_case name that is neither a tool, an input field (read from the zod schemas) nor a listed result field,
  when `plugin.json`'s version or the server's reported version differs from `package.json`'s, when the
  marketplace entry drifts, or when the server instructions no longer point to the skill or exceed Claude Code's
  2,048 character cut. `plugins/kitting/evals/` holds three prompts with expected tool sequences in the
  `claude plugin eval` layout; they need a throwaway deployment with OAuth, so they are run by hand, not in CI.
  CLAUDE.md asks for `tools.md` and the workflows that use a tool to change with the tool.
- **D134. The plugin's connector URL comes from `KITTING_MCP_URL`.** `.mcp.json` declares
  `{ "type": "http", "url": "${KITTING_MCP_URL}" }`: no real domain in a public repository. Claude Code expands
  `${VAR}` in a plugin server's `url` (documented, and checked against a local server: it connects to the
  variable's URL, then starts the OAuth sign-in), and `claude plugin validate` passes. claude.ai and Cowork list a
  bundled remote server on the plugin's Connectors tab only for a fixed URL and do not expand variables, so
  there a company keeps a private copy of the plugin with its URL written in (the README explains it), or adds
  the connector by hand and uploads the skill zip. Rejected: `userConfig` with `${user_config.KEY}` (Claude Code
  would prompt for the URL, but chat ignores a server whose URL contains the reference and Cowork does not prompt);
  a placeholder host in the file (it would connect to the wrong place). The file holds no secret: access is
  decided by OAuth and the user's role.
- **D135. `npm run skill:zip` packs the skill with a small Node script, no dependency.** claude.ai wants a zip
  whose top level is the skill folder. `scripts/pack-skill.mjs` writes `dist/kitting-skill.zip` (gitignored) with
  `node:zlib` and fixed timestamps, so the same files give the same bytes, and it works wherever Node runs
  (Windows has no `zip`). Rejected: shelling out to `zip` (not everywhere), an archiving package (a dependency for
  forty lines). The README gives a manual fallback. The server instructions now end with a sentence pointing to
  the plugin and the skill zip, generic (no URL), so a client that only has the connector learns the skill exists.
