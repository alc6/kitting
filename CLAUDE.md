# Kitting: conventions for contributors and coding agents

Mini-MRP on Cloudflare Workers + D1 + Access. Read `README.md` for the product,
`docs/plan.md` for the milestones and `docs/decisions.md` for past choices.
Record every new non-obvious choice in `docs/decisions.md`.

## Public repository hygiene (non-negotiable)

- No company data, no secrets, no account IDs, no real emails or domains anywhere.
  Use `example.com` / `.example` and the fictional datasets in `examples/`.
- `wrangler.jsonc` and `.dev.vars` are gitignored. Only `wrangler.example.jsonc` and
  `.dev.vars.example` (placeholders) are committed.
- Keep `workers_dev: false` and `preview_urls: false`.

## Agent setup

Before UI work, install the official shadcn/ui agent skill (third-party, so not committed):

```bash
npx skills add shadcn/ui
```

It lands in `.claude/skills/shadcn` (gitignored). `skills-lock.json` records the version the project
was built with; `npx skills update` refreshes it.

## Commands

- `npm run check`: CSS build + typecheck (`tsc`, TypeScript 7) + lint (Biome) + tests. Run it before committing.
- `npm run css`: build `public/static/app.css` from `src/styles/app.css` (Tailwind v4; output gitignored).
  `npm run css:watch` while editing classes (`wrangler dev` with the example config also rebuilds it).
- `npm test`: Vitest in workerd via `@cloudflare/vitest-plugin`, real local D1.
  Vitest is pinned to 4.1.x (5.x breaks the plugin).
- `npm run db:generate`: after any change to `src/db/schema.ts`. Commit the SQL and
  `migrations/meta/`. CI fails if the schema and migrations disagree.
- `npm run -s db:triggers >> migrations/<new migration>.sql`: after adding or removing a column of a tracked
  table (`HISTORY_TABLES`), re-creates the history triggers (Node 22.18+). `test/history.test.ts` fails until you do.
- `npm run skill:zip`: packs the Kitting skill as `dist/kitting-skill.zip` for claude.ai (no dependency, D135).
- `npm run format`: Biome formatting + safe fixes (tabs, double quotes, 120 columns).

## Layout

- `src/app.tsx`: middleware stack (security headers → Access auth → Origin check → locale/db → role → access policy)
  and route mounting.
- `src/middleware/`: `auth.ts` (Access JWT, dev bypass: who the user is), `roles.tsx` (role loading,
  `requirePermission(action)`, the startup check that every write route declares one), `security.ts` (CSP, CSRF).
- `src/db/schema.ts`: Drizzle schema, the single source of truth for tables.
- `src/domain/`: business logic and queries, framework-free where possible (unit-testable).
  `assembly-graph.ts` is pure (explosion, cost roll-up, cycle detection over an in-memory graph);
  `assemblies.ts` loads the graph and holds the recursive CTEs (where-used, cycle check on save).
  `stock.ts` (ledger, counts, valuation), `builds.ts` (pick list, completion batch),
  `purchasing.ts` (shortage engine, POs, receipts), `backup.ts` (JSON export/restore),
  `tree-layout.ts` (pure diagram layout), `search.ts` (global search), `offers.ts` (supplier offers),
  `prices.ts` (price history, dated standard costs), `costing.ts` (pure weighted average replay),
  `margins.ts` (planned and actual margins), `margin-history.ts` (margins over time, replayed from the
  price history), `images.ts` (product images in R2), `users.ts` (who has which role, cost visibility option),
  `permissions.ts` (what each role may do: the permission table, `can()`, cost redaction),
  `history.ts` (`runChangeSet()`, history queries, field diffs, row names), `revert.ts` (undo, conflicts,
  `TABLE_ACTIONS`), `mcp-scopes.ts` (MCP scopes and their permission actions).
  `src/db/history-sql.ts` generates the history triggers (`scripts/history-triggers.mjs` prints them).
  `src/domain/import/`: one importer per CSV type, all implementing `Importer`.
- `src/routes/*.tsx`: one Hono router per area, with its page components.
- `src/views/`: layout (sidebar, header), shadcn-style components (`ui.tsx`), icons (`icons.tsx`),
  assembly diagram (`assembly-diagram.tsx`), time charts (`chart.tsx`), render helpers, view context
  (`useApp()`: locale, theme, sidebar…).
- Part picker (D138): `PartPicker`/`PartPickerDialog` in `src/views/part-picker.tsx` (dialog after the form, scoped by
  `kinds`/`exclude` to what the form accepts), results from `GET /parts/pick` (`src/routes/part-picker.tsx`, `src/domain/part-picker.ts`).
