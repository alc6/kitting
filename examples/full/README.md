# Full dataset: a modular desk lamp

A larger fictional dataset that uses most of Kitting's features, and the one the tests run against. No real
company, supplier or price. For a first look, the small demo in [`examples/demo/`](../demo/) is easier to follow.

| File | What it shows |
| --- | --- |
| `suppliers.csv` | Six suppliers (`.example` addresses), one of them a fast but pricier distributor. |
| `parts.csv` | `make` product and sub-assemblies, `kit` phantoms (one nested inside the others), serial-tracked `buy` parts, a part sold by the metre, a part with no known cost, an eco-fee (`fee`), and a 3D-printed cable clip with its filament bought by the kg. The lamp sells at 89.00 (excl. VAT). |
| `part_suppliers.csv` | Supplier offers: prices from the preferred suppliers, and a second supplier (Quickparts Express: small quantities, short lead times, higher prices) for a few parts. |
| `assemblies.csv` | Two active variants of the lamp (`std` and `warm`), an archived revision, nested sub-assemblies and a kit inside a kit. The `warm` variant sells at 94.00, overriding the lamp's price. The cable clip is printed 24 per plate (`batch_qty`), 260 g of filament and 3 h 10 on an FDM printer per plate. |
| `machine_types.csv` | One machine type, `FDM printer`, at 1.50 an hour. |
| `machines.csv` | Three printers of that type, one of them under maintenance. |
| `stock.csv` | Initial counts, with one row per serial for serial-tracked parts. |

Load it in this order from **Import / Export**: `suppliers.csv`, `parts.csv`, `part_suppliers.csv`,
`machine_types.csv`, `machines.csv`, `assemblies.csv`, `stock.csv`.
Each import shows a preview first; confirm to write.

The lamp in numbers: one lamp needs 1 base sub-assembly, 2 arm sub-assemblies and 1 head kit.
The head kit contains another kit, `FIX-KIT-HEAD` (3 M3 screws and 3 washers): kits are phantoms,
so both levels explode straight into the lamp and neither is ever stocked or picked.
Each arm uses 4 M3 screws and the fixing kit 3, so a lamp needs 11 M3 screws.
`MANUAL` has no cost, so the lamp's cost roll-up is flagged as incomplete.

The cable clip in numbers: one plate of 24 clips takes 0.26 kg of PLA (5.20 at 20.00 a kg) and 3 h 10 on an FDM printer
(4.75 at 1.50 an hour), so a clip costs 9.95 / 24 = 0.41 and sells at 2.00. Printing 10 clips takes 109 g (10.83 g each,
rounded up) and 1 h 20 of printer time (79.2 minutes).
