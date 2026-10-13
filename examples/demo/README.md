# Demo dataset: a modular desk lamp

Entirely fictional data to try Kitting. No real company, supplier or price.

| File | What it shows |
| --- | --- |
| `suppliers.csv` | Six suppliers (`.example` addresses), one of them a fast but pricier distributor. |
| `parts.csv` | `make` product and sub-assemblies, `kit` phantoms (one nested inside the others), serial-tracked `buy` parts, a part sold by the metre, a part with no known cost, an eco-fee (`fee`). The lamp sells at 89.00 (excl. VAT). |
| `part_suppliers.csv` | Supplier offers: prices from the preferred suppliers, and a second supplier (Quickparts Express: small quantities, short lead times, higher prices) for a few parts. |
| `assemblies.csv` | Two active variants of the lamp (`std` and `warm`), an archived revision, nested sub-assemblies and a kit inside a kit. The `warm` variant sells at 94.00, overriding the lamp's price. |
| `stock.csv` | Initial counts, with one row per serial for serial-tracked parts. |

Load it in this order from **Import / Export**: `suppliers.csv`, `parts.csv`, `part_suppliers.csv`,
`assemblies.csv`, `stock.csv`.
Each import shows a preview first; confirm to write.

The lamp in numbers: one lamp needs 1 base sub-assembly, 2 arm sub-assemblies and 1 head kit.
The head kit contains another kit, `FIX-KIT-HEAD` (3 M3 screws and 3 washers): kits are phantoms,
so both levels explode straight into the lamp and neither is ever stocked or picked.
Each arm uses 4 M3 screws and the fixing kit 3, so a lamp needs 11 M3 screws.
`MANUAL` has no cost, so the lamp's cost roll-up is flagged as incomplete.
