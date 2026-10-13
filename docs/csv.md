# CSV formats

Import and export use the same formats, so you can export, edit in a spreadsheet and import again. Each import
screen offers a template and an export of the current data, and shows a preview with any errors, row by row,
before anything is written. Confirming an import writes everything or nothing.

Files from French or English versions of Excel work as they are: the separator can be a comma, a semicolon or a
tab, decimals can use a point or a comma, and the encoding can be UTF-8 or Windows-1252. Header names are not
case-sensitive.

Import the files in this order: suppliers, parts, supplier offers, assemblies, stock.

## suppliers.csv

`name,email,phone,notes`

Suppliers are matched by name: an existing supplier is updated, a new one is created.

## parts.csv

`ref,name,kind,unit,cost,sale_price,supplier,supplier_ref,moq,pack_size,lead_days,track_serial,notes`

Parts are matched by `ref`, the only required column. Columns you leave out keep their current values, so a file
with just `ref,cost` updates standard costs and nothing else.

- `kind` is `buy`, `make`, `kit` or `fee`.
- An empty `cost` means the cost is unknown. `sale_price` excludes VAT.
- `supplier` is the name of the preferred supplier, and `supplier_ref` to `lead_days` are that supplier's terms.
  Use `part_suppliers.csv` for more than one supplier per part.

## part_suppliers.csv

`ref,supplier,supplier_ref,price,moq,pack_size,lead_days,preferred,notes,set_standard_cost`

One row per part and supplier, matched on both.

- `preferred` set to `yes` makes this supplier the one used for shortages and draft purchase orders.
- `set_standard_cost` set to `yes` also makes this price the part's standard cost, which planned costs and margins
  use.

Every price change is kept in the price history.

## assemblies.csv

`parent_ref,code,revision,status,component_ref,qty`, plus the optional `sale_price` and `notes`

One row per component. Rows are grouped by `parent_ref`, `code` and `revision`, and each assembly in the file ends
up with exactly the components listed for it.

- `code` is the variant and defaults to `std`. `revision` defaults to `Rev1` and `status` to `draft`.
- Importing an assembly as `active` archives the active revision of the same variant.
- `sale_price`, one value per assembly, is that variant's selling price. It overrides the part's.

## stock.csv

`ref,qty,serial,unit_cost`

Sets the quantity on hand to the counted `qty`, with a count movement for the difference. For serial-numbered
parts that have no stock yet, use one row per serial with a `qty` of 1.
