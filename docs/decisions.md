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
