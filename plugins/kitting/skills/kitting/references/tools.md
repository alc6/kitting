# Kitting MCP tools

Every tool the Kitting server can offer, by scope. A tool is listed only when the connection was granted its
scope AND the user's role allows its permission. A tool you do not see is a tool this user cannot use: say which
scope or role it needs (below) instead of working around it.

Roles, lowest to highest: viewer, operator, planner, admin. Permission minimums: `builds.plan`, `builds.complete`,
`stock.adjust`, `stock.count`, `purchasing.receive` need operator; `parts.edit`, `suppliers.edit`, `boms.edit`,
`prices.edit`, `purchasing.order` need planner; `parts.archive`, `boms.archive` need admin. Reading is open to every
listed user, but costs need planner (or the cost option set on the Users page).

## Conventions

- **Decimals.** Quantities and amounts go in and come out as decimal strings (`"1.5"`, `"12.30"`); numbers are
  accepted on input. At most 3 decimals for quantities, 2 for amounts. Results use the same strings, with the
  integer suffixes dropped (`on_hand`, `unit_cost`).
- **References and numbers are case-insensitive**: part refs (`lamp-desk`), supplier names, build numbers
  (`b-0001`), PO numbers.
- **Selecting a BoM** (`get_bom`, `explode_bom`, `set_bom_lines`, `new_bom_revision`, `activate_bom`,
  `archive_bom`): `bom` is a BoM id (number) or the reference of the part it builds (its active BoM), plus an
  optional `code` (variant, default `std`, else the only active one) and an optional `revision` (any status).
- **Every write result** carries `change_set_id`, `revertible`, an `undo` sentence and, only when it can be undone,
  `history_path` and `history_url` (the page where the user clicks Undo). A call that changes nothing records
  nothing (`change_set_id: null`, `undo` says so). You cannot undo anything yourself.
- **Ledger writes** (`adjust_stock`, `count_stock`, `complete_build`, `receive_po`) return `revertible: false` and no
  link: they are corrected with reverse moves (`adjust_stock`), never undone.
