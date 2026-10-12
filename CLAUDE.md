# Kitting: conventions for contributors and coding agents

Mini-MRP on Cloudflare Workers + D1 + Access. Read `README.md` for the product,
`docs/plan.md` for the milestones and `docs/decisions.md` for past choices.
Record every new non-obvious choice in `docs/decisions.md`.

## Public repository hygiene (non-negotiable)

- No company data, no secrets, no account IDs, no real emails or domains anywhere.
  Use `example.com` / `.example` and the fictional dataset in `examples/demo/`.
- `wrangler.jsonc` and `.dev.vars` are gitignored. Only `wrangler.example.jsonc` and
  `.dev.vars.example` (placeholders) are committed.
- Keep `workers_dev: false` and `preview_urls: false`.

## Commands

- `npm run check`: typecheck (`tsc`, TypeScript 7) + lint (Biome) + tests. Run it before committing.
- `npm test`: Vitest in workerd via `@cloudflare/vitest-plugin`, real local D1.
  Vitest is pinned to 4.1.x (5.x breaks the plugin).
- `npm run db:generate`: after any change to `src/db/schema.ts`. Commit the SQL and
  `migrations/meta/`. CI fails if the schema and migrations disagree.
- `npm run format`: Biome formatting + safe fixes (tabs, double quotes, 120 columns).

## Layout

- `src/app.tsx`: middleware stack (security headers → Access auth → Origin check → locale/db) and route mounting.
- `src/middleware/`: `auth.ts` (Access JWT, dev bypass, `requireAdmin`), `security.ts` (CSP, CSRF).
- `src/db/schema.ts`: Drizzle schema, the single source of truth for tables.
- `src/domain/`: business logic and queries, framework-free where possible (unit-testable).
  `bom-graph.ts` is pure (explosion, cost roll-up, cycle detection over an in-memory graph);
  `boms.ts` loads the graph and holds the recursive CTEs (where-used, cycle check on save).
  `stock.ts` (ledger, counts, valuation), `builds.ts` (pick list, completion batch),
  `purchasing.ts` (shortage engine, POs, receipts), `backup.ts` (JSON export/restore).
  `src/domain/import/`: one importer per CSV type, all implementing `Importer`.
- `src/routes/*.tsx`: one Hono router per area, with its page components.
- `src/views/`: layout, shared UI components (`ui.tsx`), render helpers, view context (`useApp()`).
- `src/lib/`: units (fixed-point), CSV, validation (zod field builders), SQL helpers, batch.
- `src/i18n/`: `en.ts` defines the `Dict` type; `fr.ts` must match it (compile error otherwise).
- `public/static/`: CSS, `app.js`, vendored `htmx.min.js` (`npm run vendor:htmx` to update).

## Data rules

- Money: integer cents (`*_cents`). Quantities: integer thousandths (`*_milli`).
  Never use floats for stored or computed values. Parse and format only through
  `src/lib/units.ts` (`parseMilli`, `parseCents`, `formatQty`, `formatMoney`, `lineCostCents`, `mulMilli`…).
  `cost_cents = NULL` means "unknown cost" and makes roll-ups incomplete.
- Timestamps: ISO-8601 UTC text (`nowIso()`); dates: `YYYY-MM-DD` text.
- Every insert sets `createdBy`/`updatedBy` to `c.var.user`; every update sets
  `updatedAt: nowIso()` and `updatedBy`.
- `stock_moves` is append-only: never UPDATE or DELETE. Corrections are new moves.
  On-hand = `SUM(qty_milli)` per part.
- Any write touching several rows goes through `runBatch()` (one D1 batch = one transaction).
- Raw SQL is fine where Drizzle gets in the way (recursive CTEs), always parameterized
  (Drizzle `sql` template or `prepare().bind()`), never string concatenation of values.

## Validation and errors

- Validate every form and every import row with zod, using `field.*` from `src/lib/validation.ts`.
- Issue messages are i18n keys of `Dict.errors`; translate with `errorText()` / `translateErrors()`.
- Business rules shared by forms and imports live in `src/domain/*` (e.g. `partRuleErrors`).

## UI

- Server-rendered Hono JSX. Pages use `page(c, title, body)`; flash messages use
  POST-redirect-GET with `?ok=saved` (see `redirectOk`).
- Strict CSP: no inline `<script>`, no `style=` attributes, no `<style>`, never
  `dangerouslySetInnerHTML` or `raw()` (Biome errors on it). Behaviour goes in `public/static/app.js`
  via `data-*` attributes; styling via classes in `app.css`.
- htmx is progressive enhancement only: every feature must work as a plain form.
  Live search uses `hx-select="#results"` on the full page response. No `hx-on`, no `hx-boost`.
- Tablet-first: use `.button`, `.field`, `.table`; touch targets stay ≥ 48px.
- All user-visible text goes in both dictionaries. No hard-coded strings in components.
- Destructive actions (import commit, delete, archive) use `requireAdmin` and are only shown to admins.

## Tests

- Tests call the app through `test/helpers.ts` (`request`, `postForm`), which adds a
  same-origin `Origin` header to POSTs. Each test starts from an empty database.
- Override env per request to test auth/admin (`{ ADMIN_EMAILS: "other@example.com" }`).
- Every domain rule (explosion, costs, shortages, completion, receiving, imports) gets tests.
- The demo dataset is a fixture: `examples/demo/*.csv` must always import cleanly.

## Git

Small, focused commits with imperative messages. Justify any new dependency in the
PR description and in `docs/decisions.md`.
