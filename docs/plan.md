# Plan

Ship in milestones; each one is deployable and useful on its own.
After M2 the catalogue and BoMs can be loaded; after M4 real builds can run.

## M1: Foundation ✅

- [x] Scaffold: Workers + Hono JSX + htmx (vendored) + D1 + Drizzle, TypeScript strict, Biome
- [x] `wrangler.example.jsonc` (placeholders, `workers_dev: false`, custom domain), config generator
- [x] Access JWT middleware (jose, fails closed) with `DEV_AUTH_EMAIL` bypass in development only
- [x] Security: CSP without inline code, Origin check on non-GET, security headers
- [x] Full domain schema + initial migration
- [x] Suppliers CRUD, parts CRUD (list with search/filters, detail, archive, delete)
- [x] CSV import with dry-run preview for suppliers, parts, stock (initial counts); CSV export
- [x] fr/en dictionaries, tablet-first CSS
- [x] Demo dataset (fictional desk lamp) + test that imports it
- [x] CI (typecheck, lint, tests, migrations in sync) and manual deploy workflow
- [x] README (deploy, Access guide), CLAUDE.md, decisions log

## M2: BoMs ✅

- [x] BoM list per part; create BoM (parent, variant code, revision, status)
- [x] Editor: add / remove / reorder lines (htmx), quantities in milli
- [x] New revision = copy of the current one; activate (archives the previous active of the same code)
- [x] Cycle check across BoMs on every save (recursive CTE)
- [x] Tree view (expandable) with qty, cumulative qty, cost roll-up (incomplete flag)
- [x] Flat exploded list for N units
- [x] Where-used (direct and indirect) on the part page
- [x] `boms.csv` import (group by parent/code/revision, replace lines) + export
- [x] Cost roll-up shown on part detail for make/kit parts

## M3: Stock ✅

- [x] Stock page: on-hand list with search, filters (below zero, below MOQ)
- [x] Manual adjustment with reason (adjust move, signed qty, optional serial)
- [x] Inventory count screen (enter counted qty → count move for the difference)
- [x] Valuation report (on-hand × standard cost, make parts at rolled-up cost) + CSV export
- [x] JSON export of the whole database (backup) and restore (admin, preview first)
- [x] Moves ledger with filters and CSV export

## M4: Builds ✅

- [x] New build: part + variant (active BoM), qty, serial (required if tracked, unique), planned date
- [x] Pick list: exploded components, make lines "use stock" / "build now", checkboxes, serial inputs
- [x] Atomic completion (one D1 batch): consume moves, output move with serial, build_lines
- [x] Refuse completion when a serial-tracked component has no serial
- [x] Build detail with the as-built record; serial traceability (component serial → build)
- [x] Sub-assembly pre-builds (make parts without the final product)
- [x] Builds list (planned / in progress / done / cancelled)

## M5: Purchasing ✅

- [x] Shortage engine for planned + in-progress builds (need − on-hand − open PO), MOQ/pack rounding, by supplier
- [x] "Create draft POs" (one per supplier)
- [x] PO edit, mark sent, cancel, close short-shipped POs, CSV for the supplier
- [x] Receiving (partial), receipt moves, PO status
- [x] Dashboard: shortages, parts below zero / below MOQ, open POs, last builds

## M6: UI refresh ✅

- [x] shadcn/ui design system on Tailwind CSS v4 (official agent skill installed locally, see CLAUDE.md), components ported to Hono JSX
- [x] Left sidebar (grouped, collapsible to icons, off-canvas on phones), header with breadcrumb and search
- [x] Light / dark / system theme, stored in a cookie (no flash, no inline script)
- [x] Every page rebuilt on the components (cards, tables, fields, badges, alerts, empty states, stat cards)
- [x] Dashboard with KPI cards
- [x] BoM structure diagram (nested sub-assemblies and kits) with depth and "assemblies only" views, zoom and pan
- [x] Global search across parts, BoMs, builds (incl. serials), POs and suppliers

## M7: Pricing ✅

- [x] Several suppliers per part (`part_suppliers`), one preferred; `part_suppliers.csv` import/export
- [x] Shortages and draft POs from the preferred offer; a line can be ordered from another supplier
- [x] Append-only price history (standard costs, offer prices, selling prices) and paid prices from receipts
- [x] Selling prices per product, overridable per BoM variant; planned and actual margins, margins page
- [x] Valuation by standard cost (dated from the history) and weighted average cost, side by side
- [x] Additive migration 0002 (no table rebuild), tested on data; demo dataset with a second supplier and prices

## M8: Margin history and product images ✅

- [x] Margin history per sellable item, derived from the price history: chart, changes and completed builds
- [x] "Also use this price as the standard cost" on the offer form and in `part_suppliers.csv`
- [x] One image per part in an optional R2 bucket (migration 0003 adds `parts.image_key`), shrunk in the
      browser before upload, shown on the part page and in the parts list

## M9: Roles ✅