- **Refusals.** A rejected write says `Refused, nothing was changed.` followed by one `field: message` per problem
  (every problem at once; nothing is written). Lookups fail with `No part with reference "X". Use search_parts to
  find it.` (same for BoMs, builds, POs, suppliers). A call the user's role forbids answers `Refused: your role
  (...) does not allow <tool>`; a scope the connection lacks answers `This connection was not granted <scope>`.
- **Costs hidden.** When the user may not see costs, every amount is left out of the result and it says
  `costs_hidden: true`. Never guess an amount.
- **Lists** have `limit` and say `truncated: true` when there is more; narrow the query instead of paging blindly.
- A result key named after a quantity (`qty`, `on_hand`, `short`) is in the part's unit.

## Reading: `catalog:read`

### `search_parts`
Find parts by reference, name or any supplier's reference. Use it before relying on any reference.
- **Scope:** `catalog:read` · **Permission:** none (every listed user)
- **Inputs:** `query` (text; omit to list all), `kind` (buy, make, kit or fee), `include_archived` (default false), `limit` (default 50, max 500).
- **Returns:** `count`, `truncated`, `parts[]` with `ref`, `name`, `kind`, `unit`, `on_hand`, `preferred_supplier`, `standard_cost`, `track_serial`, `archived`.
- **Example:** `search_parts({ "query": "felt" })`

### `get_part`
One part in full: details, prices, supplier offers (preferred first), on hand, its BoMs with unit cost, and where it is used.
- **Scope:** `catalog:read` · **Permission:** none
- **Inputs:** `ref` (part reference).
- **Returns:** `part` (`ref`, `name`, `kind`, `unit`, `track_serial`, `archived`, `notes`, `on_hand`, `standard_cost`, `sale_price`), `offers[]` (`supplier`, `preferred`, `supplier_ref`, `price`, `moq`, `pack_size`, `lead_days`), `boms[]` (`bom_id`, `code`, `revision`, `status`, `unit_cost`, `cost_incomplete`, `sale_price`), `rolled_up_cost`, `where_used[]` (`parent`, `bom_id`, `code`, `revision`, `status`, `depth`, `via`, `qty_per_parent`).
- **Example:** `get_part({ "ref": "PAD-FELT" })`

### `get_bom`
The structure of a BoM as a tree with cost roll-up. Kits and sub-assemblies are expanded through their active BoMs.
- **Scope:** `catalog:read` · **Permission:** none
- **Inputs:** `bom`, `code`, `revision` (selector), `qty` (how many to build, default 1).
- **Returns:** `bom` (`bom_id`, `part`, `code`, `revision`, `status`), `qty`, `cost` (`unit_cost`, `total_cost`, `incomplete`, `missing_costs`), `lines[]` as a tree: `ref`, `kind`, `per_parent`, `qty` (cumulative), `mode`, `unit_cost`, `extended_cost`, `cost_incomplete`, `children`.
- **Example:** `get_bom({ "bom": "LAMP-DESK", "code": "warm", "qty": 3 })`

### `explode_bom`
The flat list of components needed for a quantity, with on hand and shortfall. Fee lines are listed apart (cost only).
- **Scope:** `catalog:read` · **Permission:** none
- **Inputs:** `bom`, `code`, `revision` (selector), `qty` (required), `use_stock` (take sub-assemblies already in stock instead of building them; default false).
- **Returns:** `bom`, `qty`, `use_stock`, `components[]` (`ref`, `name`, `kind`, `unit`, `qty`, `on_hand`, `short`, `missing_bom`, `unit_cost`, `extended_cost`), `fees[]`, `total_cost`, `cost_incomplete`.
- **Example:** `explode_bom({ "bom": "LAMP-DESK", "code": "warm", "qty": 3, "use_stock": true })`

### `list_recent_changes`
The change history (who, when, from where, which rows and fields before/after), as on the Recent changes page.
- **Scope:** `catalog:read` · **Permission:** none
- **Inputs:** `source` (ui, import, mcp, revert, migration), `user` (email), `query` (text in summaries), `from`, `to` (YYYY-MM-DD), `before` (a change id, for the next page), `include_fields` (default true), `limit` (default 20, max 100).
- **Returns:** `count`, `next_before`, `changes[]` (`id`, `at`, `user`, `source`, `client`, `summary`, `revertible`, `undone_by`, `history_path`, `history_url`, `rows_touched`, `changes[]` with `table`, `op`, `record`, `fields[]` of `field`, `before`, `after`; a hidden amount is `{ field, hidden: true }`).
- **Example:** `list_recent_changes({ "source": "mcp", "limit": 5 })`

## Reading: `stock:read`

### `stock_on_hand`
On-hand quantities of stocked parts (buy and make; kits and fees are never stocked).
- **Scope:** `stock:read` · **Permission:** none
- **Inputs:** `query`, `filter` (all, below_zero, below_moq, in_stock; default all), `limit` (default 100, max 1000).
- **Returns:** `filter`, `count`, `truncated`, `parts[]` (`ref`, `name`, `kind`, `unit`, `on_hand`, `moq`, `preferred_supplier`).
- **Example:** `stock_on_hand({ "filter": "below_moq" })`

### `list_moves`
The stock ledger, newest first. On hand is the sum of the signed moves.
- **Scope:** `stock:read` · **Permission:** none
- **Inputs:** `query` (part refs, names, serials, notes), `reason` (receipt, build_consume, build_output, adjust or count), `from`, `to`, `limit` (default 100, max 500).
- **Returns:** `count`, `moves[]` (`at`, `ref`, `name`, `unit`, `qty` signed, `reason`, `serial`, `unit_cost`, `source`, `note`, `by`).
- **Example:** `list_moves({ "query": "LED-5W-CW", "limit": 20 })`

## Reading: `builds:read`

### `list_builds`
Builds (production orders), newest first. The query also matches the serials of consumed components: use it to find which build used a serial.
- **Scope:** `builds:read` · **Permission:** none
- **Inputs:** `query` (build number, product serial, part ref or name, component serial), `status` (open, all, planned, in_progress, done, cancelled; default open, or all when a query is given), `limit` (default 50, max 500).
- **Returns:** `status`, `count`, `builds[]` (`number`, `status`, `part`, `name`, `unit`, `qty`, `serial`, `bom`, `planned_for`, `done_at`).
- **Example:** `list_builds({ "query": "CW-24-0003" })`

### `get_build`
One build. Done: the as-built record. Open: the pick list from current stock.
- **Scope:** `builds:read` · **Permission:** none
- **Inputs:** `number` (e.g. `B-0001`).
- **Returns:** `build` (`number`, `status`, `part`, `qty`, `serial`, `bom`, `planned_for`, `done_at`). Done: `as_built[]` (`ref`, `qty`, `serial`, `unit_cost` frozen, `made_by_build`), `total_cost`. Open: `pick_list[]` (`ref`, `qty`, `on_hand`, `short`, `serials_to_scan` count to give), `sub_assemblies[]` (`ref`, `path`, `qty`, `from_stock`, `to_build`), `fees`, `problems` (what blocks completion).
- **Example:** `get_build({ "number": "B-0001" })`

## Reading: `purchasing:read`

### `get_shortages`
What to buy for all planned and in-progress builds: need minus on hand minus on order, rounded up to the preferred supplier's MOQ and pack size, grouped by supplier.
- **Scope:** `purchasing:read` · **Permission:** none
- **Inputs:** none.
- **Returns:** `open_builds`, `suppliers[]` (`supplier`, `total`, `lines[]` with `ref`, `unit`, `need`, `on_hand`, `on_order`, `net`, `order`, `unit_price`, `supplier_ref`, `moq`, `pack_size`, `lead_days`, `builds`), `missing_boms[]` (make or kit parts to build that have no active BoM).
- **Example:** `get_shortages({})`

### `list_purchase_orders`
Purchase orders, newest first.
- **Scope:** `purchasing:read` · **Permission:** none
- **Inputs:** `query` (PO number, supplier name), `status` (open, all, draft, sent, partial, received, cancelled; default open), `limit` (default 50, max 500).
- **Returns:** `status`, `count`, `truncated`, `purchase_orders[]` (`number`, `status`, `supplier`, `created_at`, `sent_at`, `expected_at`, `lines`, `total`).
- **Example:** `list_purchase_orders({ "status": "sent" })`

### `get_purchase_order`
One PO with its lines.
- **Scope:** `purchasing:read` · **Permission:** none
- **Inputs:** `number` (e.g. `PO-0001`).
- **Returns:** `purchase_order` (`number`, `status`, `supplier`, `expected_at`, `notes`), `lines[]` (`ref`, `qty`, `received`, `remaining`, `unit_price`, `line_total`), `total`.
- **Example:** `get_purchase_order({ "number": "PO-0001" })`

## Writing the catalogue: `catalog:write`

### `create_part`
Creates a part. Prices and offers are separate calls.
- **Scope:** `catalog:write` · **Permission:** `parts.edit` (planner)
- **Inputs:** `ref` (unique, letters, digits and `- _ . /`), `name`, `kind` (buy, make, kit, fee), `unit` (default pcs), `track_serial` (buy and make only), `notes`.
- **Returns:** the write envelope and `part`.
- **Example:** `create_part({ "ref": "PAD-RUBBER", "name": "Rubber pad 20mm", "kind": "buy" })`

### `update_part`
Changes a part's fields; fields left out keep their value. Never prices.
- **Scope:** `catalog:write` · **Permission:** `parts.edit` (planner)
- **Inputs:** `ref`, `new_ref`, `name`, `kind`, `unit`, `track_serial`, `notes`. A part with stock moves cannot become a kit or fee; a part with BoMs stays make or kit.
- **Returns:** the write envelope and `part`.
- **Example:** `update_part({ "ref": "PAD-FELT", "notes": "Self-adhesive" })`

### `create_supplier`
- **Scope:** `catalog:write` · **Permission:** `suppliers.edit` (planner)
- **Inputs:** `name` (new, case-insensitive), `email`, `phone`, `notes`.
- **Returns:** the write envelope and `supplier`.
- **Example:** `create_supplier({ "name": "Acme Fasteners", "email": "orders@example.com" })`

### `update_supplier`
- **Scope:** `catalog:write` · **Permission:** `suppliers.edit` (planner)
- **Inputs:** `name` (current), `new_name`, `email`, `phone`, `notes`; fields left out keep their value.
- **Returns:** the write envelope and `supplier`.
- **Example:** `update_supplier({ "name": "Acme Fasteners", "phone": "+1 555 0123" })`

### `create_bom`
Creates a draft BoM for a make or kit part, empty or copied from another BoM. Then `set_bom_lines`, then `activate_bom`.
- **Scope:** `catalog:write` · **Permission:** `boms.edit` (planner)
- **Inputs:** `part`, `code` (default std), `revision` (default Rev1), `notes`, `copy_from` (a BoM selector).
- **Returns:** the write envelope, `bom` (`bom_id`, `part`, `code`, `revision`, `status`), `lines`.
- **Example:** `create_bom({ "part": "LAMP-DESK", "code": "compact", "copy_from": { "bom": "LAMP-DESK" } })`

### `set_bom_lines`
Replaces every line of a BoM at once, in order, with the editor's checks (known part, not archived, whole units for serial-tracked parts, no cycle). Nothing changes if one line is refused. An active BoM is never edited: the next revision is created as a draft (with the active one's notes, lines replaced by yours) and the active BoM stays as it is. Archived BoMs are read-only.
- **Scope:** `catalog:write` · **Permission:** `boms.edit` (planner)
- **Inputs:** `bom`, `code`, `revision` (selector), `lines[]` of `ref`, `qty`, `notes` (1 to 500 lines). Send the complete list, not a delta.
- **Returns:** the write envelope, `bom` (the one that was edited), `new_revision` (true when a draft revision was created), `active_bom` (then), `note`, `lines`.
- **Example:** `set_bom_lines({ "bom": "BASE-ASSY", "lines": [{ "ref": "BASE-PLATE", "qty": 1 }, { "ref": "PAD-FELT", "qty": 6 }] })`

### `new_bom_revision`
Copies a BoM (any status) with its lines into the next draft revision of the same part and code. The original is not changed.
- **Scope:** `catalog:write` · **Permission:** `boms.edit` (planner)
- **Inputs:** `bom`, `code`, `revision` (selector).
- **Returns:** the write envelope, `bom` (new draft), `from`, `lines`.
- **Example:** `new_bom_revision({ "bom": "BASE-ASSY" })`

### `activate_bom`
Makes a draft or archived BoM the active one of its part and code: builds and explosions use it from now on. The previously active revision is archived (it can be activated again). Refused if it would create a cycle.
- **Scope:** `catalog:write` · **Permission:** `boms.edit` (planner)
- **Inputs:** `bom`, `code`, `revision` (selector; give the revision, or the BoM id).
- **Returns:** the write envelope, `bom`, `archived[]` (the revisions it replaced). Already active: nothing changes.
- **Example:** `activate_bom({ "bom": "BASE-ASSY", "revision": "Rev2" })`

## Writing prices: `prices:write`

### `set_standard_cost`
A part's standard cost: the unit cost used in roll-ups, valuations and planned margins. Appended to the price history.
- **Scope:** `prices:write` · **Permission:** `prices.edit` (planner)
- **Inputs:** `ref`, `cost` (amount, at most 2 decimals; null clears it), `note` (kept in the price history).
- **Returns:** the write envelope, `part`, `standard_cost`, `previous_standard_cost`.
- **Example:** `set_standard_cost({ "ref": "PAD-FELT", "cost": "0.06", "note": "2026 price list" })`

### `set_sale_price`
The selling price of a part, or of one BoM variant (`code`, plus `revision` when not the active one), which overrides the part's price for that variant.
- **Scope:** `prices:write` · **Permission:** `prices.edit` (planner)
- **Inputs:** `ref`, `price` (null clears it), `code`, `revision` (needs `code`).
- **Returns:** the write envelope, `part`, `bom` (for a variant), `sale_price`, `previous_sale_price`.
- **Example:** `set_sale_price({ "ref": "LAMP-DESK", "price": "94.00", "code": "warm" })`

### `upsert_supplier_offer`
Creates or edits a supplier's offer for a buy or make part (fields left out keep their value). `preferred: true` makes that supplier the preferred one, which shortages and draft POs use; `false` never removes the preference. `set_standard_cost: true` also makes the price the standard cost.
- **Scope:** `prices:write` · **Permission:** `prices.edit` (planner)
- **Inputs:** `ref`, `supplier` (name), `supplier_ref`, `price`, `moq`, `pack_size`, `lead_days`, `notes`, `preferred`, `set_standard_cost`.
- **Returns:** the write envelope, `created`, `part`, `offer` (`supplier`, `preferred`, `supplier_ref`, `price`, `moq`, `pack_size`, `lead_days`), `standard_cost`.
- **Example:** `upsert_supplier_offer({ "ref": "PAD-FELT", "supplier": "Bolt & Nut Depot", "price": "0.06", "moq": "500", "preferred": true })`

## Archiving: `catalog:archive`

Archiving hides; nothing is deleted over MCP, and unarchiving brings it back.

### `archive_part`
The part disappears from lists and pickers (new BoM lines, POs); stock, BoMs, builds and history stay.
- **Scope:** `catalog:archive` · **Permission:** `parts.archive` (admin)
- **Inputs:** `ref`.
- **Returns:** the write envelope and `part`.
- **Example:** `archive_part({ "ref": "PAD-FELT" })`

### `unarchive_part`
- **Scope:** `catalog:archive` · **Permission:** `parts.archive` (admin)
- **Inputs:** `ref`.
- **Returns:** the write envelope and `part`.
- **Example:** `unarchive_part({ "ref": "PAD-FELT" })`

### `archive_bom`
A revision becomes read-only and unused by builds and explosions. Archiving the active one leaves its part and code with no active BoM until another is activated. `activate_bom` brings one back.
- **Scope:** `catalog:archive` · **Permission:** `boms.archive` (admin)
- **Inputs:** `bom`, `code`, `revision` (selector).
- **Returns:** the write envelope and `bom`.
- **Example:** `archive_bom({ "bom": "LAMP-DESK", "revision": "Rev1" })`

## Writing stock: `stock:write`

Both tools write the append-only ledger. They cannot be undone: a mistake is corrected with the opposite adjustment.

### `adjust_stock`
A signed adjustment of a buy or make part, valued at its standard cost, with a required note.
- **Scope:** `stock:write` · **Permission:** `stock.adjust` (operator)
- **Inputs:** `ref`, `qty` (signed, never 0), `serial` (for one unit of a serial-tracked part: qty is 1 or -1), `note` (why).
- **Returns:** the write envelope, `part`, `unit`, `qty`, `serial`, `on_hand` (after).
- **Example:** `adjust_stock({ "ref": "SCREW-M3X8", "qty": "-12", "note": "Scrapped: dropped on the floor" })`

### `count_stock`
Posts counted quantities: for each part one count move for the difference with the current on hand (nothing when already right). Only the listed parts are touched.
- **Scope:** `stock:write` · **Permission:** `stock.count` (operator)
- **Inputs:** `counts[]` of `ref`, `qty` (counted, 0 or more; each part once), `note`.
- **Returns:** the write envelope, `adjusted`, `counts[]` (`ref`, `previous`, `counted`, `adjustment`).
- **Example:** `count_stock({ "counts": [{ "ref": "PAD-FELT", "qty": "380" }], "note": "Monthly count" })`

## Builds: `builds:write`

### `plan_build`
Plans a build of a make part from one of its active BoMs. A serial-tracked product is built one unit at a time with its own serial.
- **Scope:** `builds:write` · **Permission:** `builds.plan` (operator)
- **Inputs:** `ref`, `qty` (default 1), `code` (variant), `serial`, `planned_for` (date), `notes`.
- **Returns:** the write envelope and `build` (`number`, `status`, `part`, `qty`, `serial`, `bom`, `planned_for`).
- **Example:** `plan_build({ "ref": "LAMP-DESK", "code": "warm", "serial": "L-0100", "planned_for": "2026-11-02" })`

### `complete_build`
Records a planned or in-progress build as done: components are consumed, the product is added, and the as-built record keeps every serial and frozen unit cost. Refused, with every reason, when a serial is missing or repeated, a sub-assembly to build has no active BoM, or the product needs a serial. Writes the ledger: cannot be undone.
- **Scope:** `builds:write` · **Permission:** `builds.complete` (operator)
- **Inputs:** `number`, `serials[]` of `ref` and `serials` (one per unit of each serial-tracked component; the count is `serials_to_scan` in `get_build`), `sub_assemblies[]` of `ref` (every place the part appears) or `path` (one place, from `get_build`) and `mode` (stock or build). Without a choice, a sub-assembly comes from stock when there is enough, else it is built now.
- **Returns:** the write envelope, `build` (done), `as_built[]`.
- **Example:** `complete_build({ "number": "B-0001", "serials": [{ "ref": "LED-5W-WW", "serials": ["WW-24-0001"] }, { "ref": "DRV-12V", "serials": ["DRV-7A-101"] }], "sub_assemblies": [{ "ref": "ARM-ASSY", "mode": "stock" }] })`

### `cancel_build`
Cancels a planned or in-progress build: nothing was consumed, and its serial becomes free. A done build cannot be cancelled.
- **Scope:** `builds:write` · **Permission:** `builds.plan` (operator)
- **Inputs:** `number`.
- **Returns:** the write envelope and `build`.
- **Example:** `cancel_build({ "number": "B-0002" })`

## Purchasing: `purchasing:write`

### `create_draft_pos`
Turns the current shortages into draft POs, one per supplier, each line rounded up to MOQ and pack size and priced at the offer (else the standard cost). Drafts are not sent.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.order` (planner)
- **Inputs:** `suppliers[]` (only these groups; default all), `order_from[]` of `ref` and `supplier` (order a short part from another supplier that has an offer for it; parts with no preferred supplier are drafted only this way).
- **Returns:** the write envelope and `purchase_orders[]` (each with `lines` and `total`), or "Nothing to order."
- **Example:** `create_draft_pos({ "suppliers": ["Bolt & Nut Depot"] })`

