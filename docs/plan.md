# Plan

Ship in milestones; each one is deployable and useful on its own.
After M2 the catalogue and assemblies can be loaded; after M4 real builds can run.

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

## M2: assemblies ✅

- [x] assembly list per part; create assembly (parent, variant code, revision, status)
- [x] Editor: add / remove / reorder lines (htmx), quantities in milli
- [x] New revision = copy of the current one; activate (archives the previous active of the same code)
- [x] Cycle check across assemblies on every save (recursive CTE)
- [x] Tree view (expandable) with qty, cumulative qty, cost roll-up (incomplete flag)
- [x] Flat exploded list for N units
- [x] Where-used (direct and indirect) on the part page
- [x] `assemblies.csv` import (group by parent/code/revision, replace lines) + export
- [x] Cost roll-up shown on part detail for make/kit parts

## M3: Stock ✅

- [x] Stock page: on-hand list with search, filters (below zero, below MOQ)
- [x] Manual adjustment with reason (adjust move, signed qty, optional serial)
- [x] Inventory count screen (enter counted qty → count move for the difference)
- [x] Valuation report (on-hand × standard cost, make parts at rolled-up cost) + CSV export
- [x] JSON export of the whole database (backup) and restore (admin, preview first)
- [x] Moves ledger with filters and CSV export

## M4: Builds ✅

- [x] New build: part + variant (active assembly), qty, serial (required if tracked, unique), planned date
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
- [x] assembly structure diagram (nested sub-assemblies and kits) with depth and "assemblies only" views, zoom and pan
- [x] Global search across parts, assemblies, builds (incl. serials), POs and suppliers

## M7: Pricing ✅

- [x] Several suppliers per part (`part_suppliers`), one preferred; `part_suppliers.csv` import/export
- [x] Shortages and draft POs from the preferred offer; a line can be ordered from another supplier
- [x] Append-only price history (standard costs, offer prices, selling prices) and paid prices from receipts
- [x] Selling prices per product, overridable per assembly variant; planned and actual margins, margins page
- [x] Valuation by standard cost (dated from the history) and weighted average cost, side by side
- [x] Additive migration 0002 (no table rebuild), tested on data; demo dataset with a second supplier and prices
- [x] Past prices: standard costs and supplier prices from before Kitting, added to the history from the part page
      or `price_history.csv`, only before the current price of their series (D142)

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
      conflict messages, History tab on parts, suppliers, assemblies and POs
- [x] JSON backup includes the history; a restore suppresses the triggers and records itself

## M11: MCP server ✅

AI assistants (Claude, ChatGPT or any MCP client) connect to `/mcp` with OAuth; optional (`OAUTH_KV` binding).

- [x] OAuth 2.1 server in the same Worker (dynamic registration, PKCE, tokens and grants in KV), stateless
      MCP endpoint on the official SDK; only `/mcp`, `/token`, `/register`, `/.well-known/oauth-*` skip Access
