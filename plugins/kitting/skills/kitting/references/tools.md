# Kitting MCP tools

Every tool the Kitting server can offer, by scope. A tool is listed only when the connection was granted its
scope AND the user's role allows its permission. A tool you do not see is a tool this user cannot use: say which
scope or role it needs (below) instead of working around it.

Roles, lowest to highest: viewer, operator, planner, admin. Permission minimums: `builds.plan`, `builds.complete`,
`stock.adjust`, `stock.count`, `purchasing.receive` need operator; `parts.edit`, `suppliers.edit`, `assemblies.edit`,
`prices.edit`, `purchasing.order` need planner; `parts.archive`, `assemblies.archive` need admin. Reading is open to every
listed user, but costs need planner (or the cost option set on the Users page).

## Conventions

- **Decimals.** Quantities and amounts go in and come out as decimal strings (`"1.5"`, `"12.30"`); numbers are
  accepted on input. At most 3 decimals for quantities, 2 for amounts. Results use the same strings, with the
  integer suffixes dropped (`on_hand`, `unit_cost`).
- **References and numbers are case-insensitive**: part refs (`lamp-desk`), supplier names, build numbers
  (`b-0001`), PO numbers.
- **Selecting an assembly** (`get_assembly`, `explode_assembly`, `set_assembly_lines`, `set_assembly_production`,
  `new_assembly_revision`, `activate_assembly`, `archive_assembly`): `assembly` is an assembly id (number) or the reference of the part it builds (its active assembly), plus an
  optional `code` (variant, default `std`, else the only active one) and an optional `revision` (any status).
- **Every write result** carries `change_set_id`, `revertible`, an `undo` sentence and, only when it can be undone,
  `history_path` and `history_url` (the page where the user clicks Undo). A call that changes nothing records
  nothing (`change_set_id: null`, `undo` says so). You cannot undo anything yourself.
- **Ledger writes** (`adjust_stock`, `count_stock`, `complete_build`, `record_build`, `receive_po`) return `revertible: false` and no
  link: they are corrected with reverse moves (`adjust_stock`), never undone.
