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

- **Product photos and files** (CAD models, print files, drawings, instructions, datasheets) are stored in an R2
  bucket. Create it with `npx wrangler r2 bucket create kitting-images`. Without it, delete the `r2_buckets` block
  from `wrangler.jsonc`: the app works and hides the photo and file controls. Files are uploaded up to 100 MB, read as
  a stream; hashing a large file takes more CPU than the Workers Free plan's 10 ms per request, so on that plan an
  upload of more than a few MB may fail with error 1102. The Workers Paid plan has no such problem.
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

Only `/health` answers without Access: it returns `ok` and nothing else, for uptime checks and deploy tooling. If
you use one, add a second Access application on the path `health` with a *Bypass* policy (*Include → Everyone*);
the Terraform module does it for you.

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

Then open your hostname, sign in, and load your data from **Import / Export** in this order: suppliers, storage units
(optional), parts, supplier offers, past prices (optional), assemblies, stock. The [CSV formats](csv.md) page lists the columns. To try the app first,
import the demo files in [`examples/demo/`](../examples/demo/).

## Deploying from GitHub Actions

The repository has a manual Deploy workflow (`.github/workflows/deploy.yml`). It generates `wrangler.jsonc`
from repository settings, runs the checks, applies the migrations and deploys. Nothing account-specific is
committed.

Under *Settings → Secrets and variables → Actions*, add:

- the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs *Workers Scripts: Edit*,
  *D1: Edit*, *Workers Routes: Edit* and *Zone: Read* on your zone, plus *Workers R2 Storage: Edit* for photos and files
  and *Workers KV Storage: Edit* for the MCP server;
- the variables `KITTING_DOMAIN`, `D1_DATABASE_ID`, `TEAM_DOMAIN`, `ACCESS_AUD` and `ADMIN_EMAILS`;
- optionally `DEFAULT_LOCALE`, `CURRENCY`, `WORKER_NAME`, `D1_DATABASE_NAME`, `IMAGES_BUCKET` (the name of
  the R2 bucket; photos and files are off without it) and `OAUTH_KV_ID` (the ID of the KV namespace; MCP is off without
  it).

Then run *Actions → Deploy → Run workflow*. The generated configuration always sets `ENVIRONMENT=production`, an
empty `DEV_AUTH_EMAIL`, and disables the `workers.dev` and preview URLs.

To generate the same file on your machine:

```bash
KITTING_DOMAIN=… D1_DATABASE_ID=… TEAM_DOMAIN=… ACCESS_AUD=… ADMIN_EMAILS=… npm run config
```

If your repository is public, its Actions logs are public too: they show at least your hostname. Deploy from a
private copy if that matters to you.

## Install with Terraform and a release

