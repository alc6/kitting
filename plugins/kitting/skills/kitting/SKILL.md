---
name: kitting
description: Work with a Kitting mini-MRP through its MCP tools - parts and references, assemblies (bills of materials, BoMs, nomenclatures, kits, variants, revisions), stock and inventory counts, builds (production, fabrication, serial numbers and traceability), shortages (manquants) and what to order, purchase orders (commandes fournisseur), supplier offers, costs, prices and margins. Use whenever the user talks about making, buying or counting parts, planning or completing a build, changing an assembly, a BoM or a nomenclature, receiving a delivery, or tracing a serial, in English or French (fabrication, stock, achats, commande, prix de revient, marge).
---

# Kitting

Kitting is a small manufacturer's MRP. You reach it through MCP tools (the Kitting connector). Everything you do
is made in the user's name, with their role, and recorded in Recent changes. This skill is the know-how: how
the data fits together, which tools to chain, and how to stay safe. Exact inputs and outputs of every tool are
in [references/tools.md](references/tools.md); English/French vocabulary in [references/glossary.md](references/glossary.md);
worked conversations in [references/examples.md](references/examples.md).

## Domain primer

- **Part** (`ref`, case-insensitive) has a **kind**:
  - `buy`: purchased, stocked.
  - `make`: built from an assembly, stocked (a sub-assembly or a finished product).
  - `kit`: a **phantom** part. It has an assembly but is never stocked, built or bought: it is always exploded into
    its parent, and may nest inside other kits. Never plan a build, count or order for a kit.
  - `fee`: cost only (an eco-fee, a service). Never stocked, never ordered.
- **Unit**: quantities are in the part's unit (`pcs`, `m`, `kg`). Decimals go in and out as strings, at most 3
  decimals for quantities and 2 for amounts.
- **Assembly (bill of materials, BoM, nomenclature)**: the lines (component and quantity) of one make or kit part. A part can have several
  **variants** (`code`, e.g. `std`, `warm`), each with **revisions** (`Rev1`, `Rev2`...). A revision is `draft`
  (editable, not used), `active` (the one builds and explosions use; one per part and code) or `archived`
  (read-only history, can be re-activated). Select an assembly with `assembly` (an id, or the part ref for its active assembly)
  and optionally `code` and `revision`.
- **Batches**: an assembly can make several units at once (`batch`, e.g. 24 parts per print plate); its lines are then
  the quantities for the whole batch, and a build of any quantity takes line × quantity / batch (rounded up). Plan in
  batches with `plan_build`'s `batches`. The batch belongs to a revision: change it with `set_assembly_production`,
  which on an active assembly creates a draft revision, like `set_assembly_lines`.
- **Machines**: a recipe can take machine time per batch (`machine_minutes`, e.g. 190 for 3 h 10) on a **machine type**
  (an FDM printer) that carries the hourly rate; the machines themselves (PRINTER-1, PRINTER-2) belong to a type and
  are in service, under maintenance or retired. Machine time is costed like a component, and `machine_time` in
  results is in minutes: say it as hours and minutes.
- **Stock** is a ledger: on hand is the sum of signed moves (receipts, build consumption and output,
  adjustments, counts). Nothing edits a move; mistakes are corrected with new moves. Stock can go negative; that
  is a signal (`stock_on_hand` with `below_zero`).
- **Builds** consume components and add the product. Number `B-0001`. Statuses: planned, in progress, done,
  cancelled. A done build keeps an **as-built record** with the serial and frozen unit cost of every component.
- **Serials**: parts with `track_serial` carry one serial per unit, from the receipt (or adjustment) through the
  build that consumes it to the finished product. That chain is the traceability.
- **Files**: a part and each assembly revision can carry files (CAD model, print file, drawing, instructions,
  datasheet, other). A part's own files (a datasheet, a drawing for the supplier) are in `get_part`; a revision's
  (the 3MF of a plate, the assembly guide) in `get_assembly`; a build's page lists both (`get_build`). Give the user
  the `download_url`: it opens in the app, you cannot download it. Uploading, renaming or removing files is done in
  the app only.
- **Purchase orders** `PO-0001`: draft, sent, partial, received, cancelled. Kitting does not email suppliers:
  "sent" means the user sent it.
- **Costs** (standard cost, roll-ups, prices, margins) may be hidden for the user's role: the result then says
  `costs_hidden: true` and has no amounts. Never estimate one.
- **Roles and scopes.** Roles: viewer < operator < planner < admin. A tool exists for you only if the connection
  was granted its scope AND the user's role allows it (table in [references/tools.md](references/tools.md)).
  Operators: stock, builds, receiving. Planners: catalogue, prices, ordering. Admins: archiving.

