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

- [x] shadcn/ui design system on Tailwind CSS v4 (official skill in `.claude/skills/shadcn`), components ported to Hono JSX
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

## After v1 (ideas, not planned)

- Serial inventory (which serials are in stock) enforced at build time, if the shop starts scanning receipts.
- Reservations of stock for planned builds; build scheduling.
- PDF purchase orders; supplier price history.
- Multi-level "build all missing sub-assemblies" helper from the shortage list.
- Where-used diagram (the BoM diagram reversed) on the part page; SVG/PDF export of diagrams.
- Choose one valuation method once the accountant decides (D91), and drop the deprecated `parts` supplier columns
  in a planned table rebuild.
- Customer-specific prices, quotes (out of scope for v1).
