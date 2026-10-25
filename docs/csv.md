# CSV formats

Import and export use the same formats, so you can export, edit in a spreadsheet and import again. Each import
screen offers a template and an export of the current data, and shows a preview with any errors, row by row,
before anything is written. Confirming an import writes everything or nothing.

Files from French or English versions of Excel work as they are: the separator can be a comma, a semicolon or a
tab, decimals can use a point or a comma, and the encoding can be UTF-8 or Windows-1252. Header names are not
case-sensitive.

Import the files in this order: suppliers, storage units, parts, part options, supplier offers, past prices, machine
types, machines, assemblies, stock.

## suppliers.csv

`name,email,phone,notes`

Suppliers are matched by name: an existing supplier is updated, a new one is created.

## storage_units.csv

`code,name,kind,col,row,width,depth,areas,front,levels,positions,parent_bin,notes`

The workshop plan (the Locations page): rooms, doors, landmarks and the units that hold parts. Units are matched by
`code`, required on every row, rooms and doors included (the form makes up a code when left empty, a file would add the
same door again on every import). Columns you leave out keep their current values.

- `kind` is `rack`, `cabinet` (a drawer cabinet), `floor` (a floor area, one place), `room`, `door` or `landmark`.
- `col`, `row`, `width` and `depth` place the unit on the plan, in squares of the plan (0.5 m unless changed on the
  Locations page) from the top left. Units that hold parts may not overlap, nor may rooms; a unit belongs to the room
  around its centre. A plan with a fixed main area refuses units outside it.
- `areas` gives a room that is not a rectangle (an L, a T, a U) its other rectangles, up to seven:
  `col,row,width,depth` each, separated by semicolons (`0,6,4,4; 6,6,4,2`). Each must touch the room along a wall or
  overlap it. Empty means none; leaving the column out keeps them as they are (D211).
- `front` is the side people pick from: `south`, `north`, `west` or `east`.
- `levels` and `positions` give the bins of racks and cabinets: `A-2-3` is level 2 from the floor, position 3 from the
  left when facing the front. Other kinds have one place.
- `parent_bin` puts a rack or a cabinet in a bin of another unit (`A-3-3`, `A-3` or `A`) instead of on the plan; its
  `col` to `depth` are then ignored. That unit must exist or come earlier in the file: the export lists each unit
  before the units standing in it.
- A unit that holds parts cannot lose the bins they are in or become a room, door or landmark. Units are never deleted
  by an import.

## parts.csv

`ref,name,kind,unit,cost,sale_price,supplier,supplier_ref,moq,pack_size,lead_days,min_stock,track_serial,notes,location`

Parts are matched by `ref`, the only required column. Columns you leave out keep their current values, so a file
with just `ref,cost` updates standard costs and nothing else.

- `kind` is `buy`, `make`, `kit` or `fee`.
- An empty `cost` means the cost is unknown. `sale_price` excludes VAT.
- `supplier` is the name of the preferred supplier, and `supplier_ref` to `lead_days` are that supplier's terms.
  Use `part_suppliers.csv` for more than one supplier per part.
- `min_stock` is the part's minimum stock, in its unit (buy and make parts only). The dashboard and the stock page
  flag the part when its on-hand quantity falls below it; empty means no alert.