- [x] Viewer, operator, planner, admin; unlisted users are viewers, `ADMIN_EMAILS` always admins
- [x] Users page for admins (`/users`), with the option letting viewers and operators see costs
- [x] Default-deny access policy for writes, read rules for admin, import and cost pages
- [x] Pages hide the controls and amounts a role cannot use; additive migration 0004 (`users`, `settings`)
- [x] JSON backup restricted to admins, and includes roles

## M10: Change history and undo ✅

- [x] `change_sets` and `change_log` (migration 0005), filled by SQLite triggers generated from the Drizzle
      schema (`npm run db:triggers`); a write to a tracked table outside a change set is aborted
- [x] Every write runs through `runChangeSet()` with a summary and a source (`ui`, `import`, `revert`, `migration`;
      `mcp` reserved for the MCP server, with the client's name); route writes moved into `src/domain` first
- [x] A test fails when a tracked table has a column its triggers do not capture
- [x] Undo: a new change set that walks the old one backwards, refused atomically on conflicts (changed since,
      still used, parent gone, unique value taken); undoing an undo works
- [x] Ledger writes (builds, receipts, adjustments, counts) and image changes are not revertible; undone prices
      are appended to the price history (`revert` source, `price_history` rebuilt)
- [x] Undo needs the edit permission of every area touched (`history.revert` + `TABLE_ACTIONS`); everyone reads the
      history, amounts redacted without cost visibility
- [x] Recent changes page (filters: source, user, dates, text), change set page with field-level diffs and
      conflict messages, History tab on parts, suppliers, BoMs and POs
- [x] JSON backup includes the history; a restore suppresses the triggers and records itself

## M11: MCP server ✅

AI assistants (Claude, ChatGPT or any MCP client) connect to `/mcp` with OAuth; optional (`OAUTH_KV` binding).

- [x] OAuth 2.1 server in the same Worker (dynamic registration, PKCE, tokens and grants in KV), stateless
      MCP endpoint on the official SDK; only `/mcp`, `/token`, `/register`, `/.well-known/oauth-*` skip Access
- [x] Consent page behind Access (scopes the role allows, Allow / Deny), connected apps page with revoke
      (admins see everyone's), token lifetimes documented
- [x] Scope table mapped onto the permission actions; role read again and costs redacted on every request
- [x] Read tools: parts, BoMs (tree, explosion), stock, moves, builds (serial search, pick list, as-built),
      shortages, purchase orders, recent changes with field diffs
- [x] README setup (KV namespace, Access bypass, custom connector, local testing with the MCP Inspector)
- [x] Archiving split from permanent deletes in the permission table (`parts.archive`, `boms.archive`)
- [x] Write tools (catalogue, prices, archive, stock, builds, purchasing) with their scopes and actions: the pages'
      validation and statement builders, one change set each (source `mcp`, client name), undo link in results
- [x] BoM edits through draft revisions (`set_bom_lines` never edits an active BoM; `activate_bom` is explicit)
- [x] Never over MCP, tested: permanent deletes, undo, users, backups, imports, image uploads
- [x] Offboarding: only listed users connect and call `/mcp`; removing a user revokes their connections

## M12: Skill and plugin ✅

The know-how for assistants, installable with the tools (D132–D135).

- [x] Skill `plugins/kitting/skills/kitting`: domain primer, safety rules, workflows by tool name; references for
      every tool (scope, permission, inputs, outputs, example), an English/French glossary, worked examples
- [x] Claude plugin (`plugin.json`, connector `.mcp.json` reading `KITTING_MCP_URL`) and repository marketplace
      (`.claude-plugin/marketplace.json`), validated with `claude plugin validate`
- [x] `npm run skill:zip`: the skill as a zip for claude.ai, no dependency
- [x] Server instructions mention the skill and how to get it
- [x] Tests: every tool documented, no invented tool or field name, versions in sync (`test/plugin.test.ts`)
- [x] Evaluation prompts with expected tool sequences (`plugins/kitting/evals/`, run by hand)
- [x] README "Use Kitting from Claude": Claude Code and Cowork, claude.ai, other clients, a company's private copy

## After v1 (ideas, not planned)

- MCP: Client ID Metadata Documents (needs the `global_fetch_strictly_public` compatibility flag, D123).
- Serial inventory (which serials are in stock) enforced at build time, if the shop starts scanning receipts.
- Reservations of stock for planned builds; build scheduling.
- PDF purchase orders.
- Product images in the BoM diagram and on build pick lists; a purge of images orphaned by a restore.
- Multi-level "build all missing sub-assemblies" helper from the shortage list.
- Where-used diagram (the BoM diagram reversed) on the part page; SVG/PDF export of diagrams.
- Choose one valuation method once the accountant decides (D91), and drop the deprecated `parts` supplier columns
  in a planned table rebuild.
- Customer-specific prices, quotes (out of scope for v1).
- History: prune or archive old change sets; undo a whole import from the import page.
