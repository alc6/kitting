# Deploying Kitting

Kitting runs on Cloudflare: a Worker serves the app, D1 stores the data, and Cloudflare Access decides who can
sign in. You need a Cloudflare account with a domain on it, Node.js 20 or later, and a clone of this
repository. Run `npm ci` once.

## 1. Create the database and storage

```bash
npx wrangler login
npx wrangler d1 create kitting
cp wrangler.example.jsonc wrangler.jsonc
```

Put the `database_id` that wrangler prints into `wrangler.jsonc`, and set the `routes` pattern to the hostname
you'll use, for example `kitting.example.com`. `wrangler.jsonc` is gitignored, so your IDs stay out of the
repository.

Two more resources are optional:

- **Product photos** are stored in an R2 bucket. Create it with `npx wrangler r2 bucket create kitting-images`.
  Without it, delete the `r2_buckets` block from `wrangler.jsonc`: the app works and hides the photo controls.
- **The MCP server** for AI assistants needs a KV namespace. See [AI assistants](mcp.md). Without it, delete
  the `kv_namespaces` block.

## 2. Apply the migrations

```bash
npx wrangler d1 migrations apply DB --remote
```

## 3. Set up Cloudflare Access

Access lets people in; the Worker then checks every request again.

1. **Login method.** In the [Zero Trust dashboard](https://one.dash.cloudflare.com), go to *Settings →
   Authentication → Login methods* and add Google (you'll need an OAuth client) or One-time PIN (codes sent by
   email, nothing to configure).
2. **Application.** Go to *Access → Applications → Add an application → Self-hosted*. Use your hostname as the
   application domain, with no path, and pick the login method from step 1. Choose any session length; a week
   is convenient on shop-floor tablets.
3. **Policy.** Add a policy with the action *Allow* and a rule such as *Include → Emails ending in →
   `@example.com`*, or list people one by one.
4. **Audience tag.** On the application's overview, copy the *Application Audience (AUD) Tag*. It goes in
   `ACCESS_AUD`.
5. **Team domain.** Your team domain looks like `acme.cloudflareaccess.com`; it appears in the URL of the login
   page and under *Settings → Custom pages*. It goes in `TEAM_DOMAIN`.

The Worker only accepts requests that carry a valid `Cf-Access-Jwt-Assertion` header signed for your team and
audience, and answers 403 to anything else. The `workers.dev` and preview URLs are disabled, so the app is only
reachable on the hostname Access protects.

## 4. Fill in the settings

In `wrangler.jsonc`, under `vars`:

| Variable | Example | |
| --- | --- | --- |
| `TEAM_DOMAIN` | `acme.cloudflareaccess.com` | Your Zero Trust team domain. |
| `ACCESS_AUD` | `4f1c…9a` | The audience tag of the Access application. |
| `ADMIN_EMAILS` | `ops@example.com,boss@example.com` | Always administrators. They give everyone else a role. |
| `DEFAULT_LOCALE` | `fr` | `en` or `fr`. Each user can switch. |
| `CURRENCY` | `EUR` | ISO code used to display amounts. |
| `ENVIRONMENT` | `production` | Leave it as is. |
| `DEV_AUTH_EMAIL` | | Leave it empty. It is only used in local development. |

## 5. Deploy

```bash
npm run deploy
```

This builds the stylesheet, applies any pending migrations and deploys the Worker on your hostname. Run the
same command for every update.

Then open your hostname, sign in, and load your data from **Import / Export** in this order: suppliers, parts,
supplier offers, assemblies, stock. The [CSV formats](csv.md) page lists the columns. To try the app first,
import the demo files in [`examples/demo/`](../examples/demo/).

## Deploying from GitHub Actions

The repository has a manual Deploy workflow (`.github/workflows/deploy.yml`). It generates `wrangler.jsonc`
from repository settings, runs the checks, applies the migrations and deploys. Nothing account-specific is
committed.

Under *Settings → Secrets and variables → Actions*, add:

- the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs *Workers Scripts: Edit*,
  *D1: Edit*, *Workers Routes: Edit* and *Zone: Read* on your zone, plus *Workers R2 Storage: Edit* for photos
  and *Workers KV Storage: Edit* for the MCP server;
- the variables `KITTING_DOMAIN`, `D1_DATABASE_ID`, `TEAM_DOMAIN`, `ACCESS_AUD` and `ADMIN_EMAILS`;
- optionally `DEFAULT_LOCALE`, `CURRENCY`, `WORKER_NAME`, `D1_DATABASE_NAME`, `IMAGES_BUCKET` (the name of
  the R2 bucket; photos are off without it) and `OAUTH_KV_ID` (the ID of the KV namespace; MCP is off without
  it).

Then run *Actions → Deploy → Run workflow*. The generated configuration always sets `ENVIRONMENT=production`, an
empty `DEV_AUTH_EMAIL`, and disables the `workers.dev` and preview URLs.

To generate the same file on your machine:

```bash
KITTING_DOMAIN=… D1_DATABASE_ID=… TEAM_DOMAIN=… ACCESS_AUD=… ADMIN_EMAILS=… npm run config
```

If your repository is public, its Actions logs are public too: they show at least your hostname. Deploy from a
private copy if that matters to you.