- `src/styles/app.css`: Tailwind source: shadcn tokens (light/dark), base layer, legacy classes.
- `src/lib/`: units (fixed-point), CSV, validation (zod field builders), SQL helpers, batch.
- `src/i18n/`: `en.ts` defines the `Dict` type; `fr.ts` must match it (compile error otherwise).
- `plugins/kitting/`: the Claude plugin (D132): `.claude-plugin/plugin.json`, `.mcp.json` (connector URL from
  `KITTING_MCP_URL`), the skill in `skills/kitting/` (`SKILL.md` + `references/`) and `evals/`. The repository's
  `.claude-plugin/marketplace.json` lists it.
- `public/static/`: built CSS, `app.js` (confirm, theme/sidebar toggles, search shortcut, diagram zoom,
  photo shrinking before upload),
  vendored `htmx.min.js` (`npm run vendor:htmx` to update).

## Data rules

- **Every write opens a change set** (D106–D114): run the statements with `runChangeSet(db, { user, source,
  summary }, statements)` from `src/domain/history.ts`; a page uses `saveChanges(c, summary, statements)`
  (`src/views/render.tsx`). Never run a bare query or `runBatch()` on a tracked table: the history triggers
  abort it. Put the write logic in `src/domain` as statement builders, and give the change a meaningful
  summary from `t.history.summaries` naming what and which record ("Edit assembly LAMP-DESK std Rev3"), never an
  amount (every role reads it). An MCP tool saves through `saveChange()` (source `mcp`, its client name). A
  write that an undo could not restore consistently passes `revertible: false` (ledger writes are marked by
  trigger).
- A new table goes in `HISTORY_TABLES` (with its triggers, a `TABLE_ACTIONS` entry in `revert.ts` and labels in
  `history.tables`/`history.fields`) or in `UNTRACKED_TABLES`; `test/history.test.ts` checks both.
- A data migration or a manual `wrangler d1 execute` that writes to a tracked table opens a change set in the
  same file, so it is logged and allowed:

  ```sql
  INSERT INTO change_sets (user_email, source, summary) VALUES ('admin@example.com', 'migration', 'Fix part units');
  INSERT INTO change_context (id, change_set_id) VALUES (1, (SELECT max(id) FROM change_sets));
  UPDATE parts SET unit = 'pcs' WHERE unit = '';
  DELETE FROM change_context;
  ```

  Tests seed fixtures with `seedSql()` (not logged) or `changeSql()` (logged), from `test/helpers.ts`.

- Money: integer cents (`*_cents`). Quantities: integer thousandths (`*_milli`).
  Never use floats for stored or computed values. Parse and format only through
  `src/lib/units.ts` (`parseMilli`, `parseCents`, `formatQty`, `formatMoney`, `lineCostCents`, `mulMilli`…).
  `cost_cents = NULL` means "unknown cost" and makes roll-ups incomplete.
- Timestamps: ISO-8601 UTC text (`nowIso()`); dates: `YYYY-MM-DD` text.
- Every insert sets `createdBy`/`updatedBy` to `c.var.user`; every update sets
  `updatedAt: nowIso()` and `updatedBy`.
- `stock_moves` is append-only: never UPDATE or DELETE. Corrections are new moves.
  On-hand = `SUM(qty_milli)` per part.
- `price_history` is append-only too: every change of a standard cost, an offer price or a selling price
  adds a row in the same batch (`priceRecordStatement`, or go through `savePartStatements`,
  `saveOfferStatements`, `setStandardCostStatements`, `assemblySalePriceStatements`). Prices paid are the receipt moves.
- Supplier terms live in `part_suppliers` (one offer per part and supplier); `parts.supplier_id` is the
  preferred one. `parts.supplier_ref/moq_milli/pack_size_milli/lead_days` are deprecated: never use them.
- Product images live in the optional `IMAGES` R2 bucket: always go through `imagesBucket(c.env)` (null when
  the deployment has none, and the UI must then hide image controls). `parts.image_key` is the
  content-addressed object key; uploads are typed from their magic bytes (JPEG, PNG, WebP only, never SVG).
- Schema changes must stay additive on D1 (no table rebuilds under child tables): read the generated SQL,
  and apply it to a local database with data (`wrangler d1 migrations apply DB --local`) before committing.