## Safety rules (always)

1. **Read before you write.** Look up the part, assembly, build or PO first. **Never invent a reference**: use
   `search_parts` (or `list_builds`, `list_purchase_orders`) and use exactly what comes back. If nothing matches,
   ask; do not guess a close one.
2. **Confirm every write.** Before any tool that changes data, say in a few lines what will change (records,
   quantities, prices) and wait for a clear yes. A batch needs one confirmation for the whole batch, listing it.
3. **Prefer drafts.** Draft POs before sending, a draft assembly revision before activating. Activation, sending,
   receiving and completing are separate steps, each confirmed.
4. **Report what happened.** After a write, say what changed, quote the change number, and give the undo link
   (`history_url`) when `revertible` is true. For ledger writes (`adjust_stock`, `count_stock`, `complete_build`,
   `record_build`, `receive_po`) there is no link: say they cannot be undone and are corrected with a reverse
   adjustment.
   You cannot undo anything yourself.
5. **Archive, never delete.** There is no delete over MCP. Use `archive_part` / `archive_assembly` (reversible).
6. **A refusal is information.** `Refused, nothing was changed...` lists every problem; fix them and ask again,
   or tell the user. A missing tool, `Refused: your role (...)` or `This connection was not granted <scope>`:
   explain which scope or role is needed (see the table in [references/tools.md](references/tools.md)) and who
   can grant it (an admin on the Users page; the user reconnects the app and ticks the scope). Do not work around
   it by another tool or by asking the user to paste data.
7. **Hidden costs stay hidden.** Do not compute margins or totals from guesses when `costs_hidden` is true.
8. **Quantities are exact.** Echo quantities and units back in confirmations; never round a number the user gave.

## Workflows

### Plan a build, order what is missing, receive
1. `search_parts` the product; `get_part` to see its assemblies (variants) and which one is active.
2. `explode_assembly` with the quantity (and `use_stock: true` to count ready sub-assemblies) to see needs, on hand and
   `short`. Mention `cost_incomplete` / `missing_costs` if present.
3. Confirm, then `plan_build` (one call per build; a serial-tracked product is built one unit at a time with its
   own `serial`, so ask for each serial).
4. `get_shortages`: first `to_make` (sub-assemblies and printed parts the builds need, deepest first, in whole runs,
   with machine time: offer to `plan_build` them, or `record_build` once made), then what to buy for all open builds,
   grouped by supplier, rounded to MOQ and pack size (it counts what is already on order and what planned builds
   will make). Show it with lead times; flag `missing_assemblies`.
5. Confirm, then `create_draft_pos` (all suppliers, or `suppliers` to limit; `order_from` to use another
   supplier that has an offer). Review with `get_purchase_order`; adjust with `update_draft_po` (quantity `"0"`
   removes a line).
6. When the user has sent the order to the supplier: confirm, then `mark_po_sent`.
7. Goods arrive: ask what was received, for serial-tracked parts which serials, confirm, then `receive_po`
   (partial deliveries are fine; `close_po` if the rest will never come, `cancel_po` if nothing came).

### Complete a build
1. `get_build` for the number: the pick list (`pick_list` with `short`), `serials_to_scan` per serial-tracked
   component, `sub_assemblies` (each with a `path`, how many are `from_stock` or `to_build`), and `problems`.
2. If something is short, say so and offer `get_shortages` / a PO. Do not complete over a shortage without the
   user's explicit decision (stock would go negative).
3. Ask for the serials (one per unit per serial-tracked component; `list_moves` with the part ref shows the
   serials received and consumed) and the sub-assembly choice (take from stock or build now) if the default
   (stock when enough, else build) is not what they want.
4. Confirm the summary: product, quantity, serials, sub-assembly choices. Then `complete_build`. This cannot be
   undone. Report the as-built record.
5. A mistaken plan before completion: `cancel_build` (frees the serial).

### Record a run that is already done
When the user reports production after the fact ("we printed 2 plates of clips this morning"), use `record_build`:
it plans and completes in one step, now. Check the part and its batch first (`get_assembly`), confirm product,
quantity (`batches` or `qty`) and that it cannot be undone, then call it and report the as-built record and the
machine time. It is refused when serial-tracked components need serials: then `plan_build` and `complete_build`
with the serials.