The steps above work from a clone of this repository. If you would rather not copy the code at all (for example
because your configuration lives in your company's private repository), install a published release instead.
You keep only your settings; the code is the release you pin, and upgrading is changing a version number.

Two pieces do the work:

- **A release bundle.** Pushing a `v*` tag builds `kitting-<version>.tar.gz` (and its `.sha256`) and attaches it
  to a GitHub release. It holds the built Worker, the static files, the D1 migrations and
  `scripts/deploy-release.mjs`, and nothing about any installation.
- **A Terraform module**, [`infra/terraform`](../infra/terraform), that creates the D1 database, the optional R2
  bucket and KV namespace, and the Access applications and policies, and outputs the settings the deploy script
  needs.

### Before the first run

1. In the [Zero Trust dashboard](https://one.dash.cloudflare.com), create your organization (this is where you
   pick the team name) and add a login method, as in step 3 above. Terraform reads the team domain; it does not
   create the organization.
2. Create an API token with the permissions listed in the
   [module README](../infra/terraform/README.md#api-token) plus the ones for the Worker in "Deploying from GitHub
   Actions" above, and keep a bucket for the Terraform state (an R2 bucket works).
3. Have the hostname on a zone of your account. Terraform creates no DNS record: the deploy creates it when it
   attaches the Worker to the hostname.

### Pin a version

In your own repository, write the module with a tag from the
[releases page](https://github.com/alc6/kitting/releases):

```hcl
module "kitting" {
  source = "github.com/alc6/kitting//infra/terraform?ref=v0.6.1"

  account_id            = var.account_id
  hostname              = "kitting.yourco.example"
  admin_emails          = ["admin@yourco.example"]
  allowed_email_domains = ["yourco.example"]

  enable_images = true # product photos
  enable_mcp    = true # AI assistants, see mcp.md
}

output "deploy_env" {
  value = module.kitting.deploy_env
}
```

[`infra/terraform/examples/basic`](../infra/terraform/examples/basic) is a complete folder to copy, with a state
backend and a `terraform.tfvars.example`. `prevent_destroy` protects the database and the photos bucket from a
`terraform destroy` or from turning `enable_images` off.

### Deploy by hand

```bash
terraform init && terraform apply
terraform output -json deploy_env > settings.json

version=0.6.1 # the tag you pinned, without the v
gh release download "v$version" --repo alc6/kitting --pattern "kitting-$version.tar.gz*"
sha256sum -c "kitting-$version.tar.gz.sha256"   # shasum -a 256 -c on macOS
tar -xzf "kitting-$version.tar.gz"

export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…
node "kitting-$version/scripts/deploy-release.mjs" --settings settings.json
```

The script needs Node.js 20 or later and nothing else installed. It writes `wrangler.jsonc` inside the bundle from
your settings (the same variables as the Deploy workflow: `KITTING_DOMAIN`, `D1_DATABASE_ID`, `TEAM_DOMAIN`,
`ACCESS_AUD`, `ADMIN_EMAILS`, and optionally `IMAGES_BUCKET`, `OAUTH_KV_ID`, `DEFAULT_LOCALE`, `CURRENCY`,
`WORKER_NAME`, `D1_DATABASE_NAME`), applies the pending D1 migrations, then uploads the prebuilt Worker. It forces
`ENVIRONMENT=production`, an empty `DEV_AUTH_EMAIL` and no `workers.dev` or preview URL, like the other ways to
deploy. wrangler runs through `npx` at the version recorded in the bundle, so the Worker is never bundled or
built again on your side. Variables set in the environment win over the `--settings` file; you can skip the file
and set every variable yourself. `--dry-run` writes the configuration and has wrangler check the upload without
touching your account or needing credentials.

### Deploy from CI

A job for the private repository that holds the Terraform folder. It applies Terraform, downloads the release
for the pinned version, checks its checksum and runs the deploy script with the Terraform outputs. A first step
fails if the version of the release and the `ref` of the module differ.

```yaml
# .github/workflows/kitting-deploy.yml in YOUR private repository (the one that holds the Terraform folder).
# It creates or updates the Cloudflare resources, then deploys a published Kitting release on top of them. Your
# repository keeps settings only: the code comes from the release, pinned by KITTING_VERSION.
#
# Settings in this repository (Settings, Secrets and variables, Actions):
#   secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
#            TF_STATE_ACCESS_KEY_ID and TF_STATE_SECRET_ACCESS_KEY (R2 API token for the Terraform state)
#   terraform.tfvars is not committed: pass the values as TF_VAR_* variables, as below.
name: Deploy Kitting

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: kitting-deploy
  cancel-in-progress: false

env:
  # The Kitting release to deploy. Keep it equal to the ref=v... of the module in main.tf; a step checks it.
  KITTING_VERSION: "0.6.1"
  KITTING_REPO: alc6/kitting

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    defaults:
      run:
        working-directory: infra/kitting # the folder with main.tf
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      TF_VAR_account_id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      TF_VAR_hostname: ${{ vars.KITTING_DOMAIN }}
      TF_VAR_admin_emails: ${{ vars.ADMIN_EMAILS_JSON }} # for example ["admin@yourco.example"]
      TF_VAR_allowed_email_domains: ${{ vars.ALLOWED_EMAIL_DOMAINS_JSON }} # for example ["yourco.example"]
      AWS_ACCESS_KEY_ID: ${{ secrets.TF_STATE_ACCESS_KEY_ID }}
      AWS_SECRET_ACCESS_KEY: ${{ secrets.TF_STATE_SECRET_ACCESS_KEY }}
    steps:
      - uses: actions/checkout@v4

      - name: The module and the release are the same version
        run: grep -q "infra/terraform?ref=v${KITTING_VERSION}\"" main.tf

      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_wrapper: false
      - name: Cloudflare resources (Terraform)
        run: |
          terraform init -input=false \
            -backend-config="endpoints={s3=\"https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com\"}"
          terraform apply -input=false -auto-approve -lock-timeout=5m
          terraform output -json deploy_env > "${RUNNER_TEMP}/settings.json"

      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Download the release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          mkdir -p "${RUNNER_TEMP}/release"
          gh release download "v${KITTING_VERSION}" --repo "${KITTING_REPO}" \
            --pattern "kitting-${KITTING_VERSION}.tar.gz*" --dir "${RUNNER_TEMP}/release"
          cd "${RUNNER_TEMP}/release"
          sha256sum -c "kitting-${KITTING_VERSION}.tar.gz.sha256"
          tar -xzf "kitting-${KITTING_VERSION}.tar.gz"
      - name: Migrate the database and deploy the Worker
        run: node "${RUNNER_TEMP}/release/kitting-${KITTING_VERSION}/scripts/deploy-release.mjs" --settings "${RUNNER_TEMP}/settings.json"
```

### Upgrade

Change the version in two places, in the same commit: the `ref=v…` of the module and `KITTING_VERSION` in the
workflow. Read the release notes first, then run the workflow. It applies any change of the module (new inputs or
resources are in the notes), then migrates the database and deploys the new Worker. Migrations only add to the
schema, so the previous Worker keeps running while the new one uploads. To go back, restore the previous version
in both places and deploy again: migrations are not undone, so the older release only works if the notes do not
say otherwise.

### What it does not do

- Terraform does not create the Zero Trust organization, the login methods or any DNS record.
- It does not adopt resources you created by hand with `wrangler` or in the dashboard: bring them under Terraform
  with `terraform import` before the first apply, or the apply creates duplicates. If you manage Access
  yourself, set `manage_access = false`.
- The photos bucket and the database are never destroyed by Terraform. Delete them in the dashboard if you
  really mean it.
- Email addresses and domains you list in the module appear in the Terraform state and in the outputs. Keep both
  in a private place.