- **Refusals.** A rejected write says `Refused, nothing was changed.` followed by one `field: message` per problem
  (every problem at once; nothing is written). Lookups fail with `No part with reference "X". Use search_parts to
  find it.` (same for assemblies, builds, POs, suppliers). A call the user's role forbids answers `Refused: your role
  (...) does not allow <tool>`; a scope the connection lacks answers `This connection was not granted <scope>`.
- **Costs hidden.** When the user may not see costs, every amount is left out of the result and it says
  `costs_hidden: true`. Never guess an amount.
- **Lists** have `limit` and say `truncated: true` when there is more; narrow the query instead of paging blindly.
- A result key named after a quantity (`qty`, `on_hand`, `short`) is in the part's unit.
- **Locations.** Each stocked part can have one home location on the workshop plan, a **bin code**: `A-2-3` is unit
  `A`, level 2 counted from the floor, position 3 counted from the left when facing it; `A-2` is anywhere on level 2,
  `A` anywhere in the unit (a floor area such as `P` has no levels). A rack or a drawer cabinet can stand in a bin of
  another unit: its bins keep their own code (`S1-2-1`, the label on the drawer) and `path` gives the way to it from
  the plan (`A-3-3 › S1-2-1`). Rooms (`STOC`) hold units, not parts. Stock is counted per part, not per bin: a location
  says where to look and where to put away. The plan is drawn in the app.
- **Batches.** An assembly makes `batch` units at a time (1 unless set, e.g. 24 parts per print plate), and its lines
  are the quantities for the whole batch. Quantities needed for a build are line × units / batch, rounded up to the
  thousandth (whole units for serial-tracked parts); costs are per unit.
- **Options.** A buy or make part can have options (Colour, Size): each has ordered values and one default, and the
  part's stock, PO lines and builds are counted per values (a white and a black cover are two stocks of one part).
  Tools take and return `options` as an object, option name → value name: `{"Colour": "white"}`. Names are matched
  ignoring case and are the workshop's own words: their case and spaces are kept as they are. A write on a part with
  options needs a value for every option (it is refused with the values that exist); on a part without options it is
  refused. Results show `options` only where a record has values. Options are not variants (`code`, an assembly):
  a variant is another recipe, an option is a value of the same part. Defining options is done in the app only.
- **Machine time.** An assembly can also take `machine_minutes` per batch on a `machine_type` (an FDM printer, a laser
  cutter); the type carries the `hourly_rate`. Machine time is costed like a component (unit costs include it) and
  listed as `machine_time[]` (`type`, `minutes` for the quantity asked, `hourly_rate`, `cost`). `minutes` is a
  decimal number of minutes; say it to people as hours and minutes (190 = 3 h 10).

## Reading: `catalog:read`

### `search_parts`
Find parts by reference, name or any supplier's reference. Use it before relying on any reference.
- **Scope:** `catalog:read` · **Permission:** none (every listed user)
- **Inputs:** `query` (text; omit to list all), `kind` (buy, make, kit or fee), `include_archived` (default false), `limit` (default 50, max 500).
- **Returns:** `count`, `truncated`, `parts[]` with `ref`, `name`, `kind`, `unit`, `on_hand`, `preferred_supplier`, `standard_cost`, `track_serial`, `archived`.
- **Example:** `search_parts({ "query": "felt" })`

### `get_part`
One part in full: details, prices, supplier offers (preferred first), on hand, its assemblies with unit cost, where it is used, and its own files.
- **Scope:** `catalog:read` · **Permission:** none
- **Inputs:** `ref` (part reference).
- **Returns:** `part` (`ref`, `name`, `kind`, `unit`, `track_serial`, `archived`, `notes`, `min_stock` (null: no alert), `on_hand`, `standard_cost`, `sale_price`; for a part with options also `options[]` of `name`, `values` in order and `default`, and `stock_by_options[]` of `options` and `on_hand`, the values with stock; `on_hand` is the total), `offers[]` (`supplier`, `preferred`, `supplier_ref`, `price`, `moq`, `pack_size`, `lead_days`), `assemblies[]` (`assembly_id`, `code`, `revision`, `status`, `batch`, `unit_cost`, `cost_incomplete`, `sale_price`), `rolled_up_cost`, `where_used[]` (`parent`, `assembly_id`, `code`, `revision`, `status`, `depth`, `via`, `qty_per_parent` for one batch of `batch` units of the parent), `files[]` attached to the part whatever its assembly (`name`, `kind`: cad, print, drawing, instructions, datasheet or other, `format`, `size_bytes`, `uploaded_at`, `uploaded_by`, `note`, `download_path`, `download_url`). `part.location` is where it is kept, as in `get_location` (`bin`, `path`, `room`, `storage_unit`, `note`), or null.
- **Example:** `get_part({ "ref": "PAD-FELT" })`

### `get_assembly`
The structure of an assembly as a tree with cost roll-up. Kits and sub-assemblies are expanded through their active assemblies.
- **Scope:** `catalog:read` · **Permission:** none
- **Inputs:** `assembly`, `code`, `revision` (selector), `qty` (how many to build, default 1).
- **Returns:** `assembly` (`assembly_id`, `part`, `code`, `revision`, `status`, `batch`, `machine_type`, `machine_minutes` per batch, `options` of the product: its defaults), `qty`, `cost` (`unit_cost`, `total_cost`, `incomplete`, `missing_costs` with machine types without a rate), `machine_time[]` for `qty`, `lines[]` as a tree: `ref`, `kind`, for a component with options `options` (the values it resolves to here), `fixed` (the values the line always takes), `choose` (options chosen when a build is planned; an option in neither follows the build) and `missing_values` (a value the build asks that the component does not come in), `per_parent` (per batch of the parent; `parent_batch` gives its size when it is not 1), `qty` (cumulative), `mode`, `unit_cost`, `extended_cost`, `cost_incomplete`, `children`; `files[]` of this revision (print files, assembly instructions; same fields as in `get_part`).
- **Example:** `get_assembly({ "assembly": "LAMP-DESK", "code": "warm", "qty": 3 })`

### `explode_assembly`
The flat list of components needed for a quantity, with on hand and shortfall. Fee lines are listed apart (cost only).
- **Scope:** `catalog:read` · **Permission:** none
- **Inputs:** `assembly`, `code`, `revision` (selector), `qty` (required), `options` (the values of the product, e.g. `{"Colour": "black"}`; left out, each option takes its default), `use_stock` (take sub-assemblies already in stock instead of building them; default false).
- **Returns:** `assembly` (with its `batch` and the product's `options`), `qty`, `use_stock`, `components[]` (`ref`, `name`, `kind`, `unit`, `options` when the component has some: one line per part and values, `qty`, `on_hand` in those values, `short`, `missing_assembly`, `missing_value`, `unit_cost`, `extended_cost`), `fees[]`, `machine_time[]` (sub-assemblies taken from stock need none), `total_cost` (machine time included), `cost_incomplete`.
- **Example:** `explode_assembly({ "assembly": "LAMP-DESK", "code": "warm", "qty": 3, "use_stock": true })`

### `list_machines`
The machine types (what recipes name, with their hourly rate) and the machines the workshop owns, with their status.
- **Scope:** `catalog:read` · **Permission:** none
- **Inputs:** `include_retired` (default false).
- **Returns:** `machine_types[]` (`name`, `hourly_rate`, `active_machines`, `recipes` using it, `planned_minutes` the open builds need), `machines[]` (`name`, `type`, `status`: active, maintenance or retired, `notes`).
- **Example:** `list_machines({})`

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
- **Inputs:** `query`, `filter` (all, below_zero, below_min: under a set minimum stock, in_stock; default all), `limit` (default 100, max 1000).
- **Returns:** `filter`, `count`, `truncated`, `parts[]` (`ref`, `name`, `kind`, `unit`, `on_hand` total, `by_options[]` of `options` and `on_hand` for a part with options, `min_stock`, `preferred_supplier`). `below_zero` also catches a part negative in some values; the minimum stock compares the total.
- **Example:** `stock_on_hand({ "filter": "below_min" })`

### `list_moves`
The stock ledger, newest first. On hand is the sum of the signed moves.
- **Scope:** `stock:read` · **Permission:** none
- **Inputs:** `query` (part refs, names, serials, notes), `reason` (receipt, build_consume, build_output, adjust or count), `from`, `to`, `limit` (default 100, max 500).
- **Returns:** `count`, `moves[]` (`at`, `ref`, `name`, `unit`, `options` for a part with options, `qty` signed, `reason`, `serial`, `unit_cost`, `source`, `note`, `by`).
- **Example:** `list_moves({ "query": "LED-5W-CW", "limit": 20 })`

### `get_location`
Where parts are kept, on the workshop plan: where a part is, what a bin, unit or room holds, or the whole plan.
- **Scope:** `stock:read` · **Permission:** none
- **Inputs:** `ref` (a part reference, tried first; else a bin code `A-2-3`, `A-2`, a unit code `A`, or a room's code
  `STOC` or name; left out: the whole plan), `limit` (parts listed, default 100, max 500).
- **Returns:** for a part: `part` (`ref`, `name`, `kind`, `unit`, `on_hand`) and `location` (`bin`, `path`, `room`,
  `storage_unit` with `code`, `name`, `kind`, `note`), null with a `hint` when it has none. For a bin or unit: `place`
  (`kind` bin or unit, `code`, `path`, `room`, `storage_unit` with its `levels` and `positions`), `parts[]` (`ref`,
  `name`, `bin`, `on_hand`, `unit`, `note`), `part_count` (all of them), `units[]` standing in it (`code`, `name`,
  `kind`, `in_bin`, `part_count`, their own `units`). For a room: `place` (`kind` room, `code`, `name`), `units[]`
  drawn in it as a tree, `parts[]` in walking order with their `path`, `part_count`. Without `ref`: `rooms[]`
  (`code`, `name`), `units[]` that hold parts as a tree (`code`, `name`, `kind`, `room`, `levels`, `positions`,
  `part_count`, `units` standing in their bins with `in_bin`), `without_location[]` (stocked parts not put away yet:
  `ref`, `name`) and `without_location_count`. A door or landmark holds nothing (an error says so).
- **Example:** `get_location({ "ref": "SCREW-M3X8" })`, `get_location({ "ref": "A-3" })`, `get_location({})`

## Reading: `builds:read`

### `list_builds`
Builds (production orders), newest first. The query also matches the serials of consumed components: use it to find which build used a serial.
- **Scope:** `builds:read` · **Permission:** none
- **Inputs:** `query` (build number, product serial, part ref or name, component serial), `status` (open, all, planned, in_progress, done, cancelled; default open, or all when a query is given), `limit` (default 50, max 500).
- **Returns:** `status`, `count`, `builds[]` (`number`, `status`, `part`, `name`, `unit`, `qty`, `serial`, `options` the product is made in, `assembly`, `planned_for`, `done_at`).
- **Example:** `list_builds({ "query": "CW-24-0003" })`

### `get_build`
One build. Done: the as-built record. Open: the pick list from current stock.
- **Scope:** `builds:read` · **Permission:** none
- **Inputs:** `number` (e.g. `B-0001`).
- **Returns:** `build` (`number`, `status`, `part`, `qty`, `serial`, `options` of the product, `choices[]` of `ref` and `options`: the values chosen for the components whose recipe lines leave options to the build, `assembly`, `planned_for`, `done_at`). Done: `as_built[]` (`ref`, `options`, `qty`, `serial`, `unit_cost` frozen, `made_by_build`), `machine_time[]` recorded at completion with its rate, `total_cost`. Open: `pick_list[]` (`ref`, `options`, `qty`, `on_hand` in those values, `short`, `serials_to_scan` count to give), `sub_assemblies[]` (`ref`, `options`, `path`, `qty`, `from_stock`, `to_build`), `fees`, `machine_time[]`, `problems` (what blocks completion, e.g. a value the component does not come in). Always: `files[]` to make it, those of its assembly revision then the part's own (`attached_to`: assembly or part; same fields as in `get_part`).
- **Example:** `get_build({ "number": "B-0001" })`

## Reading: `purchasing:read`

### `get_shortages`
What to make, then what to buy, for all planned and in-progress builds. To make: made parts the builds need beyond stock and the builds already planned for them, deepest first, in whole runs. To buy: need minus on hand minus on order, rounded up to the preferred supplier's MOQ and pack size, grouped by supplier.
- **Scope:** `purchasing:read` · **Permission:** none
- **Inputs:** none.
- **Returns:** `open_builds`, `to_make[]` (`ref`, `options` when it has some: one line per values, `unit`, `short`, `on_hand`, `planned` by open builds of it, `qty` to make rounded up to whole runs, `runs`, `assembly`, `machine_time` with `type` and `minutes`, `builds`), `suppliers[]` (`supplier`, `total`, `lines[]` with `ref`, `options` (one line per values), `unit`, `need`, `on_hand`, `on_order`, `net`, `order`, `unit_price`, `supplier_ref`, `moq`, `pack_size`, `lead_days`, `builds`), `missing_assemblies[]` (make or kit parts to build that have no active assembly; `options` when it has some), `missing_values[]` (`ref`, `option`, `value`, `builds`: a value an open build asks of a component that does not come in it; nothing is ordered for it), `machine_time[]` (`type`, `minutes` needed, what is to make counted in whole runs, `active_machines` in service, `builds`).
- **Example:** `get_shortages({})`

### `list_purchase_orders`
Purchase orders, newest first, with their total (lines and charges).
- **Scope:** `purchasing:read` · **Permission:** none
- **Inputs:** `query` (PO number, supplier name, tracking number), `status` (open, all, draft, sent, partial, received, cancelled; default open), `limit` (default 50, max 500).
- **Returns:** `status`, `count`, `truncated`, `purchase_orders[]` (`number`, `status`, `supplier`, `created_at`, `sent_at`, `expected_at`, `lines`, `total`).
- **Example:** `list_purchase_orders({ "status": "sent" })`

### `get_purchase_order`
One PO with its lines, its charges and the shipments the supplier sent.
- **Scope:** `purchasing:read` · **Permission:** none
- **Inputs:** `number` (e.g. `PO-0001`).
- **Returns:** `purchase_order` (`number`, `status`, `supplier`, `expected_at`, `notes`), `lines[]` (`ref`, `options`, `qty`, `received`, `remaining`, `unit_price`, `landed_unit_cost` when charges are spread: what its receipts enter stock at, `line_total`), `lines_total`, the charges `shipping`, `duties` (customs and duties) and `discount` (subtracted), `charges_spread` (`value`, `qty` or `none`), `total` (lines and charges), `charges_in_stock` once something was received (the part of the charges in stock value: charges changed after a receipt only reach later receipts), `shipments[]` (`carrier`, `tracking_number`, `tracking_url`, `shipped_at`, `notes`).
- **Example:** `get_purchase_order({ "number": "PO-0001" })`

## Writing the catalogue: `catalog:write`

### `create_part`
Creates a part. Prices and offers are separate calls.
- **Scope:** `catalog:write` · **Permission:** `parts.edit` (planner)
- **Inputs:** `ref` (unique, letters, digits and `- _ . /`), `name`, `kind` (buy, make, kit, fee), `unit` (default pcs), `track_serial` (buy and make only), `min_stock` (buy and make only; the stock alert level), `notes`.
- **Returns:** the write envelope and `part` (with `min_stock`).
- **Example:** `create_part({ "ref": "PAD-RUBBER", "name": "Rubber pad 20mm", "kind": "buy" })`

### `update_part`
Changes a part's fields; fields left out keep their value. Never prices.
- **Scope:** `catalog:write` · **Permission:** `parts.edit` (planner)
- **Inputs:** `ref`, `new_ref`, `name`, `kind`, `unit`, `track_serial`, `min_stock` (null removes it), `notes`,
  `location` (where it is kept: `bin`, a bin code of the plan such as `A-2-3`, `A-2` or `P`, `""` to clear it; `note`,
  left out: kept). A part with stock moves cannot become a kit or fee; a part with assemblies stays make or kit. A bin
  that is not on the plan is refused (`location: No storage unit has this code.`). Only `location` given: the change
  is named "Set the location of X to B" (or "Clear the location of X"); the same bin and note again changes nothing.
- **Returns:** the write envelope and `part`, with its `location` (as in `get_location`).
- **Example:** `update_part({ "ref": "PAD-FELT", "notes": "Self-adhesive" })`,
  `update_part({ "ref": "SWITCH-INL", "location": { "bin": "B-1-2", "note": "Bags of 20" } })`

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

### `create_assembly`
Creates a draft assembly for a make or kit part, empty or copied from another assembly (its lines and production settings). A new variant code starts without its own selling price (the part's applies until `set_sale_price` with `code`); the same code under a new revision keeps the source's. Then `set_assembly_lines`, then `activate_assembly`.
- **Scope:** `catalog:write` · **Permission:** `assemblies.edit` (planner)
- **Inputs:** `part`, `code` (default std), `revision` (default Rev1), `notes`, `copy_from` (an assembly selector).
- **Returns:** the write envelope, `assembly` (`assembly_id`, `part`, `code`, `revision`, `status`, `batch`, `sale_price`: the variant's own selling price, null when the part's applies), `lines`.
- **Example:** `create_assembly({ "part": "LAMP-DESK", "code": "compact", "copy_from": { "assembly": "LAMP-DESK" } })`

### `set_assembly_lines`
Replaces every line of an assembly at once, in order, with the editor's checks (known part, not archived, whole units for serial-tracked parts, no cycle). Nothing changes if one line is refused. An active assembly is never edited: the next revision is created as a draft (with the active one's notes, production settings and own selling price, lines replaced by yours) and the active assembly stays as it is. Archived assemblies are read-only.
- **Scope:** `catalog:write` · **Permission:** `assemblies.edit` (planner)
- **Inputs:** `assembly`, `code`, `revision` (selector), `lines[]` of `ref`, `qty` (per batch of the assembly: per unit when its `batch` is 1), `fixed` (option → value the line always takes), `choose` (options chosen when a build is planned), `notes` (1 to 500 lines). Send the complete list, not a delta. An option of the component in neither `fixed` nor `choose` follows the build: it takes the value of the same option name in the parent (matched by value name), else its default. A line that leaves both `fixed` and `choose` out keeps the rules of the same component's line it replaces; send `"fixed": {}, "choose": []` to make it follow the build again.
- **Returns:** the write envelope, `assembly` (the one that was edited), `new_revision` (true when a draft revision was created), `active_assembly` (then), `note`, `lines` (`ref`, `qty`, `notes`, `fixed`, `choose`).
- **Example:** `set_assembly_lines({ "assembly": "BASE-ASSY", "lines": [{ "ref": "BASE-PLATE", "qty": 1 }, { "ref": "PAD-FELT", "qty": 6 }] })`; with options: `{ "ref": "COVER", "qty": 1, "fixed": { "Size": "L" }, "choose": ["Colour"] }`

### `set_assembly_production`
How an assembly is produced: `batch_qty`, the units one batch makes (24 parts per print plate: its lines are then the plate's quantities), and the machine time per batch: `machine_type` (a name from `list_machines`, null for none) and `machine_minutes` (whole minutes, 3 h 10 = 190). These settings belong to a revision: a draft is changed in place; an active assembly is never changed, the next draft revision is created with its lines, its own selling price and the new settings; an archived one is refused.
- **Scope:** `catalog:write` · **Permission:** `assemblies.edit` (planner)
- **Inputs:** `assembly`, `code`, `revision` (selector), `batch_qty`, `machine_type`, `machine_minutes`; left out, they keep their value.
- **Returns:** the write envelope, `assembly` (with `batch`, `machine_type`, `machine_minutes`), `new_revision`, `active_assembly` and `note` (when a revision was created).
- **Example:** `set_assembly_production({ "assembly": "LAMP-CLIP", "revision": "Rev2", "batch_qty": "24", "machine_type": "FDM printer", "machine_minutes": 185 })`

### `new_assembly_revision`
Copies an assembly (any status) with its lines, production settings and own selling price into the next draft revision of the same part and code. The original is not changed.
- **Scope:** `catalog:write` · **Permission:** `assemblies.edit` (planner)
- **Inputs:** `assembly`, `code`, `revision` (selector).
- **Returns:** the write envelope, `assembly` (new draft), `from`, `lines`.
- **Example:** `new_assembly_revision({ "assembly": "BASE-ASSY" })`

### `activate_assembly`
Makes a draft or archived assembly the active one of its part and code: builds and explosions use it from now on. The previously active revision is archived (it can be activated again). Refused if it would create a cycle.
- **Scope:** `catalog:write` · **Permission:** `assemblies.edit` (planner)
- **Inputs:** `assembly`, `code`, `revision` (selector; give the revision, or the assembly id).
- **Returns:** the write envelope, `assembly`, `archived[]` (the revisions it replaced). Already active: nothing changes.
- **Example:** `activate_assembly({ "assembly": "BASE-ASSY", "revision": "Rev2" })`

## Writing prices: `prices:write`

### `set_standard_cost`
A part's standard cost: the unit cost used in roll-ups, valuations and planned margins. Appended to the price history.
- **Scope:** `prices:write` · **Permission:** `prices.edit` (planner)
- **Inputs:** `ref`, `cost` (amount, at most 2 decimals; null clears it), `note` (kept in the price history).
- **Returns:** the write envelope, `part`, `standard_cost`, `previous_standard_cost`.
- **Example:** `set_standard_cost({ "ref": "PAD-FELT", "cost": "0.06", "note": "2026 price list" })`

### `set_sale_price`
The selling price of a part, or of one assembly variant (`code`, plus `revision` when not the active one), which overrides the part's price for that variant.
- **Scope:** `prices:write` · **Permission:** `prices.edit` (planner)
- **Inputs:** `ref`, `price` (null clears it), `code`, `revision` (needs `code`).
- **Returns:** the write envelope, `part`, `assembly` (for a variant), `sale_price`, `previous_sale_price`.
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
The part disappears from lists and pickers (new assembly lines, POs); stock, assemblies, builds and history stay.
- **Scope:** `catalog:archive` · **Permission:** `parts.archive` (admin)
- **Inputs:** `ref`.
- **Returns:** the write envelope and `part`.
- **Example:** `archive_part({ "ref": "PAD-FELT" })`

### `unarchive_part`
- **Scope:** `catalog:archive` · **Permission:** `parts.archive` (admin)
- **Inputs:** `ref`.
- **Returns:** the write envelope and `part`.
- **Example:** `unarchive_part({ "ref": "PAD-FELT" })`

### `archive_assembly`
A revision becomes read-only and unused by builds and explosions. Archiving the active one leaves its part and code with no active assembly until another is activated. `activate_assembly` brings one back.
- **Scope:** `catalog:archive` · **Permission:** `assemblies.archive` (admin)
- **Inputs:** `assembly`, `code`, `revision` (selector).
- **Returns:** the write envelope and `assembly`.
- **Example:** `archive_assembly({ "assembly": "LAMP-DESK", "revision": "Rev1" })`

## Writing stock: `stock:write`

Both tools write the append-only ledger. They cannot be undone: a mistake is corrected with the opposite adjustment.

### `adjust_stock`
A signed adjustment of a buy or make part, valued at its standard cost, with a required note.
- **Scope:** `stock:write` · **Permission:** `stock.adjust` (operator)
- **Inputs:** `ref`, `options` (a part with options is adjusted in one value of each), `qty` (signed, never 0), `serial` (for one unit of a serial-tracked part: qty is 1 or -1), `note` (why).
- **Returns:** the write envelope, `part`, `unit`, `options`, `qty`, `serial`, `on_hand` (after; in those values for a part with options, with `total_on_hand` for the whole part).
- **Example:** `adjust_stock({ "ref": "SCREW-M3X8", "qty": "-12", "note": "Scrapped: dropped on the floor" })`; `adjust_stock({ "ref": "COVER", "options": { "Colour": "white" }, "qty": "5", "note": "Found" })`

### `count_stock`
Posts counted quantities: for each part one count move for the difference with the current on hand (nothing when already right). Only the listed parts are touched.
- **Scope:** `stock:write` · **Permission:** `stock.count` (operator)
- **Inputs:** `counts[]` of `ref`, `options` (a part with options is counted per values: one entry for each values, and only those are touched), `qty` (counted, 0 or more; each part, and each values, once), `note`.
- **Returns:** the write envelope, `adjusted`, `counts[]` (`ref`, `options`, `previous`, `counted`, `adjustment`).
- **Example:** `count_stock({ "counts": [{ "ref": "PAD-FELT", "qty": "380" }], "note": "Monthly count" })`

## Builds: `builds:write`

### `plan_build`
Plans a build of a make part from one of its active assemblies. A serial-tracked product is built one unit at a time with its own serial.
- **Scope:** `builds:write` · **Permission:** `builds.plan` (operator)
- **Inputs:** `ref`, `qty` (units, default 1) or `batches` (that many batches of the chosen assembly), `code` (variant), `options` (the values of the product; required when it has options), `choices[]` of `ref` and `options` (the values for each component whose recipe lines leave options to the build: `choose` in `get_assembly`; every such option needs a value), `serial`, `planned_for` (date), `notes`. The values flow down the structure by option name and value name; a value a component does not come in (a cover with no red) is refused.
- **Returns:** the write envelope and `build` (`number`, `status`, `part`, `qty`, `serial`, `options`, `choices`, `assembly` with its `batch`, `planned_for`).
- **Example:** `plan_build({ "ref": "LAMP-DESK", "code": "warm", "serial": "L-0100", "planned_for": "2026-11-02" })`; with options: `plan_build({ "ref": "NL-LIGHT", "qty": "5", "options": { "Colour": "white" } })`

### `complete_build`
Records a planned or in-progress build as done: components are consumed, the product is added, and the as-built record keeps every serial and frozen unit cost. Refused, with every reason, when a serial is missing or repeated, a sub-assembly to build has no active assembly, or the product needs a serial. Writes the ledger: cannot be undone.
- **Scope:** `builds:write` · **Permission:** `builds.complete` (operator)
- **Inputs:** `number`, `serials[]` of `ref`, `options` (only when the build uses the component in several values: `get_build` lists each in its `pick_list`) and `serials` (one per unit of each serial-tracked component; the count is `serials_to_scan` in `get_build`), `sub_assemblies[]` of `ref` (every place the part appears) or `path` (one place, from `get_build`) and `mode` (stock or build). Without a choice, a sub-assembly comes from stock when there is enough, else it is built now.
- **Returns:** the write envelope, `build` (done, with its `options` and `choices`), `as_built[]` (`ref`, `options`, `qty`, `serial`, `unit_cost`). The values are those stored when the build was planned.
- **Example:** `complete_build({ "number": "B-0001", "serials": [{ "ref": "LED-5W-WW", "serials": ["WW-24-0001"] }, { "ref": "DRV-12V", "serials": ["DRV-7A-101"] }], "sub_assemblies": [{ "ref": "ARM-ASSY", "mode": "stock" }] })`

### `record_build`
Records a build that is already done (a print run recorded after the fact) in one step: planned and completed now, in one change set. Same checks as `plan_build`; components are taken from stock, and sub-assemblies too when there are enough (the others are built now); machine time is recorded. Refused when a serial-tracked component needs serials: then `plan_build`, and `complete_build` with the serials. Cannot be undone.
- **Scope:** `builds:write` · **Permission:** `builds.complete` (operator; recording also plans, `builds.plan`)
- **Inputs:** `ref`, `qty` (units, default 1) or `batches`, `code` (variant), `options` and `choices[]` (as in `plan_build`), `serial` (serial-tracked product), `notes`.
- **Returns:** the write envelope (`revertible: false`), `build` (`number`, `status` done, `part`, `qty`, `serial`, `options`, `choices`, `assembly` with its `batch`, `done_at`), `as_built[]` (`ref`, `options`, `qty`, `serial`, `unit_cost`, `made_by_build`), `machine_time[]` (`type`, `minutes`).
- **Example:** `record_build({ "ref": "LAMP-CLIP", "batches": 2 })`

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
- **Inputs:** `suppliers[]` (only these groups; default all), `order_from[]` of `ref`, `options` (when the part is short in several values: one line each) and `supplier` (order a short part from another supplier that has an offer for it; parts with no preferred supplier are drafted only this way). A part with options is ordered in each values it is short in, one PO line each, rounded to the offer on its own.
- **Returns:** the write envelope and `purchase_orders[]` (each as `get_purchase_order` returns it: `lines`, with their `options`, the charges and `total`), or "Nothing to order."
- **Example:** `create_draft_pos({ "suppliers": ["Bolt & Nut Depot"] })`

### `create_po`
Creates a draft PO for a supplier, as the New PO page does, to order parts whether or not they are short (`create_draft_pos` only drafts what the shortages need). Kits, fees and archived parts are refused. The draft is not sent: review it, adjust it with `update_draft_po`, and `mark_po_sent` once the user has sent it.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.order` (planner)
- **Inputs:** `supplier` (its name, case-insensitive), `expected_at`, `notes`, `shipping`, `duties`, `discount`, `charges_spread` (as for `update_draft_po`), `lines[]` of `ref`, `options` (a value of every option of the part), `qty` (more than zero), `price` (left out: this supplier's offer price, else the standard cost). Each part and values once.
- **Returns:** the write envelope, `purchase_order` (with its new `number`), `lines` (with their `options` and `landed_unit_cost`), `lines_total`, the charges, `charges_spread`, `total`, `shipments`.
- **Example:** `create_po({ "supplier": "Bolt & Nut Depot", "shipping": "6.50", "lines": [{ "ref": "PAD-FELT", "qty": "1000" }] })`

### `update_draft_po`
Edits a PO: expected date, notes and charges (any open PO: draft, sent or partly received) and the lines of a draft. A line sets the quantity of a part: existing is changed, a new part is added, `"0"` removes it. Lines of a sent PO cannot change. Charges spread over the lines give each line a landed unit cost (price + its share), which receipts enter stock at; a change reaches only what is received afterwards, so set them before `receive_po`.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.order` (planner)
- **Inputs:** `number`, `expected_at` (date or null), `notes`, `shipping`, `duties`, `discount` (amounts for the whole order, `"0"` clears; the discount is a positive amount subtracted, never more than the order), `charges_spread` (`value`: in proportion to each line's ordered value, the default; `qty`: to its ordered quantity; `none`: receipts at the line price, the charges only recorded), `lines[]` of `ref`, `options`, `qty`, `price`. A part with options is on one line per values: `options` says which line (it may be left out when the part is on one line); a new line needs a value of every option.
- **Returns:** the write envelope, `purchase_order`, `lines` (with their `options` and `landed_unit_cost`), `lines_total`, the charges, `charges_spread`, `total`, `shipments`.
- **Example:** `update_draft_po({ "number": "PO-0002", "expected_at": "2026-11-10", "lines": [{ "ref": "PAD-FELT", "qty": "1000" }] })`; the freight and a coupon of a sent PO: `update_draft_po({ "number": "PO-0003", "shipping": "86.50", "discount": "5.00" })`

### `mark_po_sent`
Marks a draft as sent. Kitting sends nothing itself: the user sends the order to the supplier. Lines freeze; it then waits for `receive_po`.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.order` (planner)
- **Inputs:** `number`.
- **Returns:** the write envelope, `purchase_order`, `lines`, the charges, `total`, `shipments`.
- **Example:** `mark_po_sent({ "number": "PO-0002" })`

### `receive_po`
Records goods received, per part, optionally with one serial per unit. Stock goes up at the line's landed unit cost (its price plus its share of the PO's charges when they are spread, else the price), as the charges are now; the PO becomes partial or received. More deliveries can follow. Writes the ledger: cannot be undone.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.receive` (operator)
- **Inputs:** `number`, `lines[]` of `ref`, `options` (to tell lines of the same part apart; stock goes up in the line's values), `qty` (received now), `serials`.
- **Returns:** the write envelope, `received[]` (`ref`, `options`, `qty`, `unit_cost` it entered stock at, `serials`), `purchase_order`, `lines`, the charges, `total`, `charges_in_stock`, `shipments`.
- **Example:** `receive_po({ "number": "PO-0001", "lines": [{ "ref": "LED-5W-WW", "qty": "10", "serials": ["WW-24-0101", "WW-24-0102"] }] })`

### `cancel_po`
Cancels a draft or sent PO that received nothing. A partly received PO is closed instead.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.order` (planner)
- **Inputs:** `number`.
- **Returns:** the write envelope, `purchase_order`, `lines`, the charges, `total`, `shipments`.
- **Example:** `cancel_po({ "number": "PO-0003" })`

