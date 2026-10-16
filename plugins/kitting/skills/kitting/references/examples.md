# Worked examples

All on the fictional demo dataset (`examples/full/`: the modular desk lamp `LAMP-DESK`, variants `std` and
`warm`, and the 3D-printed cable clip `LAMP-CLIP`). Numbers are illustrative; always read the real ones from the tools.

## 1. Plan five warm lamps and order what is missing

**User:** Plan 5 warm desk lamps and tell me what to order.

1. `search_parts({ "query": "lamp" })` finds `LAMP-DESK` (make, serial-tracked). `get_part({ "ref": "LAMP-DESK" })`
   shows two active assemblies: `std Rev2` and `warm Rev1`.
2. `explode_assembly({ "assembly": "LAMP-DESK", "code": "warm", "qty": 5, "use_stock": true })`: short on `BASE-PLATE`
   (needs 5, 3 on hand) and `LED-5W-WW` (5, 4 on hand); the 2 `ARM-ASSY` in stock are used, the other arms are
   built from parts that are in stock. `MANUAL` has no cost, so the cost is incomplete.

   > **Claude:** The warm lamp needs 5 base plates (3 in stock) and 5 warm LED modules (4 in stock); everything
   > else is in stock. Each lamp has its own serial. I would plan 5 builds of `LAMP-DESK` (warm Rev1). Which
   > serials, and for which date?

3. The user gives serials. Claude confirms the five (`L-0101` to `L-0105`, planned 2026-11-02), then calls
   `plan_build` five times. Each result has a build number and an undo link.
4. `get_shortages({})`: `BASE-PLATE` to order 10 (net 2, MOQ 10, Ironleaf Metalworks, 14 days), `LED-5W-WW` 10
   (net 1, MOQ and pack 10, Lumen Parts Co, 21 days).

   > **Claude:** To order: 10 steel base plates from Ironleaf Metalworks (55.00) and 10 warm LED modules from
   > Lumen Parts Co (42.50). Lead times 14 and 21 days. Shall I create the two draft purchase orders?

5. After a yes: `create_draft_pos({})` returns `PO-0001` and `PO-0002`, drafts. Claude gives the links, says
   nothing was sent, and offers `mark_po_sent` once the user has emailed the suppliers.

## 2. A faulty LED: which other lamps used the same batch?

**User:** The LED in lamp L-0042 is faulty. Which other lamps used the same batch?

1. `list_builds({ "query": "L-0042" })` returns `B-0007` (done). `get_build({ "number": "B-0007" })` shows in
   `as_built`: `LED-5W-WW` serial `WW-24-0003`.
2. Kitting has no lot field, so a batch means the serials received together. `list_moves({ "query": "WW-24-0003" })`
   shows its receipt; `list_moves({ "query": "LED-5W-WW", "reason": "receipt" })` lists the serials received on the
   same PO or date: `WW-24-0001` to `WW-24-0004`.
3. `list_builds({ "query": "WW-24-0001" })` (then `0002`, `0004`) finds which builds consumed each.

   > **Claude:** The faulty LED is `WW-24-0003`, received with `WW-24-0001`, `-0002` and `-0004`. `WW-24-0001`
   > went into lamp `L-0038` (B-0003), `WW-24-0004` into lamp `L-0051` (B-0012); `WW-24-0002` is still in
   > stock, not used by any build. I only know they were received together, not that they share a supplier lot:
   > confirm that with the supplier. Do you want me to adjust the one in stock out (`adjust_stock` -1 with a
   > note)? That cannot be undone.

No write is made without that confirmation.

## 3. Add two felt pads to the base, safely

**User:** Add 2 felt pads to the base.

1. `search_parts({ "query": "felt" })` finds `PAD-FELT`; `search_parts({ "query": "base" })` finds `BASE-ASSY`.
   `get_part({ "ref": "BASE-ASSY" })`: active `std Rev1`, used by `LAMP-DESK` (std Rev2, warm Rev1).
2. `get_assembly({ "assembly": "BASE-ASSY" })`: `BASE-PLATE` 1, `PAD-FELT` 4, `SWITCH-INL` 1, `DRV-12V` 1, `CABLE-2C` 1.5,
   `SCREW-M4X10` 3.

   > **Claude:** The base has 4 felt pads today. Adding 2 makes 6. Because Rev1 is active I will not edit it: I
   > will create a draft Rev2 with all six lines (felt pads 6, the rest unchanged). Nothing changes for builds
   > until you activate it. It affects both lamp variants. Go ahead?

3. After a yes: `set_assembly_lines({ "assembly": "BASE-ASSY", "lines": [ { "ref": "BASE-PLATE", "qty": 1 }, { "ref": "PAD-FELT", "qty": 6 }, { "ref": "SWITCH-INL", "qty": 1 }, { "ref": "DRV-12V", "qty": 1 }, { "ref": "CABLE-2C", "qty": 1.5 }, { "ref": "SCREW-M4X10", "qty": 3 } ] })`
   returns `new_revision: true`, the draft `Rev2` and the undo link.
