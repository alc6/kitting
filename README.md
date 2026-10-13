# Kitting

A lightweight, open-source mini-MRP for small hardware makers: parts, bills of materials,
stock, purchasing and builds with per-serial traceability.

It runs entirely on Cloudflare (Workers + D1 + Access): no server to manage, and the free
tiers cover a small workshop. Deployment is one command.

> **Status:** v1 is feature-complete (milestones M1–M5): catalogue, BoMs, stock, builds
> with per-serial traceability, and purchasing. See [docs/plan.md](docs/plan.md).

## What it does

- **Parts**: `buy` (purchased, stocked), `make` (assembled in-house, stockable),
  `kit` (phantom: always exploded into its parent) and `fee` (cost only, e.g. eco-fees).
  Units (pcs, m, kg…), standard cost, selling price, serial tracking, and a **product image**
  (photos taken on a tablet are shrunk in the browser before upload; optional, stored in R2).
- **Suppliers** with contact details, and **several suppliers per part**: each offer has its
  reference, price, MOQ, pack size and lead time; one is preferred and drives purchasing.
- **Prices**: an append-only history of standard costs, supplier prices and selling prices
  (who, when, from where), plus the prices actually paid on receipts, charted on each part.
- **Margins**: selling price per product, optionally per BoM variant; planned margin against
  the cost roll-up and actual margin of completed builds, as an amount, a rate on the selling
  price and a markup on cost. Each item has a **margin history**: a chart and a list of every
  day a component cost or the selling price moved it, plus the actual margin of each build.
  Planned margins follow standard costs; saving a supplier price can update the standard cost too.
- **Bills of materials** with variants (e.g. `std`, `warm`) and revisions: line editor,
  "new revision" copies, one active BoM per variant, cycle protection, expandable tree with
  cumulative quantities and cost roll-up (flagged incomplete when a cost is missing), a
  **structure diagram** (nested sub-assemblies and kits drawn as boxes and links, with
  quantities and costs, by depth or assemblies only, zoom and pan), flat exploded list for
  N units (CSV), and where-used on every part.
- **Stock** as an append-only ledger of moves: on-hand is always the sum of moves.
  Adjustments with a reason, inventory count sheet (enter counted quantities, the
  differences are posted), moves ledger with filters, valuation by two methods side by side
  (standard cost valid on the "as of" date, and weighted average of the prices paid) and CSV
  exports for year-end.
- **Builds** of finished products or sub-assemblies: pick the variant, plan a date, enter the
  serial; the pick list explodes the BoM, takes sub-assemblies from stock when available (or
  "build now"), asks one serial per serial-tracked unit, and completion posts everything in one
  transaction. The as-built record answers "what exactly is inside serial #0042", and search
  answers "which build used LED serial X".
- **Purchasing**: shortages for all planned builds (need − on hand − on order, rounded to MOQ
  and pack size, grouped by preferred supplier, any line can be ordered from another supplier),
  one-click draft POs per supplier at the supplier's price, PO editing, "mark as sent", partial
  receipts (with serials), closing short-shipped POs, CSV for the supplier.
- **Dashboard**: shortages, parts below zero or below MOQ, open POs (overdue flagged), planned
  and last builds, stock value.
- **CSV import** for suppliers, parts, supplier offers, BoMs and initial stock, with a dry-run preview and
  row-level errors. Nothing is written until you confirm, and the commit is atomic.
  Works with Excel files from French or English locales (`;` or `,`, decimal comma or point).
- **CSV export** in the same formats, for round-trips and backups.
- **Search** across parts, BoMs, builds (including component serials), POs and suppliers
  from the header (`/` or Ctrl/Cmd+K).
- **History and undo**: every change to the catalogue, documents, users and settings is kept, field by
  field, with who made it and from where; any change can be reviewed and undone (see below).