- Any write touching several rows goes through one change set (one D1 batch = one transaction).
- Raw SQL is fine where Drizzle gets in the way (recursive CTEs), always parameterized
  (Drizzle `sql` template or `prepare().bind()`), never string concatenation of values.

## Validation and errors

- Validate every form and every import row with zod, using `field.*` from `src/lib/validation.ts`.
- Issue messages are i18n keys of `Dict.errors`; translate with `errorText()` / `translateErrors()`.
- Business rules shared by forms and imports live in `src/domain/*` (e.g. `partRuleErrors`).

## UI

- Server-rendered Hono JSX. Pages use `page(c, title, body)`; flash messages use
  POST-redirect-GET with `?ok=saved` (see `redirectOk`).
- Design system: shadcn/ui, ported to Hono JSX (no React). The official agent skill (see
  "Agent setup") and its rules apply: semantic tokens only (`bg-primary`, `text-muted-foreground`, never `text-red-600`),
  `gap-*` not `space-y-*`, `size-*`, `truncate`, `cn()` for conditional classes, built-in variants
  before custom classes. Never run `shadcn init`/`add` or add React/Radix: read a component's
  canonical recipe with `npx shadcn@latest view @shadcn/<name>` and port it to `src/views/ui.tsx`.
- Components live in `src/views/ui.tsx` (Button, Badge, Card*, Table*, Field*, Alert, EmptyState,
  LinkTabs, ToggleLinks, StatCard, DetailList, PageHeader…), icons in `src/views/icons.tsx`
  (Lucide, imported by name). Pages compose them; avoid one-off styled `div`s.
- Styling: Tailwind CSS v4. Tokens and the base layer are in `src/styles/app.css`;
  `npm run css` builds `public/static/app.css` (gitignored; `npm run dev` and deploy build it,
  `npm run css:watch` while editing). Tailwind only sees class names written literally in
  `src/` and `public/static/app.js`: never build class names from fragments. `@layer components`
  only keeps a few value-keyed hooks (`.num`, `.kind-*`, `.status-*`); everything else is utilities.
- Strict CSP: no inline `<script>`, no `style=` attributes, no `<style>`, never
  `dangerouslySetInnerHTML` or `raw()` (Biome errors on it). Behaviour goes in `public/static/app.js`
  via `data-*` attributes. Diagrams are inline SVG styled with classes (`fill-*`, `stroke-*`).
- Theme (light/dark/system) and the collapsed sidebar are cookies set by plain links
  (`/theme/:mode`, `/sidebar/:state`), rendered server-side on `<html>`: no flash, no inline script.
- htmx is progressive enhancement only: every feature must work as a plain form.
  Live search uses `hx-select="#results"` on the full page response. No `hx-on`, no `hx-boost`.
- Tablet-first: controls use `--control-h` (36px with a mouse, 48px on touch screens via
  `@media (pointer: coarse)`); keep touch targets ≥ 48px on touch devices.
- All user-visible text goes in both dictionaries. No hard-coded strings in components.
- Permissions (D101–D105): roles are viewer < operator < planner < admin, and what each may do is the
  `PERMISSIONS` table in `src/domain/permissions.ts`, keyed by `area.verb` actions (`stock.adjust`,
  `purchasing.order`, `costs.view`…), never by URL or role. These names are the future API/MCP scopes.
  - Check with `can(access, action)`, where access is `{ role, seeCosts }` (`useApp()` in views, `c.var` in
    handlers): no `atLeast()`, role names or `isAdmin` outside the table.
  - Every route that changes data declares its action: `xRoutes.post(path, requirePermission("…"), handler)`,
    or `xRoutes.use("*", requirePermission("…"))` for a whole router. `createApp()` refuses to start if a
    write route has none. Pages that only some roles may open (forms, cost pages) declare one too.
  - A new kind of action goes in the table, then in the `CALLS` of `test/permissions.test.ts` (it fails
    until it is there), in a group of `PERMISSION_GROUPS` with a label in `t.roles.actions` (both dictionaries):
    the matrix on the Users page is generated from them (D139).
- Costs, prices, valuations and margins are shown only when `seeCosts` (the cached `can(access,
  "costs.view")`): drop the column or card, never print an amount outside `Money`/`CostView`.
  `csvResponse` strips money columns (`MONEY_COLUMNS`) from every CSV; outside HTTP use `redactCosts()`.
  `test/costs-hidden.test.ts` must list any new page or CSV.
- Destructive actions (import commit, delete, archive) are admin actions in the table, and only shown to
  those who `can()` do them.

## MCP (AI assistants)

