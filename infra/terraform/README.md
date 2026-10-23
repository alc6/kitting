# Terraform module for Kitting

Creates the Cloudflare resources a Kitting installation needs and outputs the settings that
`scripts/deploy-release.mjs` takes. The code is not in this module: it comes from a release bundle
(`kitting-<version>.tar.gz`), so an installation keeps only its own settings. The guide is
[docs/deploy.md](../../docs/deploy.md), "Install with Terraform". An example to copy is in
[`examples/basic`](examples/basic).

```hcl
module "kitting" {
  source = "github.com/alc6/kitting//infra/terraform?ref=v0.6.2"

  account_id            = var.account_id
  hostname              = "kitting.yourco.example"
  admin_emails          = ["admin@yourco.example"]
  allowed_email_domains = ["yourco.example"]
  enable_images         = true
  enable_mcp            = true
}
```

Requires Terraform 1.9 or later and the Cloudflare provider 5.27 (`~> 5.27.0`).

## What it creates

| Resource | When |
| --- | --- |
| D1 database `<name>` (`prevent_destroy`) | always |
| R2 bucket `<name>-images` (`prevent_destroy`) | `enable_images` |
| KV namespace `<name>-oauth` | `enable_mcp` |
| Access application on the hostname and an Allow policy | `manage_access` (default) |
| Access application on `mcp`, `token`, `register` and `.well-known/*` with a Bypass policy | `manage_access` and `enable_mcp` |

It creates no DNS record and no Worker: `scripts/deploy-release.mjs` deploys the Worker with its custom domain,
and Cloudflare creates the record then. The Zero Trust organization (the team name) and at least one login
method must already exist: they are created once in the dashboard.

## Inputs

| Name | Default | |
| --- | --- | --- |
| `account_id` | | Cloudflare account ID. |
| `hostname` | | Hostname of the app, on a zone of the account. |
| `admin_emails` | | Always administrators (`ADMIN_EMAILS`). |
| `allowed_emails`, `allowed_email_domains` | `[]` | Who Access lets in. One of them is required unless `manage_access` is false. |
| `name` | `kitting` | Prefix of the resource names, and the Worker name. |
| `enable_images` | `false` | R2 bucket for photos. |
| `enable_mcp` | `false` | KV namespace and Access application for the MCP server. |
| `manage_access` | `true` | Set to false to manage Access yourself. |
| `default_locale`, `currency` | `en`, `EUR` | Passed to the deploy script. |
| `access_session_duration` | `168h` | Length of an Access sign-in. |
| `access_allowed_idps` | `null` | Identity providers offered. All when null. |
| `d1_location_hint`, `r2_location` | `null` | Where to create the database and the bucket. |

## Outputs

`d1_database_id`, `d1_database_name`, `access_aud`, `team_domain`, `images_bucket` and `oauth_kv_id` (null when
the resource is not created), and `deploy_env`: all of them under the names the deploy script reads, as one JSON
object (`terraform output -json deploy_env > settings.json`, then `--settings settings.json`).

## API token

`CLOUDFLARE_API_TOKEN` needs, on the account: D1 Edit, Workers R2 Storage Edit (with `enable_images`), Workers KV
Storage Edit (with `enable_mcp`), Access: Apps and Policies Edit, and Access: Organizations, Identity Providers
and Groups Read (the team domain). The token that deploys the Worker needs the permissions in
[docs/deploy.md](../../docs/deploy.md); one token with both sets works.