- **AI assistants** (optional): an MCP server lets Claude, ChatGPT or any MCP client read parts,
  BoMs, stock, builds and purchasing, with the permissions each person grants and their role
  checked on every request (see [Connect an AI assistant](#connect-an-ai-assistant-mcp)).
- Modern, tablet-first UI built on the [shadcn/ui](https://ui.shadcn.com) design system: left
  sidebar, light / dark / system theme, French and English.

## Non-goals (v1)

Quotes, invoicing, accounting, multiple companies, multiple warehouses or locations,
barcode scanning, scheduling or capacity planning.

## How it works

- Cloudflare Access sits in front of the app and signs users in (Google, one-time PIN…).
- The Worker verifies the Access JWT on **every** request and refuses anything else (403).
  The signed-in email is stored on every write.
- Server-rendered HTML (Hono JSX) with a pinch of [htmx](https://htmx.org); no SPA,
  no CDN, strict Content-Security-Policy. Styling is Tailwind CSS v4 with shadcn/ui's tokens
  and component recipes, ported to server-side JSX (no React in the browser); the stylesheet
  is built at deploy time.
- Data lives in a D1 (SQLite) database. Money is stored in integer cents, quantities in
  integer thousandths: no floating-point rounding errors. Product images, if enabled, live in
  an R2 bucket.

## Roles

Cloudflare Access decides who can sign in; Kitting decides what each person may do.

| Role | Can |
| --- | --- |
| Viewer | Look at everything and change nothing. Anyone not listed on the Users page is a viewer (and cannot connect an AI assistant). |
| Operator | Shop floor: run builds, adjust and count stock, receive deliveries. |
| Planner | Office: also edit parts, BoMs, suppliers, offers, prices and purchase orders; Import / Export. |
| Administrator | Also confirm imports, delete, archive, restore backups and manage users. |

- The emails in `ADMIN_EMAILS` are always administrators. They give roles to everyone else on
  **Users** (`/users`); a role applies on the person's next page load.
- Costs, prices, valuations and margins are hidden from viewers and operators unless an
  administrator ticks *Viewers and operators see costs* on the same page. Planners and
  administrators always see them.
- Every write is checked on the server, not only hidden in the page: a role that may not do
  something gets a 403.

## History and undo

Nothing edited in the catalogue or on documents is lost: every save, import, build, receipt or role change is
recorded as one **change**, with who made it, when, from where (a page, an import, an undo, an AI assistant
over MCP) and every row it touched, before and after.

- **Recent changes** (sidebar, everyone) lists them, newest first, filtered by origin, person, dates or text.
  A change's page shows each row it touched field by field ("quantity: 1 → 3").
- Parts, suppliers, BoMs and purchase orders have a **History** tab with their own changes and those of their
  offers or lines. Records that existed before the history was installed (migration 0005) have no creation
  entry; everything done to them since is recorded and can be undone.
- **Undo** puts the previous values back as a new change (which can itself be undone). It is refused, and
  nothing is changed, if a row was edited since (undo the later change first), if a deleted row is used since,
  or if what it would restore no longer fits (a reference now taken by another part…). The message says which
  row and who changed it.
- Changes that moved stock or recorded a build (completions, receipts, adjustments, counts) cannot be undone:
  correct them with a new movement, as before. Neither can replacing or removing a product image, whose old
  file is deleted.
- Undoing needs the right to edit everything the change touched (an operator can undo a planned build, not a
  part edit). Viewers and operators who may not see costs see "Hidden" instead of amounts in the history.
- The database refuses any write to these tables made outside a change. To fix data by hand with
  `wrangler d1 execute --file`, open a change in the same file:

  ```sql
  INSERT INTO change_sets (user_email, source, summary) VALUES ('admin@example.com', 'migration', 'Fix part units');
  INSERT INTO change_context (id, change_set_id) VALUES (1, (SELECT max(id) FROM change_sets));
  UPDATE parts SET unit = 'pcs' WHERE unit = '';
  DELETE FROM change_context;
  ```

## Deploy in five steps

You need a Cloudflare account with a domain on it, Node.js 20+, and this repository
(fork or clone). Run `npm ci` once.

1. **Create the D1 database**

   ```bash
   npx wrangler login
   npx wrangler d1 create kitting
   npx wrangler r2 bucket create kitting-images
   cp wrangler.example.jsonc wrangler.jsonc
   ```

   Put the printed `database_id` in `wrangler.jsonc`, and set the `routes` pattern to the
   hostname you will use (for example `kitting.example.com`). `wrangler.jsonc` is
   gitignored: it never ends up in the repository. The R2 bucket holds product images and is
   optional: without it, delete the `r2_buckets` block from `wrangler.jsonc` and the app runs
   without images. Likewise the `kv_namespaces` block is for the optional MCP server
   ([Connect an AI assistant](#connect-an-ai-assistant-mcp)): create its namespace or delete the block.

2. **Apply the migrations**

   ```bash
   npx wrangler d1 migrations apply DB --remote
   ```

3. **Create the Access application** (details in [Cloudflare Access setup](#cloudflare-access-setup)):
   a self-hosted application on your hostname, an identity provider, and an Allow
   policy. Note your team domain and the application's AUD tag.

4. **Set the variables** in `wrangler.jsonc` → `vars`:

   | Variable | Example | Meaning |
   | --- | --- | --- |
   | `TEAM_DOMAIN` | `acme.cloudflareaccess.com` | Your Zero Trust team domain. |
   | `ACCESS_AUD` | `4f1c…9a` | AUD tag of the Access application. |
   | `ADMIN_EMAILS` | `ops@example.com,boss@example.com` | Always administrators (see [Roles](#roles)). |
   | `DEFAULT_LOCALE` | `fr` | `en` or `fr`. Users can switch in the footer. |
   | `CURRENCY` | `EUR` | ISO code used to display money. |
   | `ENVIRONMENT` | `production` | Keep `production`. |
   | `DEV_AUTH_EMAIL` | *(empty)* | Keep empty. Only used by local development. |

5. **Deploy**

   ```bash
   npm run deploy
   ```

   This applies any pending migrations, then deploys the Worker on your custom domain.
   Run the same command for every update.

Then open your hostname, sign in through Access, and load your data from
**Import / Export** (suppliers → parts → supplier offers → BoMs → stock). To try the app first, import the
fictional dataset in [`examples/demo/`](examples/demo/).

### Deploy from GitHub Actions instead

The repository ships a manual **Deploy** workflow (`.github/workflows/deploy.yml`) that
generates `wrangler.jsonc` from repository settings, so nothing account-specific is
committed. In *Settings → Secrets and variables → Actions*, add:

- secrets `CLOUDFLARE_API_TOKEN` (permissions: *Workers Scripts: Edit*, *D1: Edit*,
  *Workers Routes: Edit*, *Zone: Read* on your zone, plus *Workers R2 Storage: Edit* if you
  use images) and `CLOUDFLARE_ACCOUNT_ID`;
- variables `KITTING_DOMAIN`, `D1_DATABASE_ID`, `TEAM_DOMAIN`, `ACCESS_AUD`,
  `ADMIN_EMAILS` and, optionally, `DEFAULT_LOCALE`, `CURRENCY`, `WORKER_NAME`,
  `D1_DATABASE_NAME`, `IMAGES_BUCKET` (the name of an R2 bucket created beforehand with
  `npx wrangler r2 bucket create`; product images are off without it), `OAUTH_KV_ID` (the id
  of a KV namespace for the MCP server, see [Connect an AI assistant](#connect-an-ai-assistant-mcp);
  MCP is off without it).

Then run *Actions → Deploy → Run workflow*. It runs the checks, applies migrations and
deploys. You can generate the same file locally with
`KITTING_DOMAIN=… D1_DATABASE_ID=… TEAM_DOMAIN=… ACCESS_AUD=… ADMIN_EMAILS=… npm run config`.

The generated configuration always forces `ENVIRONMENT=production`, an empty
`DEV_AUTH_EMAIL`, `workers_dev: false` and `preview_urls: false`.

## Cloudflare Access setup

Access is what lets people in; the Worker double-checks every request.

1. **Identity provider.** In the [Zero Trust dashboard](https://one.dash.cloudflare.com),
   go to *Settings → Authentication → Login methods* and add **Google** (needs an OAuth
   client) or **One-time PIN** (codes sent by email, nothing to configure).
2. **Application.** *Access → Applications → Add an application → Self-hosted*.
   - Application domain: your hostname, e.g. `kitting.example.com`, with no path.
   - Identity providers: the one(s) from step 1.
   - Session duration: whatever suits you (e.g. 1 week on shop-floor tablets).
3. **Policy.** Add a policy with action **Allow** and a rule such as
   *Include → Emails ending in → `@example.com`*, or list individual emails.
4. **AUD tag.** Open the application → *Overview* (or *Basic information*) and copy the
   **Application Audience (AUD) Tag** into `ACCESS_AUD`.
5. **Team domain.** *Settings → Custom pages* (or the URL of the login page) shows your
   team domain, e.g. `acme.cloudflareaccess.com`: put it in `TEAM_DOMAIN`.

Why the Worker is safe even if Access is misconfigured: it only accepts requests that carry
a valid `Cf-Access-Jwt-Assertion` signed by your team's keys for your AUD. Anything else
gets a 403. `workers_dev` and preview URLs are disabled so the app is only reachable on the
domain Access protects.

## Connect an AI assistant (MCP)

Optional. Kitting can serve an [MCP](https://modelcontextprotocol.io) server at `https://<your-domain>/mcp`,
so an AI assistant (Claude, ChatGPT or any MCP client) can look things up and, if you allow it, do the paperwork:
create parts and BoMs, update prices, adjust stock, plan and complete builds, draft and receive purchase orders.
It acts in your name, with your role, and every change it makes is in **Recent changes**.

| Permission (scope) | Tools |
| --- | --- |
| `catalog:read` | `search_parts`, `get_part` (details, offers, on hand, BoMs, where-used), `get_bom` (tree with per-parent and cumulative quantities, cost roll-up), `explode_bom` (flat list for a quantity, optionally using sub-assemblies in stock), `list_recent_changes` (the change history with field diffs) |
| `catalog:write` | `create_part`, `update_part` (never prices), `create_supplier`, `update_supplier`, `create_bom` (a draft, empty or copied), `set_bom_lines` (replaces all lines at once; on an active BoM it creates a new draft revision instead), `new_bom_revision`, `activate_bom` |
| `prices:write` | `set_standard_cost`, `set_sale_price` (of a part or a BoM variant), `upsert_supplier_offer` (also: make it preferred, use its price as the standard cost) |
| `catalog:archive` | `archive_part`, `unarchive_part`, `archive_bom` |
| `stock:read` | `stock_on_hand` (below zero, below MOQ, in stock), `list_moves` |
| `stock:write` | `adjust_stock`, `count_stock` |
| `builds:read` | `list_builds` (also finds the build that used a component serial), `get_build` (pick list, or the as-built record) |
| `builds:write` | `plan_build`, `complete_build` (serials and "take from stock / build now" choices, checked like the pick list), `cancel_build` |
| `purchasing:read` | `get_shortages`, `list_purchase_orders`, `get_purchase_order` |
| `purchasing:write` | `create_draft_pos` (from the shortages), `update_draft_po`, `mark_po_sent`, `receive_po`, `cancel_po`, `close_po` |

A write permission is offered only to roles that may do it in the app (an operator sees `stock:write`, never
`catalog:write`), and each tool checks the same rules as its page.

How it stays safe:

- Each person connects their own assistant, and only people listed on **Users** (or in `ADMIN_EMAILS`) can:
  someone who signs in without being listed is a viewer in the app, but the consent page tells them to ask an
  administrator first. The assistant opens that consent page on your domain, behind Access like every page,
  where the person ticks what it may do (only what their role allows; write permissions are never pre-ticked
  unless the assistant asks for them) and clicks Allow. The assistant gets OAuth tokens for that, never the
  Access session.
- Every MCP request checks the person again: still listed, current role (a demotion applies to the next call),
  and costs, prices and margins stay hidden from roles that may not see them. Quantities and amounts are
  decimals.
- The assistant is told to confirm with you before any change. Every change is one entry in **Recent changes**,
  marked with the assistant's name, and each tool's answer gives its link: undo it there like any other change.
  Stock and build ledger operations (adjustments, counts, receipts, build completions) cannot be undone, as in
  the app: they are corrected with reverse movements. BoMs are only changed through draft revisions: an active
  BoM stays as it is until you activate the new revision.
- Never over MCP: permanent deletes (parts, suppliers, BoMs, purchase orders, offers, images), undoing a change
  (undo stays in the app), user management, backups and restores, CSV imports, image uploads.
- **Connected apps** (bottom of the sidebar) lists your connections with *Revoke*; administrators see and
  revoke everyone's. Revoking stops the assistant at once.
- Lifetimes: access tokens last one hour and are renewed automatically for 30 days after consent; then the
  assistant asks again, through Access. Unused client registrations expire after 90 days.
- `/mcp`, `/token`, `/register` and `/.well-known/oauth-*` skip Access (they check OAuth tokens instead), so
  removing someone from the Access policy alone does not disconnect their assistant. **To offboard someone:**
  1. remove them from the Access policy (no more sign-in, no new connection);
  2. remove them on **Users**: this also revokes all their assistant connections at once (and any connection
     made before is refused on its next call, since they are no longer listed).

  `/register` is public by design: registering gives an app nothing until someone signs in and allows it.

Set it up:

1. **Create the KV namespace** that holds clients, grants and tokens (hashed):

   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```

   Put the printed id in the `kv_namespaces` block of `wrangler.jsonc` (or set the `OAUTH_KV_ID` variable for
   the GitHub workflow, whose API token then also needs *Workers KV Storage: Edit*). Without this binding the
   MCP routes answer 404 and the app works as before; delete the block if you do not want MCP.
2. **Let the OAuth paths through Access.** In Zero Trust, *Access → Applications → Add an application →
   Self-hosted*, named e.g. *Kitting MCP*, on your hostname with four paths: `mcp`, `token`, `register` and
   `.well-known/*`. Give it one policy with action **Bypass** and *Include → Everyone*. Access applies the most
   specific path, so everything else (including `/authorize`, the consent page) stays behind your main
   application.
3. **Deploy** (`npm run deploy`, or the workflow).
4. **Add the connector** in your AI client: a custom connector (remote MCP server) with the URL
   `https://kitting.example.com/mcp`. The client registers itself, opens your browser on the consent page, and
   is connected once you click Allow.

To try it locally, start the Worker so that it sees `http://localhost` (OAuth runs only over HTTPS or on
localhost), then point the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at it:

```bash
npm run css && npx wrangler dev --local-upstream localhost:8787 --upstream-protocol http
npx @modelcontextprotocol/inspector   # Streamable HTTP, URL http://localhost:8787/mcp, then connect
```

## Use Kitting from Claude

An assistant needs two things: the **tools** (the MCP connector above) and the **know-how** (the Kitting skill: what
a kit or a revision is, which tools to chain to plan a build or change a BoM, when to ask before writing). This
repository ships both as a Claude plugin, `plugins/kitting`, listed in a plugin marketplace
(`.claude-plugin/marketplace.json`). Pick the path that matches your client; the connector is the same everywhere
and still needs the setup above (`https://<your-domain>/mcp`).

**Claude Code and Cowork (plugin: connector and skill together).**

1. Add this repository as a marketplace and install the plugin (use your fork or clone's GitHub path):

   ```
   /plugin marketplace add <owner>/kitting
   /plugin install kitting@kitting-plugins
   ```

   or in one step, `/plugin install kitting --marketplace <owner>/kitting` (Claude Code 2.1.275+); from a shell:
   `claude plugin marketplace add <owner>/kitting`, then `claude plugin install kitting@kitting-plugins`. In Cowork or on claude.ai: *Customize > Plugins > Add >
   Add marketplace*, with the repository URL.
2. Tell the plugin where your deployment is: it reads the environment variable `KITTING_MCP_URL` (in
   `plugins/kitting/.mcp.json`), so set it before starting Claude Code:

   ```bash
   export KITTING_MCP_URL=https://kitting.example.com/mcp
   ```

3. Run `/mcp`, pick `plugin:kitting:kitting` and sign in: the browser opens Kitting's consent page, where you tick
   what the assistant may do. The skill is `kitting:kitting` and loads on its own when you talk about parts, BoMs,
   stock, builds or purchase orders.

Claude Code expands `${KITTING_MCP_URL}` in the plugin's `.mcp.json` (checked against a local server: it connects to
that URL, then starts the OAuth sign-in). claude.ai and Cowork list a bundled remote
server on the plugin's *Connectors* tab only when its URL is fixed, and do not expand variables: there, use a
private copy of the plugin with your URL written in (below), or add the connector by hand as in the next path.

**claude.ai and Claude desktop chat (connector, plus the skill as a zip).**

1. In the client's connector settings add a custom connector (remote MCP server) with the URL
   `https://<your-domain>/mcp`, then sign in as above.
2. `npm run skill:zip` builds `dist/kitting-skill.zip` (gitignored; no dependency, Node only). Upload it in
   *Customize > Skills*, and turn it on. Without Node: zip the folder `plugins/kitting/skills/kitting` itself (so
   the archive's top level is `kitting/` containing `SKILL.md`), for example
   `cd plugins/kitting/skills && zip -r kitting-skill.zip kitting`, or *Compress* in Finder / *Send to > Compressed
   folder* in Explorer on that folder.

Alternatively, zip the whole `plugins/kitting` folder and upload it with *Customize > Plugins > Add > Upload
plugin*: you get the skill and the connector entry in one step (with the URL fixed in your private copy).

**Other MCP clients (ChatGPT, Inspector, your own).** Add the connector only. The server sends instructions when a
client connects (read before write, confirm before changing anything, BoMs through draft revisions, costs can be
hidden) and mentions the skill. To give such a client the full know-how, paste `plugins/kitting/skills/kitting/SKILL.md`
and its `references/` into its project instructions.

**A private copy of the plugin for your company.** Fork or copy this repository (or only the `plugins/kitting`
folder and a marketplace file) into your own git host, then:

- in `plugins/kitting/.mcp.json`, replace `"${KITTING_MCP_URL}"` by your fixed URL, e.g.
  `"https://kitting.mycompany.example/mcp"` (a real URL is what claude.ai and Cowork need; Claude Code accepts it
  too), and nobody has to set a variable;
- rename `name` in `plugins/kitting/.claude-plugin/plugin.json` and the marketplace entry if you want your own
  identity, add your company's rules to the skill (supplier habits, naming conventions, who approves what) in
  `SKILL.md`, and keep `version` equal to `package.json`'s (a test checks it);
- give your people `/plugin marketplace add <your-org>/<your-repo>` (an organization administrator can also
  require the marketplace and plugin on every machine, see Anthropic's "Manage plugins for your organization").

The file holds no secret, only the public URL of your deployment: access is decided by the OAuth sign-in and the
user's role, never by the plugin. When you change a tool (see `CLAUDE.md`), update `references/tools.md`: the test
suite fails when the skill and the tools disagree.

## Local development

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc   # placeholders are fine locally
cp .dev.vars.example .dev.vars              # ENVIRONMENT=development + DEV_AUTH_EMAIL
npm run db:migrate:local
npm run dev                                 # builds the CSS, then http://localhost:8787
```

In development the Access check is replaced by `DEV_AUTH_EMAIL`. This bypass is honoured
only when `ENVIRONMENT` is exactly `development`.

| Command | What it does |
| --- | --- |
| `npm run check` | Typecheck, lint and tests. |
| `npm test` | Tests in the Workers runtime against a real (local) D1. |
| `npm run db:generate` | Create a migration after editing `src/db/schema.ts`. |
| `npm run format` | Format and fix lint issues (Biome). |
| `npm run css` | Build `public/static/app.css` (Tailwind); `npm run css:watch` while editing. |

## CSV formats

Header names are case-insensitive. Separator `,` `;` or tab; decimals with `.` or `,`;
UTF-8 or Windows-1252. Each import screen offers a template and an export of the
current data.

- `suppliers.csv`: `name,email,phone,notes`. Upsert by name.
- `parts.csv`: `ref,name,kind,unit,cost,sale_price,supplier,supplier_ref,moq,pack_size,lead_days,track_serial,notes`.
  Upsert by `ref`; only `ref` is required in the header, and columns left out keep their
  current values (so `ref,cost` updates prices only). `supplier` is the preferred supplier's
  name and `supplier_ref`…`lead_days` its terms. An empty `cost` means "unknown"; `sale_price`
  is the selling price excluding VAT.
- `part_suppliers.csv`: `ref,supplier,supplier_ref,price,moq,pack_size,lead_days,preferred,notes,set_standard_cost`.
  One row per part and supplier (upsert by both); `preferred` = `yes` makes that supplier the
  one used for shortages and draft POs, and `set_standard_cost` = `yes` also makes the row's price
  the part's standard cost (what planned costs and margins use). Every price change is kept in the
  price history.
- `stock.csv`: `ref,qty,serial,unit_cost`. Sets on-hand to the counted `qty` with a
  `count` move for the difference. For serial-tracked parts that have no stock yet, use one
  row per serial with `qty` 1.
- `boms.csv`: `parent_ref,code,revision,status,component_ref,qty` (+ optional `sale_price`, `notes`).
  One row per line, grouped by `parent_ref` + `code` + `revision`; each BoM mentioned gets
  exactly the lines in the file. `code` defaults to `std`, `revision` to `Rev1`, `status` to
  `draft`. Importing a BoM as `active` archives the previously active one of the same variant.
  `sale_price` (one value per BoM) is that variant's selling price, overriding the part's.

## Backups

- **Import / Export → Backup** (admins) downloads the whole database, roles and change history included, as one
  JSON file. An admin can restore it (same Kitting version) on the same or another deployment: a preview shows what
  the file contains, then everything is replaced in one transaction.
- A restore appears in **Recent changes** as one change that cannot be undone (restore another backup instead).
- Product images are not in that file: it only records which image each part points to. The
  images stay in the R2 bucket (copy it with any S3-compatible tool if you need an offsite
  copy). An image replaced or removed after a backup was taken is gone from the bucket, so
  restoring that backup shows those parts without an image.
- D1 also keeps 30 days of point-in-time history (*Time Travel*), and Wrangler can dump SQL:

  ```bash
  npx wrangler d1 export kitting --remote --output kitting-backup.sql
  ```

## License

[MIT](LICENSE)
