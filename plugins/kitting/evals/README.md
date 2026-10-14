# Evaluations (not run in CI)

Four prompts that check the skill leads Claude to the right tool sequence on the fictional demo dataset
(`examples/full/`). The case files use the layout of [`claude plugin eval`](https://code.claude.com/docs/en/plugin-evals) (one
directory per case with a `prompt.md` and `graders/`), but nobody runs them in CI: they need a Kitting deployment
loaded with the demo data and every scope (a throwaway one, the cases write), reached through OAuth.

**By hand** (the way these were designed): load the demo data in a throwaway deployment, then

```bash
export KITTING_MCP_URL=https://<your-demo-domain>/mcp   # never production
claude --plugin-dir plugins/kitting                      # /mcp: sign in to plugin:kitting:kitting
```

paste each `prompt.md` and compare the tools called with the table below (the graders say the same thing in
machine form: tools used, order, forbidden tools, and a rubric for the answer).

**With `claude plugin eval`**: its runs start with a clean environment, so the connector needs either mocks
(`evals/mocks/kitting/<tool>.md`, not provided: they would only repeat the tool contracts) or a real server
(`--allow-real-servers`, with `--allow-tools "mcp__plugin_kitting_kitting__*"`). Whether `KITTING_MCP_URL` and the
OAuth sign-in reach a run is untested here.

The check that the tool names in the skill exist runs in CI instead (`test/plugin.test.ts`). MCP tool names here
are the plugin's: `mcp__plugin_kitting_kitting__<tool>`. Serials such as `L-0101` are examples: make a lamp
build with a serial first when a case needs history (case 2 assumes `B-0007` made lamp `L-0042`).

## Expected tool sequences

| Case | Prompt | Expected sequence | Must not |
| --- | --- | --- | --- |
| `plan-warm-lamps` | Plan 3 warm lamps and tell me what to order (go-ahead given for builds and drafts) | `search_parts` or `get_part` (find the `warm` Assembly) → `explode_assembly` (qty 3, `use_stock`) → `plan_build` x3 (one serial each) → `get_shortages` → `create_draft_pos` (only if something is short; the demo may need nothing for 3 lamps) | `mark_po_sent`, inventing serials, planning with the `std` Assembly |
| `trace-faulty-led` | The LED in lamp L-0042 is faulty: which other lamps used the same batch? | `list_builds` (query `L-0042`) → `get_build` (as-built: LED serial) → `list_moves` (receipt of that serial, then the same part's receipts) → `list_builds` per neighbouring serial | any write (`adjust_stock`...); claiming a supplier lot Kitting does not record |
| `add-felt-pads` | Add 2 felt pads to the base, safely (do not activate) | `search_parts` → `get_part` (where-used) → `get_assembly` → `set_assembly_lines` (complete list, `PAD-FELT` 6) → `get_assembly` with the new `revision` | `activate_assembly`, editing the active revision, sending only the changed line |
| `record-print-run` | We printed 2 plates of cable clips: record it, with the printer time and filament | `search_parts` (find `LAMP-CLIP`) → `get_assembly` (batch 24, machine time) → `record_build` (`batches` 2) | `plan_build` + `complete_build` instead of one step, an undo link (ledger write) |

In a real conversation each write is confirmed first; the cases give the go-ahead in the prompt so one turn can
reach the writes. A second run without that sentence should stop before the first write and ask.