### `close_po`
Closes a sent or partly received PO whose remaining quantities will not come: they are no longer on order. Nothing moves in stock.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.order` (planner)
- **Inputs:** `number`.
- **Returns:** the write envelope, `purchase_order`, `lines`, the charges, `total`, `shipments`.
- **Example:** `close_po({ "number": "PO-0001" })`

### `record_po_shipment`
Records a parcel the supplier sent for a PO: carrier, tracking number, and optionally the carrier's tracking link, the shipping date and a note, so the whole team can follow it. Recording a tracking number already on the PO (any case) updates that shipment; fields left out keep their value, an empty `tracking_url` removes the link. Only on sent, partial and received POs. Kitting never contacts the carrier: take the details from what the supplier sent, never guess a link.
- **Scope:** `purchasing:write` · **Permission:** `purchasing.order` (planner)
- **Inputs:** `number`, `tracking_number`, `carrier` (required for a new shipment), `tracking_url` (`https://…`), `shipped_at` (date; `null` clears it), `notes`.
- **Returns:** the write envelope, `purchase_order`, `lines`, the charges, `total`, `shipments`.
- **Example:** `record_po_shipment({ "number": "PO-0001", "carrier": "Parcel Co", "tracking_number": "PC123456789", "tracking_url": "https://track.example/PC123456789" })`