- `location` is the bin where the part is kept: `A-2-3`, `A-2` (anywhere on level 2) or `A` (anywhere in the unit),
  from `storage_units.csv`. Empty leaves the location as it is (clear it on the part's page), and the location's
  note is kept. The export gives the bin's own code, as on its label, also for a bin of a unit standing in another.

## part_options.csv

`ref,option,value,default`

The options of parts (a colour, a size) and their values, one row per value, in order. Only bought and made parts
have options. `default` is `yes` on the value that new records take when nothing else is said; leave the column out
or empty to keep the current default, or the first value for a new option. At most one value per option is the
default.

For each part named in the file, the file **replaces its options**, as the Options page of the part would:

- Options and values are matched by name, ignoring case. Those found keep their stock and records, take the order of
  the file and the spelling of the file.
- Options and values the file does not list are removed, unless stock, orders or builds name them: the file is then
  refused, with the row of the option. Renaming a value (other than its case) is a removal plus an addition, so it is
  refused while the old value is in use: rename it on the part's Options page instead.
- New options and values are added. Adding an option to a part that has stock, open order lines or open builds
  moves them onto the new option's default value, as on the Options page. Such an import cannot be undone.
- Parts the file does not name are not touched.

Names may not contain `=`, `|` or `*`, which are the syntax of the `options` columns below. The export lists every
value of every part, `default` being `yes` on the default value, and imports back as unchanged.

## part_suppliers.csv

`ref,supplier,supplier_ref,price,moq,pack_size,lead_days,preferred,notes,set_standard_cost`

One row per part and supplier, matched on both.

- `preferred` set to `yes` makes this supplier the one used for shortages and draft purchase orders.
- `set_standard_cost` set to `yes` also makes this price the part's standard cost, which planned costs and margins
  use.

Every price change is kept in the price history.

## price_history.csv

`ref,price,valid_from,supplier,note`

Prices a part had before Kitting, one row per price. Nothing is updated: every row adds a line to the part's price
history, dated `valid_from` (`YYYY-MM-DD`).

- Without `supplier`, the row is a **standard cost**. With a supplier (matched by name, which may have no offer for
  the part any more), it is that supplier's **offer price**. A supplier price is for stocked parts only (buy, make).
- `valid_from` must be before today and before the latest price of the same series (same part, and same supplier
  or the standard cost), so a past price never becomes the current one. It never changes the part's cost, an offer
  or any other current value. Change those on the part's form or with `parts.csv` and `part_suppliers.csv`.
- A series cannot have two prices on the same date, in the file or with the history already recorded. Rows of the
  file can come in any order.
- `price` can be 0 and uses a point or a comma. `note` is optional.
- One wrong row refuses the whole file. Rows added this way cannot be undone, and the history is never edited, so
  check the preview. An administrator can still delete a wrong row, other than the current price of its series,
  from the part's price history.

The export lists the standard cost and supplier price history of every part in this format. It is a record to read
or archive: importing it again is refused, since its rows already exist.

## machine_types.csv

`name,hourly_rate,notes`

The kinds of machine that recipes name (an FDM printer, a laser cutter), matched by name. `hourly_rate` is the cost of
one hour on a machine of this type, excluding VAT; empty means unknown, which makes the cost of every recipe using it
incomplete. Every rate change is kept in the type's rate history.

## machines.csv

`name,type,status,notes`

The machines the workshop owns, matched by name. `type` is the name of a machine type, which must exist. `status` is
`active` (in service, the default), `maintenance` or `retired`.

## assemblies.csv

`parent_ref,code,revision,status,component_ref,qty`, plus the optional `sale_price`, `batch_qty`, `machine`,
`machine_minutes`, `notes` and `options`

One row per component. Rows are grouped by `parent_ref`, `code` and `revision`, and each assembly in the file ends
up with exactly the components listed for it.

- `code` is the variant and defaults to `std`. `revision` defaults to `Rev1` and `status` to `draft`.
- Importing an assembly as `active` archives the active revision of the same variant.
- `sale_price`, one value per assembly, is that variant's selling price. It overrides the part's.
- `batch_qty`, one value per assembly, is how many units of `parent_ref` one batch makes (for example the 24 parts of a
  print plate). The `qty` of its rows are then the quantities for the whole batch. Empty means 1. Like the rows, it may
  change an assembly that is already active.
- `machine` and `machine_minutes`, one value per assembly, are the machine time of one batch: the name of a machine
  type and whole minutes (190 for 3 h 10). Give both, or neither. They follow the same rule as `batch_qty`.
- `options`, per row, is the rule of the line for a component that has options: `Colour=black` always takes that
  value, `Size=*` is chosen when a build is planned, and `|` separates options (`Colour=black|Size=*`). An option the
  cell does not name follows the build, like an empty cell. Names are matched ignoring case; an unknown option or value
  is an error on that row. Without the `options` column, a replaced line keeps the rule of the line of the same
  component in the assembly (the first line of the component keeps the first one's, the second the second's), and a new
  line follows the build. A change of rule shows as an update in the preview.

## stock.csv

`ref,qty,serial,unit_cost`, plus the optional `options`

Sets the quantity on hand to the counted `qty`, with a count movement for the difference. For serial-numbered
parts that have no stock yet, use one row per serial with a `qty` of 1.

A part with options is counted per values: `options` is required for it, and names one value of each option
(`Colour=white|Size=L`, or just `white` for a part with a single option). One row per values, each counted on its own.
The export has one row per values that have stock.