- [x] Consent page behind Access (scopes the role allows, Allow / Deny), connected apps page with revoke
      (admins see everyone's), token lifetimes documented
- [x] Scope table mapped onto the permission actions; role read again and costs redacted on every request
- [x] Read tools: parts, assemblies (tree, explosion), stock, moves, builds (serial search, pick list, as-built),
      shortages, purchase orders, recent changes with field diffs
- [x] README setup (KV namespace, Access bypass, custom connector, local testing with the MCP Inspector)
- [x] Archiving split from permanent deletes in the permission table (`parts.archive`, `assemblies.archive`)
- [x] Write tools (catalogue, prices, archive, stock, builds, purchasing) with their scopes and actions: the pages'
      validation and statement builders, one change set each (source `mcp`, client name), undo link in results
- [x] assembly edits through draft revisions (`set_assembly_lines` never edits an active assembly; `activate_assembly` is explicit)
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

## M13: Releases and Terraform ✅

Install and upgrade without copying the code (D141).

- [x] Release workflow: a `v*` tag runs the checks, builds `kitting-<version>.tar.gz` (built Worker, assets,
      migrations, deploy script) with its sha256, smoke-tests it in a dry run and attaches both to a GitHub release
- [x] `scripts/deploy-release.mjs`: settings from environment variables or a JSON file, migrations, prebuilt Worker
- [x] Terraform module `infra/terraform` (Cloudflare provider 5.27): D1, optional R2 and KV, Access applications and
      policies, outputs for the deploy script; example and CI job for a private repository
- [x] CI: `terraform fmt -check` and `terraform validate`, Node tests of the scripts
- [x] Docs: "Install with Terraform and a release"
- [x] Deploy to Cloudflare button: investigated and declined (D141)

## M14: In-house production ✅

Batch recipes, machines and machine time, and one-step runs, starting with 3D printing (D145–D152).

- [x] Batch recipes: an assembly makes N units (migration 0006, default 1), lines are for the whole batch; explosion,
      pick lists, completion and shortages take line × units / batch, rounded up per line; costs per unit
- [x] Builds of any quantity, entered in units or batches; batch on drafts only (since D153: edited with the lines),
      copied into revisions and variants
- [x] Machine types with an hourly rate (its own append-only history) and the machines owned, with a status; Machines
      page, `machines.edit` (planner), rates hidden without `costs.view` (migration 0007, new tables only)
- [x] Machine time per batch on a recipe, in the cost roll-up, as-built record, valuation (dated), margins and margin
      history
- [x] Machine hours of the open builds per machine type, with the machines in service (shortages and Machines pages)
- [x] Record a finished build in one step (one change set)
- [x] CSV: `machine_types.csv`, `machines.csv`, `batch_qty`, `machine` and `machine_minutes` in `assemblies.csv`
- [x] MCP: `list_machines`, `set_assembly_production`, `record_build`, batches and machine time in the read tools;
      skill, examples and an eval; a 3D-printed cable clip in `examples/full`

## M15: Making flow ✅

Making something in-house as one flow, from the part outwards (D153–D157); no schema change.

- [x] Batch size and machine time edited with the lines, on active assemblies too (D153)
- [x] Manufacturing card on a made part's page: assembly, machine time, cost per unit, record or plan a build; create
      the assembly in one click (D154)
- [x] One new build form with a status: completed (recorded now) or planned (D155)
- [x] Production requirements on the Builds page: made parts the open builds need, across levels, in whole batches,
      with machine time; planned builds count as stock to come in the shortages; machine hours in whole batches (D156)
- [x] A machine type and the machines owned in one form (D157)
- [x] Manufacturing vocabulary on the pages (D158)

## M16: Files ✅

CAD models, print files, drawings, instructions and datasheets on parts and assembly revisions (D159–D165).

- [x] `files` table (migration 0008, a new tracked table): a part's own files and each revision's, with a kind, a
      detected format, size, who uploaded it when and a note (D159)
- [x] Objects in the existing optional bucket under `files/`, identical content stored once; removing detaches and
      can be undone; no bucket, no file controls (D160)
- [x] Streamed uploads up to 100 MB (own multipart reader, R2 multipart upload), size checked before reading, from a
      plain form and a tablet (D161)
- [x] STEP, 3MF, STL, PDF, DXF, JPEG, PNG, WebP recognised from their content; SVG, HTML and scripts refused (D162)
- [x] Downloads as attachments with nosniff and a sandbox policy; PDFs and images open inline (D163)
- [x] New revisions and variants copy the files by reference; build pages list the revision's and the part's files
      (D164)
- [x] `files.edit` (planner); `get_part`, `get_assembly` and `get_build` list files over MCP, uploads stay in the app
      (D165)

## M17: Shipments ✅

Carrier and tracking number of the parcels a supplier sent, on the PO, for the whole team (D168).

- [x] `po_shipments` table (migration 0009, a new tracked table): carrier, tracking number, optional tracking link,
      shipping date and notes, one row per parcel
- [x] Shipments card on sent and received POs: planners add, edit and remove; everyone follows the links
- [x] Tracking column on the PO list and the dashboard; a tracking number finds its PO in the searches
- [x] `get_purchase_order` lists shipments; `record_po_shipment` adds or updates one over MCP

## M18: Part options ✅

A part comes in values (a front cover in white or black) counted apart in stock, while it stays one part in the
catalogue and in recipes (D183–D193).

- [x] Options per part, several allowed, on bought and made parts: ordered values, one default; edited on the part
      (migration 0011: `part_options`, `part_option_values`, tracked) (D183)
- [x] A key of value ids on stock moves, as-built lines, PO lines, builds and recipe lines; the integrity a foreign key
      would give checked by the app and by undo (D184)
- [x] Builds choose their product's values; components follow them by option name down the explosion, through
      sub-assemblies built now; a value a component lacks blocks the build (D185)
- [x] Recipe lines per option: follows the build, always one value, or chosen when planned and stored on the build
      (D186, D187)
- [x] Adding an option to a stocked part puts its stock and open orders on the default value (D188)
- [x] Stock, counts, adjustments and valuation per value; a sub-assembly taken from stock must exist in its value
      (D189, D190)
- [x] Shortages, production requirements, draft POs (MOQ per value) and receipts per value; prices stay per part (D191)
- [x] CSV: `part_options.csv` and `options` columns; MCP tools take and return `options` (D192, D193)
- [x] A mini lamp in two colours in `examples/full`

## M19: Storage locations (proposal)

Where each part is kept, drawn on a plan of the workshop, shown wherever someone is about to walk to a shelf
(D194–D200). Built on `feat/storage-locations` to look at; not merged.

- [x] Storage units on a grid plan, with bins from levels × positions; rooms with walls, doors, landmarks
      (migration 0012: `storage_units`, `part_locations`, tracked) (D194, D195)
- [x] Units inside units: a drawer cabinet in a bin of a rack (D199)
- [x] Permissions: operators set locations, planners draw, administrators delete (D196)
- [x] Locations in the sidebar, unit and room pages, plan editor with dragging and a bins preview (D197, D198, D200)
- [x] The location on the part page, pick list, receipt, inventory count and global search (D197)
- [ ] CSV: a `location` column in `parts.csv` and a `storage_units.csv` importer; the plan in `examples/full`
- [ ] MCP: `location` in `get_part`, `search_parts`, `stock_on_hand` and `get_build`, set by `update_part`
- [ ] README and the Kitting skill

## M20: PO charges and landed cost ✅

Shipping, customs and a discount on a purchase order, spread over its lines so receipts enter stock at what the
parts cost to get to the workshop (D201–D205), and POs for any parts over MCP (D206).

- [x] `shipping_cents`, `duties_cents`, `discount_cents` and `charges_spread` on `purchase_orders` (migration 0013),
      editable while the PO is open; totals on the PO page, the PO list and the dashboard's open POs (D201)
- [x] Spread by line value (default), by quantity, or not at all, in cents that add up exactly; receipts at the landed
      unit cost, so the weighted average, valuation and margins include the charges (D202)
- [x] Partial receipts take their share; charges changed later reach only later receipts; the PO shows the charges in
      stock value (D203)
- [x] Prices paid show the supplier's price and the landed cost (D204)
- [x] `update_draft_po` sets the charges; `get_purchase_order` and the PO write tools return them; `receive_po` uses
      the landed cost (D205)
- [x] `create_po` drafts a PO for a supplier with any parts, lines and charges; new PO lines refuse archived parts (D206)

## After v1 (ideas, not planned)

- Shipments, beyond M17: carriers with a tracking URL pattern entered by an administrator (a link from the number
  alone), which receipt came with which shipment.
- Substitute parts: a recipe line that takes one part or another (a 2 GB or a 4 GB board), chosen per build, with
  stock and shortages counted for whichever is chosen.
- A product configurator: choosing a product's values (and its substitutes) on one page with prices, then planning the
  build.
- Part options, beyond M18: a price, standard cost or supplier reference per value; defining options over MCP; a shared
  catalogue of options when many parts repeat the same values.
- MCP: Client ID Metadata Documents (needs the `global_fetch_strictly_public` compatibility flag, D123).
- Serial inventory (which serials are in stock) enforced at build time, if the shop starts scanning receipts.
- Reservations of stock for planned builds; build scheduling.
- PDF purchase orders.
- Product images in the assembly diagram and on build pick lists; a purge of the R2 objects no row references (photos
  orphaned by a restore, removed or replaced files, D160).
- Files, beyond M16: 3D previews in the browser, range requests for large PDFs, files of sub-assemblies built inside a
  build on its page, a copy of a previous revision's files when `assemblies.csv` creates one.
- A "plan all" button on the production requirements (D156 lists what to make; one build per row today, as build numbers are assigned
  one at a time).
- Where-used diagram (the assembly diagram reversed) on the part page; SVG/PDF export of diagrams.
- Choose one valuation method once the accountant decides (D91), and drop the deprecated `parts` supplier columns
  in a planned table rebuild.
- Customer-specific prices, quotes (out of scope for v1).
- History: prune or archive old change sets; undo a whole import from the import page.
- In-house production, beyond M14: mixed plates and co-products (several parts from one run); scrap and yield
  tracking; substitute materials (any colour of filament); counting filament by weighing spools; printer scheduling.
- Machines, beyond M14: several machine steps per recipe (a routing), today one sub-assembly per step; recording
  which machine ran a build (usage per machine); creating and editing machines over MCP; past machine rates entered
  as history (D142 for rates).