4. `get_assembly({ "assembly": "BASE-ASSY", "revision": "Rev2" })` and `explode_assembly` confirm the lines; the unit cost goes up
   by 0.10 (2 pads at 0.05), if costs are visible.

   > **Claude:** Draft Rev2 is ready: 6 felt pads, unit cost +0.10. Activate it so builds use it? The current
   > Rev1 would be archived and can be re-activated.

5. Only after the next yes: `activate_assembly({ "assembly": "BASE-ASSY", "revision": "Rev2" })`. Claude reports Rev1
   archived, Rev2 active, and the undo link.

## 4. Refused: not allowed

**User (an operator):** Raise the felt pad price to 0.06.

`set_standard_cost` is not offered: it needs the `prices:write` scope and a planner. Claude says so, does not try
`update_part` or `upsert_supplier_offer` instead, and suggests asking a planner or an admin (Users page), or
reconnecting the app with the scope ticked if the role allows it.

## 5. How many printer hours this week?

**User:** We have 48 clips and 10 more to print. How long will the printers be busy?

1. `get_assembly({ "assembly": "LAMP-CLIP", "qty": 48 })`: `batch` 24, `machine_type` FDM printer, `machine_minutes`
   190 per plate; `machine_time` for 48 is 380 minutes.
2. After the user confirms the two builds: `plan_build({ "ref": "LAMP-CLIP", "batches": 2 })` (48 clips) and
   `plan_build({ "ref": "LAMP-CLIP", "qty": 10 })`.
3. `get_shortages({})`: `machine_time` for FDM printer is 459.167 minutes over both builds, with `active_machines` 2.
   No filament to buy: 629 g are needed and 2.4 kg are in stock.

   > **Claude:** The two builds need about 7 h 40 of printing on the FDM printers. Two printers are in service
   > (PRINTER-3 is under maintenance), so that is about 3 h 50 each. The filament in stock covers it.

## 6. Twelve black mini lamps (parts with options)

**User:** Plan 12 black mini lamps and tell me what to order.

1. `search_parts({ "query": "mini" })` finds `LAMP-MINI` (make). `get_part({ "ref": "LAMP-MINI" })` shows its option
   `Colour` (values white and black, default white). `get_assembly({ "assembly": "LAMP-MINI" })`: the lamp has
   `MINI-HEAD` (a made part with a `Colour` option), which has `MINI-COVER` (a bought part, also in `Colour`); no line
   fixes or chooses a colour, so they all follow the lamp's.
2. `explode_assembly({ "assembly": "LAMP-MINI", "qty": 12, "options": { "Colour": "black" }, "use_stock": true })`:
   12 `MINI-HEAD` in black, none in stock in black (the 2 in stock are white), so they are built: 12 `MINI-COVER`
   in black, 10 in stock in black.

   > **Claude:** For 12 black mini lamps I need 12 black heads (none in stock, I would build them) and so 12 black
   > front covers: 10 in stock, 2 short. Shall I plan the build as `Colour: black`?

3. After a yes: `plan_build({ "ref": "LAMP-MINI", "qty": 12, "options": { "Colour": "black" } })`. The result has the
   build number, `options` and the undo link.
4. `get_shortages({})`: `MINI-COVER` in black, net 2, ordered 20 (MOQ 20, Lumen Parts Co, 14 days). The white covers
   in stock are not counted.

   > **Claude:** Order 20 black front covers from Lumen Parts Co (MOQ 20). Draft PO?

5. After a yes: `create_draft_pos({})`; the line of the PO shows `options` `{"Colour": "black"}`. When the covers
   arrive, `receive_po({ "number": "PO-0003", "lines": [{ "ref": "MINI-COVER", "options": { "Colour": "black" }, "qty": "20" }] })`
   puts them in the black stock only.

## 7. Shipping and a coupon on an order (landed cost)

**User:** PO-0004 from Ironleaf Metalworks came to 86.50 of shipping, and we had a 5.00 coupon. Put it on the order.

1. `get_purchase_order({ "number": "PO-0004" })`: sent, 10 `BASE-PLATE` at 55.00 and 20 `ARM-TUBE-300` at 6.20
   (`lines_total` 674.00), nothing received, `charges_spread` `value`.

   > **Claude:** I would set shipping 86.50 and a discount of 5.00 on PO-0004 (total 755.50). Spread over the lines
   > by value, the base plates would enter stock at 61.65 each and the tubes at 6.95. Shall I?

2. After a yes: `update_draft_po({ "number": "PO-0004", "shipping": "86.50", "discount": "5.00" })`. The result has
   each line's `landed_unit_cost` and the undo link.
3. The goods arrive: `receive_po` as usual; each `received` line gives the `unit_cost` it entered stock at. Charges
   entered after a delivery only reach what is received afterwards (`charges_in_stock` shows how much went in), so
   record the freight before receiving when it is known.
