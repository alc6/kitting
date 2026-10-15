# Glossary (English / French)

Use the user's words, and map them to Kitting's. The tools and their fields are in English whatever the language.

| English | Français | In Kitting |
| --- | --- | --- |
| part, item, component | article, composant, référence | a part, found by `ref` (`search_parts`) |
| reference (ref) | référence | unique, case-insensitive code of a part |
| assembly (bill of materials, BoM) | assemblage (nomenclature) | the components of one make or kit part (`get_assembly`, `set_assembly_lines`) |
| component (a line of an assembly) | composant | a part and a quantity per parent |
| variant (code) | variante | the `code` of an assembly (`std`, `warm`...) |
| option (colour, size) | option (couleur, taille) | `options` of a part: an option name (`Colour`) with values; defined in the app |
| option value | valeur d'option, valeur | one of an option's values (`white`); a part's stock is counted per values; `{"Colour": "white"}` |
| follows the build / fixed / chosen when planned | suit la fabrication / fixée / choisie au lancement | a recipe line's rule per option: default, `fixed`, `choose` |
| revision | indice, révision | `Rev1`, `Rev2`... of a variant; `draft`, `active` or `archived` |
| draft | brouillon | not used by builds until `activate_assembly` |
| activate | activer, mettre en vigueur | `activate_assembly`: this revision becomes the one builds use |
| archive | archiver | hides, reversible; Kitting never deletes over MCP |
| buy part | article acheté | kind `buy` |
| make part, sub-assembly | article fabriqué, sous-ensemble | kind `make`, stocked |
| kit, phantom | kit, nomenclature fantôme | kind `kit`: exploded into its parent, never stocked |
| fee | frais, taxe | kind `fee`: cost only |
| unit (of measure) | unité | `pcs`, `m`, `kg`... |
| where-used | where-used, liste d'emploi | `get_part` → `where_used` |
| explosion | éclatement | `explode_assembly`: flat list of needs for a quantity |
| stock on hand | stock disponible, stock physique | sum of the ledger (`stock_on_hand`) |
| stock move | mouvement de stock | one signed ledger row (`list_moves`) |
| adjustment | ajustement, régularisation | `adjust_stock` (with a note) |
| inventory count | inventaire | `count_stock` |
| receipt, goods received | réception | `receive_po` |
| build | fabrication, ordre de fabrication (OF) | `plan_build`, `complete_build`; number `B-0001` |
| plan / complete / cancel a build | lancer / clôturer / annuler une fabrication | `plan_build` / `complete_build` / `cancel_build` |
| pick list | liste de prélèvement, bon de sortie | `get_build` on an open build |
| as-built record | dossier de lot, as-built | `get_build` on a done build |
| serial number | numéro de série | per unit, on serial-tracked parts |
| traceability | traçabilité | follow serials through builds and receipts |
| shortage | manquant, besoin net | `get_shortages` |
| on order | en commande | quantity on sent or draft POs, counted by the shortages |
| MOQ (minimum order quantity) | quantité minimale de commande | on the supplier offer; shortages round up to it |
| pack size | conditionnement, multiple de commande | orders round up to a multiple of it |
| lead time | délai d'approvisionnement | `lead_days` on the offer |
| supplier | fournisseur | `create_supplier`; offers via `upsert_supplier_offer` |
| supplier offer | tarif fournisseur, offre | price, MOQ, pack size, lead time of one supplier for one part |
| preferred supplier | fournisseur préféré | used by shortages and draft POs |
| purchase order (PO) | commande fournisseur, bon de commande | `PO-0001`; draft, sent, partial, received, cancelled |
| mark as sent | marquer comme envoyée | `mark_po_sent` (the user sends it) |
| close a PO | solder une commande | `close_po`: remaining quantities will not come |
| standard cost | coût standard, prix de revient standard | `set_standard_cost` |
| cost roll-up | prix de revient, coût de revient | `get_assembly`, `get_part`; `cost_incomplete` when a cost is missing |
| selling price | prix de vente | `set_sale_price` |
| margin | marge | selling price minus cost; needs cost visibility |
| recent changes, history | historique, dernières modifications | `list_recent_changes`; undo is done in the app |
| undo | annuler une modification | only in the app (link in the result); ledger writes cannot be undone |
| role | rôle | viewer, operator (opérateur), planner (planificateur), admin |
| scope, permission | portée, permission | what the connection was allowed, e.g. `stock:write` |