### `update_draft_po`
Edits a PO: expected date and notes (any open PO) and the lines of a draft. A line sets the quantity of a part: existing is changed, a new part is added, `"0"` removes it. Lines of a sent PO cannot change.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.order` (planner)
- **Inputs:** `number`, `expected_at` (date or null), `notes`, `lines[]` of `ref`, `qty`, `price`.
- **Returns:** the write envelope, `purchase_order`, `lines`, `total`.
- **Example:** `update_draft_po({ "number": "PO-0002", "expected_at": "2026-11-10", "lines": [{ "ref": "PAD-FELT", "qty": "1000" }] })`

### `mark_po_sent`
Marks a draft as sent. Kitting sends nothing itself: the user sends the order to the supplier. Lines freeze; it then waits for `receive_po`.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.order` (planner)
- **Inputs:** `number`.
- **Returns:** the write envelope, `purchase_order`, `lines`, `total`.
- **Example:** `mark_po_sent({ "number": "PO-0002" })`

### `receive_po`
Records goods received, per part, optionally with one serial per unit. Stock goes up at the PO's price; the PO becomes partial or received. More deliveries can follow. Writes the ledger: cannot be undone.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.receive` (operator)
- **Inputs:** `number`, `lines[]` of `ref`, `qty` (received now), `serials`.
- **Returns:** the write envelope, `received[]`, `purchase_order`, `lines`, `total`.
- **Example:** `receive_po({ "number": "PO-0001", "lines": [{ "ref": "LED-5W-WW", "qty": "10", "serials": ["WW-24-0101", "WW-24-0102"] }] })`

### `cancel_po`
Cancels a draft or sent PO that received nothing. A partly received PO is closed instead.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.order` (planner)
- **Inputs:** `number`.
- **Returns:** the write envelope, `purchase_order`, `lines`, `total`.
- **Example:** `cancel_po({ "number": "PO-0003" })`

### `close_po`
Closes a sent or partly received PO whose remaining quantities will not come: they are no longer on order. Nothing moves in stock.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.order` (planner)
- **Inputs:** `number`.
- **Returns:** the write envelope, `purchase_order`, `lines`, `total`.
- **Example:** `close_po({ "number": "PO-0001" })`
