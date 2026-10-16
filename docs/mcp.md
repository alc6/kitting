# AI assistants (MCP)

Kitting can run an [MCP](https://modelcontextprotocol.io) server at `https://<your-domain>/mcp`. With it, Claude,
ChatGPT or any other MCP client can look things up for you and, if you allow it, do the paperwork: create parts
and assemblies, update prices, adjust stock, plan and complete builds, draft and receive purchase orders.

The assistant acts as you, with your role. Everything it changes shows up in **Recent changes** with its name,
and can be undone there like any other change.

This is optional. Without the setup below, the MCP routes answer 404 and the rest of the app is unaffected.

## Setup

1. **Create a KV namespace.** It stores the registered clients, the grants and the (hashed) tokens.

   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```

   Put its ID in the `kv_namespaces` block of `wrangler.jsonc`, or in the `OAUTH_KV_ID` variable if you deploy
   from GitHub Actions. The Terraform module creates it, and the Access application of the next step, with
   `enable_mcp = true`.

2. **Let the OAuth paths through Access.** These paths check OAuth tokens themselves, so Access must not block
   them. In Zero Trust, add a second self-hosted application, for example "Kitting MCP", on your hostname with
   five paths: `health`, `mcp`, `token`, `register` and `.well-known/*`. Give it a single policy with the action *Bypass*
   and *Include → Everyone*. Access applies the most specific path, so the rest of the app, including the
   consent page, stays behind your main application.

3. **Deploy** with `npm run deploy` or the GitHub workflow.

4. **Add the connector** in your AI client: a custom connector (remote MCP server) with the URL
   `https://kitting.example.com/mcp`. The client registers itself and opens your browser on Kitting's consent
   page. Tick what it may do, click Allow, and it's connected.

## What an assistant can do

When connecting, each person picks permissions (scopes) on the consent page. They are only offered what their
role allows: an operator can grant `stock:write` but not `catalog:write`. Each tool then checks the same rules as
the corresponding page.

| Scope | Tools |
| --- | --- |
| `catalog:read` | `search_parts`, `get_part`, `get_assembly`, `explode_assembly`, `list_machines`, `list_recent_changes` |
| `catalog:write` | `create_part`, `update_part`, `create_supplier`, `update_supplier`, `create_assembly`, `set_assembly_lines`, `set_assembly_production`, `new_assembly_revision`, `activate_assembly` |
| `prices:write` | `set_standard_cost`, `set_sale_price`, `upsert_supplier_offer` |
| `catalog:archive` | `archive_part`, `unarchive_part`, `archive_assembly` |
| `stock:read` | `stock_on_hand`, `list_moves` |
| `stock:write` | `adjust_stock`, `count_stock` |
| `builds:read` | `list_builds`, `get_build` |
| `builds:write` | `plan_build`, `complete_build`, `record_build`, `cancel_build` |
| `purchasing:read` | `get_shortages`, `list_purchase_orders`, `get_purchase_order` |
| `purchasing:write` | `create_draft_pos`, `create_po`, `update_draft_po`, `mark_po_sent`, `receive_po`, `cancel_po`, `close_po`, `record_po_shipment` |

Parts with options (a colour, a size) are handled by the same tools: they take and return `options` as option
name → value, such as `{"Colour": "white"}`, for stock, builds, shortages and purchase orders (D193). Defining a part's
options is done in the app.

Some things are never available to an assistant: permanent deletes, undoing changes, managing users, backups,
CSV imports and photo uploads. Assemblies only change through draft revisions, so an active assembly stays as it
is until someone activates the new revision.

The full description of each tool is in
[`plugins/kitting/skills/kitting/references/tools.md`](../plugins/kitting/skills/kitting/references/tools.md).

## How access is controlled

- Only people listed on the Users page, or in `ADMIN_EMAILS`, can connect an assistant. The consent page is
  behind Access like the rest of the app, and the assistant receives its own OAuth tokens, never your Access
  session.
- Every call checks the person again: still listed, current role. A demotion applies from the next call. Costs
  and prices stay hidden from roles that can't see them.
- The assistant is instructed to confirm with you before changing anything, and each answer links to the change
  it made.
- **Connected apps**, at the bottom of the sidebar, lists your connections and lets you revoke them.
  Administrators see and can revoke everyone's.
- Access tokens last an hour and renew automatically for 30 days after consent. After that the assistant has to
  ask again. Client registrations that are never used expire after 90 days. `/register` is public by design:
  registering gives an app nothing until someone signs in and allows it.

Because the MCP paths bypass Access, removing someone from the Access policy doesn't disconnect their assistant
on its own. To offboard someone, remove them from the Access policy **and** from the Users page. Removing them
from Users revokes all their connections at once.

## Using Kitting from Claude

An assistant works best with two things: the tools, which come from the connector above, and the know-how, which
comes from the Kitting skill. The skill explains what a kit or a revision is, which tools to chain to plan a build
or change an assembly, and when to ask before writing. This repository ships both as a Claude plugin in
`plugins/kitting`, listed in a plugin marketplace (`.claude-plugin/marketplace.json`).

### Claude Code and Cowork

Add the repository as a marketplace and install the plugin, using the GitHub path of your copy:

```
/plugin marketplace add <owner>/kitting
/plugin install kitting@kitting-plugins
```

In Cowork or on claude.ai, use *Customize → Plugins → Add → Add marketplace* with the repository URL.

The plugin reads your deployment's address from the `KITTING_MCP_URL` environment variable. Set it before
starting Claude Code:

```bash
export KITTING_MCP_URL=https://kitting.example.com/mcp
```

Then run `/mcp`, pick `plugin:kitting:kitting` and sign in. The skill loads by itself when you talk about parts,
assemblies, stock, builds or purchase orders.

claude.ai and Cowork don't expand environment variables in a plugin's connector URL. There, either add the
connector by hand as described below, or use a copy of the plugin with your URL written in (see the last
section).

### claude.ai and the Claude desktop app

1. In the connector settings, add a custom connector with the URL `https://<your-domain>/mcp`, then sign in.
2. Run `npm run skill:zip` to build `dist/kitting-skill.zip`, and upload it under *Customize → Skills*. Without
   Node, zip the `plugins/kitting/skills/kitting` folder yourself, so that the archive contains a `kitting/`
   folder with `SKILL.md` inside.

### Other MCP clients

Add the connector only. When a client connects, the server sends short instructions: read before writing,
confirm before changing anything, change assemblies through draft revisions. To give such a client the full
know-how, paste `plugins/kitting/skills/kitting/SKILL.md` and its `references/` folder into its project
instructions.

### A plugin for your company

To give your team a plugin that works without setting any variable, copy this repository (or just
`plugins/kitting` and a marketplace file) to your own git host, then:

- in `plugins/kitting/.mcp.json`, replace `${KITTING_MCP_URL}` with your URL, for example
  `https://kitting.mycompany.example/mcp`;
- optionally rename the plugin in `plugins/kitting/.claude-plugin/plugin.json` and in the marketplace file, and
  add your own rules to `SKILL.md`, such as naming conventions, supplier habits or who approves what. Keep
  `version` equal to the one in `package.json`; a test checks it;
- have your team run `/plugin marketplace add <your-org>/<your-repo>`. An organization administrator can also
  make the marketplace and the plugin available on every machine.

The plugin holds no secret, only the public URL of your deployment. What an assistant can do is decided by the
sign-in and the person's role.

## Trying it locally

OAuth only runs over HTTPS or on localhost, so start the Worker in a way that it sees `http://localhost`, then
point the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at it:

```bash
npm run css && npx wrangler dev --local-upstream localhost:8787 --upstream-protocol http
npx @modelcontextprotocol/inspector
```

In the Inspector, choose Streamable HTTP with the URL `http://localhost:8787/mcp` and connect. Your local
`wrangler.jsonc` needs the `kv_namespaces` block for the MCP routes to exist.
