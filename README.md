# Kitting

A lightweight, open-source mini-MRP for small hardware makers: parts, bills of materials,
stock, purchasing and builds with per-serial traceability.

It runs entirely on Cloudflare (Workers + D1 + Access): no server to manage, and the free
tiers cover a small workshop. Deployment is one command.

> **Status:** milestone M1 (foundation) is done: suppliers, parts, CSV import with
> dry-run, initial stock. BoMs, stock operations, builds and purchasing are coming
> next, one milestone at a time. See [docs/plan.md](docs/plan.md).

## What it does

- **Parts**: `buy` (purchased, stocked), `make` (assembled in-house, stockable),
  `kit` (phantom: always exploded into its parent) and `fee` (cost only, e.g. eco-fees).
  Units (pcs, m, kg…), standard cost, supplier, MOQ, pack size, lead time, serial tracking.
- **Suppliers** with contact details.
- **Stock** as an append-only ledger of moves: on-hand is always the sum of moves.
- **CSV import** for suppliers, parts and initial stock, with a dry-run preview and
  row-level errors. Nothing is written until you confirm, and the commit is atomic.
  Works with Excel files from French or English locales (`;` or `,`, decimal comma or point).
- **CSV export** in the same formats, for round-trips and backups.
- Tablet-first UI, French and English.

## Non-goals (v1)

Quotes, invoicing, accounting, multiple companies, multiple warehouses or locations,
barcode scanning, scheduling or capacity planning, per-user roles.
All signed-in users are equal; a list of admin emails gates destructive actions
(import commit, delete, archive).

## How it works

- Cloudflare Access sits in front of the app and signs users in (Google, one-time PIN…).
- The Worker verifies the Access JWT on **every** request and refuses anything else (403).
  The signed-in email is stored on every write.
- Server-rendered HTML (Hono JSX) with a pinch of [htmx](https://htmx.org); no SPA,
  no CDN, strict Content-Security-Policy.
- Data lives in a D1 (SQLite) database. Money is stored in integer cents, quantities in
  integer thousandths: no floating-point rounding errors.

## Deploy in five steps

You need a Cloudflare account with a domain on it, Node.js 20+, and this repository
(fork or clone). Run `npm ci` once.

1. **Create the D1 database**

   ```bash
   npx wrangler login
   npx wrangler d1 create kitting
   cp wrangler.example.jsonc wrangler.jsonc
   ```

   Put the printed `database_id` in `wrangler.jsonc`, and set the `routes` pattern to the
   hostname you will use (for example `kitting.example.com`). `wrangler.jsonc` is
   gitignored: it never ends up in the repository.

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
   | `ADMIN_EMAILS` | `ops@example.com,boss@example.com` | Who may import, delete and archive. |
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
**Import / Export** (suppliers → parts → stock). To try the app first, import the
fictional dataset in [`examples/demo/`](examples/demo/).

### Deploy from GitHub Actions instead

The repository ships a manual **Deploy** workflow (`.github/workflows/deploy.yml`) that
generates `wrangler.jsonc` from repository settings, so nothing account-specific is
committed. In *Settings → Secrets and variables → Actions*, add:

- secrets `CLOUDFLARE_API_TOKEN` (permissions: *Workers Scripts: Edit*, *D1: Edit*,
  *Workers Routes: Edit*, *Zone: Read* on your zone) and `CLOUDFLARE_ACCOUNT_ID`;
- variables `KITTING_DOMAIN`, `D1_DATABASE_ID`, `TEAM_DOMAIN`, `ACCESS_AUD`,
  `ADMIN_EMAILS` and, optionally, `DEFAULT_LOCALE`, `CURRENCY`, `WORKER_NAME`,
  `D1_DATABASE_NAME`.

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

## Local development

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc   # placeholders are fine locally
cp .dev.vars.example .dev.vars              # ENVIRONMENT=development + DEV_AUTH_EMAIL
npm run db:migrate:local
npm run dev                                 # http://localhost:8787
```

In development the Access check is replaced by `DEV_AUTH_EMAIL`. This bypass is honoured
only when `ENVIRONMENT` is exactly `development`.

| Command | What it does |
| --- | --- |
| `npm run check` | Typecheck, lint and tests. |
| `npm test` | Tests in the Workers runtime against a real (local) D1. |
| `npm run db:generate` | Create a migration after editing `src/db/schema.ts`. |
| `npm run format` | Format and fix lint issues (Biome). |

## CSV formats

Header names are case-insensitive. Separator `,` `;` or tab; decimals with `.` or `,`;
UTF-8 or Windows-1252. Each import screen offers a template and an export of the
current data.

- `suppliers.csv`: `name,email,phone,notes`. Upsert by name.
- `parts.csv`: `ref,name,kind,unit,cost,supplier,supplier_ref,moq,pack_size,lead_days,track_serial,notes`.
  Upsert by `ref`; only `ref` is required in the header, and columns left out keep their
  current values (so `ref,cost` updates prices only). `supplier` is the supplier's name.
  An empty `cost` means "unknown".
- `stock.csv`: `ref,qty,serial,unit_cost`. Sets on-hand to the counted `qty` with a
  `count` move for the difference. For serial-tracked parts that have no stock yet, use one
  row per serial with `qty` 1.
- `boms.csv` (milestone M2): `parent_ref,code,revision,status,component_ref,qty`.

## Backups

Until the JSON export lands, back up with Wrangler:

```bash
npx wrangler d1 export kitting --remote --output kitting-backup.sql
```

D1 also keeps 30 days of point-in-time history (*Time Travel*).

## License

[MIT](LICENSE)