- Optional (D115–D131): `src/mcp/` holds the OAuth provider setup (`oauth.ts`), the stateless MCP endpoint
  (`server.ts`, with the server instructions), the wire format (`wire.ts`), the tools (`kit.ts`: tool shape, inputs,
  lookups, `saveChange()`; `read-tools.ts`, `history-tools.ts`, `catalog-tools.ts`, `price-tools.ts`,
  `stock-tools.ts`, `build-tools.ts`, `purchasing-tools.ts`; `tools.ts` lists them all); `src/domain/mcp-scopes.ts`
  maps scopes to permission actions; `src/routes/connect.tsx` is the consent page and the connected apps page.
  Everything is off (404) without the `OAUTH_KV` binding. Only `/mcp`, `/token`, `/register` and
  `/.well-known/oauth-*` skip Access (`isOAuthPath`, exact paths): never widen it. Only listed users (Users page or
  `ADMIN_EMAILS`) may connect and call `/mcp`; removing a user revokes their connections (D130).
- **Adding an MCP tool = scope + permission action + change set summary + redaction + test.** Give it a `rule`
  (`{ scope, action }`: a scope from `MCP_SCOPES`, plus for anything that changes data one of that scope's
  `PERMISSIONS` actions) and, for a write, `annotations: writes({ destructive, idempotent })`. A write builds the
  values its page would post, runs the same domain validation and statement builders (move any check still in a
  route into `src/domain` first), and saves with `saveChange(ctx, summary, statements)`: one change set, source
  `mcp`, the client's name, a summary from `ctx.t.history.summaries` (never an amount); spread its result into the
  tool's result. Return data with the app's integer field names (`*Milli`, `*Cents`) so `toWire()` redacts costs
  then converts to decimals (snake_case snapshot columns are not converted: format and redact them yourself, as
  `history-tools.ts` does). Test it: a read tool in `test/mcp-tools.test.ts` (and the cost sweep's `calls()`), a
  write tool in `test/mcp-write.test.ts` (its `CASES` row checks the change set, undo, scope and role refusals;
  plus its own happy path and refusals).
- **Adding or changing an MCP tool = update `plugins/kitting/skills/kitting/references/tools.md` and the workflows
  that use it** (`SKILL.md`, `references/examples.md`, the evals' expected sequences). `test/plugin.test.ts` fails
  when a tool is missing from `tools.md`, when the skill names a tool or field that does not exist (add a new
  result field to its list), or when `plugins/kitting/.claude-plugin/plugin.json`'s version differs from
  `package.json`'s, or when `SERVER_INFO.version` (`src/mcp/server.ts`) does: bump the three together. The skill's folder layout, the connector URL (`KITTING_MCP_URL`, never a
  real domain) and `npm run skill:zip` are described in D132–D135.
- Never over MCP: permanent deletes, undo, user management, backups, imports, image uploads (`NEVER_OVER_MCP` and
  the tool-name check in `test/mcp-scopes.test.ts`). Assemblies change only through draft revisions (D128).

## Tests

- Tests call the app through `test/helpers.ts` (`request`, `postForm`), which adds a
  same-origin `Origin` header to POSTs. Each test starts from an empty database.
- Tests run as `TESTER`, an admin through `ADMIN_EMAILS`. For another role: `await setRole("operator")`, then
  pass `NOT_ADMIN` as env overrides (both in `test/helpers.ts`).
- Every domain rule (explosion, costs, shortages, completion, receiving, imports) gets tests.
- The datasets in `examples/` are fixtures and must always import cleanly: `examples/demo/` is the small one for a
  first look, `examples/full/` the one most tests load (`loadDemo()`).

## Git

Small, focused commits following [Conventional Commits](https://www.conventionalcommits.org):
`type(scope): summary`, imperative, lower case, no final period.

- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `style`, `build`, `ci`, `chore`.
- Scopes are app areas, optional: `parts`, `suppliers`, `assemblies`, `stock`, `builds`, `purchasing`,
  `pricing`, `import`, `auth`, `ui`, `db`, `mcp`, `plugin`.
- Examples: `feat(builds): allow cancelling a planned build`, `fix(import): accept semicolon CSVs`,
  `docs: explain the Access setup`, `chore: bump wrangler`.
- Breaking changes (e.g. a migration that needs manual steps): `feat(db)!: …` plus a `BREAKING CHANGE:` line.

Commit as the repository's configured identity (a GitHub noreply address): never set a personal
email. Justify any new dependency in the PR description and in `docs/decisions.md`.
