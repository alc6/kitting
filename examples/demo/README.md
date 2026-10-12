# Demo dataset: a modular desk lamp

Entirely fictional data to try Kitting. No real company, supplier or price.

| File | What it shows |
| --- | --- |
| `suppliers.csv` | Five suppliers (`.example` addresses). |
| `parts.csv` | `make` product and sub-assemblies, two `kit` phantoms, serial-tracked `buy` parts, a part sold by the metre, a part with no known cost, an eco-fee (`fee`). |
| `boms.csv` | Two active variants of the lamp (`std` and `warm`), an archived revision, and nested sub-assemblies. |
| `stock.csv` | Initial counts, with one row per serial for serial-tracked parts. |

Load it in this order from **Import / Export**: `suppliers.csv`, `parts.csv`, `boms.csv`, `stock.csv`.
Each import shows a preview first; confirm to write.

The lamp in numbers: one lamp needs 1 base sub-assembly, 2 arm sub-assemblies and 1 head kit.
Each arm uses 4 M3 screws and the head kit 3, so a lamp needs 11 M3 screws.
`MANUAL` has no cost, so the lamp's cost roll-up is flagged as incomplete.