### Find the file to print or assemble
"Which file do I print for B-0042?" or "Where is the drawing of the bracket?": `get_build` lists the files of the
revision being built, then the part's own; otherwise `get_assembly` (the active revision, or `revision`) or `get_part`.
Name the file, its kind and when it was uploaded, and give its `download_url`. A new revision starts with the files of
the one it came from, so an older revision may still hold an older file: say which revision a file belongs to.

### Inventory count
1. `stock_on_hand` (filter or `query`) for the parts to count; the user gives the counted quantities.
2. Show the differences you would post (counted minus on hand, per part). Only listed parts are touched.
3. Confirm, then `count_stock` with a `note` (e.g. "Monthly count"). Not undoable; a wrong count is fixed by
   another count. For one-off finds or scrap use `adjust_stock` (signed quantity, required note).

### Change an assembly safely
1. `search_parts` / `get_part` for the part: its assemblies, which is active, and `where_used` (everything that
   contains it, directly or through sub-assemblies). When the changed part is a sub-assembly or kit, tell the
   user which products this affects.
2. `get_assembly` on the active assembly, so you edit from the real lines.
3. Propose the complete new line list. Confirm. Then `set_assembly_lines` with the **complete** list (it replaces all
   lines). On an active assembly this does not touch it: it creates the next draft revision and puts the lines there
   (the result says `new_revision: true`). Need a new component first? `create_part` (and `upsert_supplier_offer`).
4. Review the draft: `get_assembly` with `revision` and `explode_assembly`; compare the cost with the active revision (if
   costs are visible) and say what changed.
5. Only after the user confirms again: `activate_assembly` on the draft. The old revision is archived and can be
   activated again. Builds planned earlier keep their assembly.
6. Never activate in the same breath as editing. Offer `archive_assembly` only for revisions no longer wanted.

### Update prices and supplier offers
- Standard cost (roll-ups, valuation): `set_standard_cost`. Selling price: `set_sale_price` (per part, or per
  variant with `code` which overrides the part's price). Supplier terms (price, MOQ, pack size, lead time,
  reference, preferred): `upsert_supplier_offer`; `preferred: true` changes who shortages and drafts use;
  `set_standard_cost: true` also takes the price as standard cost.
- Check current values with `get_part` first and show before/after in the confirmation. Prices need the
  `prices:write` scope and a planner role.

### Retire a part or assembly
`get_part` → check `where_used` and stock → confirm → `archive_part` (or `archive_assembly`). Say it is reversible
(`unarchive_part`, `activate_assembly`). Never offer deletion.

### Trace a serial
- **What is inside lamp serial X?** `list_builds` with `query: "X"` finds the build that made it; `get_build` on
  that number returns `as_built`: every component with its serial and frozen cost, and `made_by_build` for
  serial sub-assemblies. Follow `made_by_build` to open the sub-assembly's build the same way.
- **Where did component serial Y go?** `list_builds` with `query: "Y"` also matches consumed component serials;
  `get_build` shows which product serial it ended in. `list_moves` with the serial shows its receipt (and which
  PO) and any adjustment.
- **A faulty batch: which other products used it?** Kitting has no lot field: a batch is the serials received
  together. `list_moves` with the faulty serial shows its receipt (its `source` names the PO); `list_moves` for
  the same part around that date lists the other serials received with it. Query each with `list_builds` to
  find the builds (and product serials) that consumed them, and report open builds that still hold some in
  stock.

### Machine time and printer hours
- **How many printer hours do my plans need?** `get_shortages` gives `machine_time` per machine type for all open
  builds (sub-assemblies taken from stock need none) with `active_machines`; divide to say how long each machine in
  service is busy. `list_machines` lists the types, their rate and their machines.
- **A recipe from the slicer** ("24 clips, 260 g, 3 h 10"): the lines are the plate's quantities, `batch_qty` 24,
  `machine_type` and `machine_minutes` 190, set with `set_assembly_lines` and `set_assembly_production` on a draft
  (each creates the draft revision from an active one), then `activate_assembly` after the user confirms.
- Machines and their rates are managed in the app (Machines page), not over MCP.

### Margins and cost questions
`get_part` gives standard cost, sale price, assembly unit cost and `rolled_up_cost` (with `missing_costs`: parts with
no cost, which make the roll-up incomplete). `get_assembly` / `explode_assembly` give extended costs for a quantity. If
`costs_hidden` is true, say you cannot see costs with this role.

## Style

Answer in the user's language (the data is in whatever language the workshop uses). Use the part refs as keys,
with names for readability. Keep tables short; lead with the answer, then the numbers. Ask one question at a
time when information is missing. See [references/examples.md](references/examples.md) for the expected flow.
