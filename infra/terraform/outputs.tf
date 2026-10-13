output "d1_database_id" {
  description = "ID of the D1 database (D1_DATABASE_ID)."
  value       = cloudflare_d1_database.this.id
}

output "d1_database_name" {
  description = "Name of the D1 database (D1_DATABASE_NAME)."
  value       = cloudflare_d1_database.this.name
}

output "access_aud" {
  description = "Audience tag of the main Access application (ACCESS_AUD). Null when manage_access is false."
  value       = one(cloudflare_zero_trust_access_application.app[*].aud)
}

output "team_domain" {
  description = "Zero Trust team domain, for example acme.cloudflareaccess.com (TEAM_DOMAIN)."
  value       = data.cloudflare_zero_trust_organization.this.auth_domain
}

output "images_bucket" {
  description = "Name of the R2 bucket for photos (IMAGES_BUCKET). Null when enable_images is false."
  value       = one(cloudflare_r2_bucket.images[*].name)
}

output "oauth_kv_id" {
  description = "ID of the KV namespace of the MCP server (OAUTH_KV_ID). Null when enable_mcp is false."
  value       = one(cloudflare_workers_kv_namespace.oauth[*].id)
}

# Everything scripts/deploy-release.mjs reads, under the names it expects. Save it with
# `terraform output -json deploy_env > settings.json` and pass `--settings settings.json`.
# Nothing here is a secret. A setting that does not apply (photos or MCP off, Access not managed) is left out.
output "deploy_env" {
  description = "Settings for scripts/deploy-release.mjs, as environment variable names."
  value = {
    for key, value in {
      KITTING_DOMAIN   = var.hostname
      WORKER_NAME      = var.name
      D1_DATABASE_ID   = cloudflare_d1_database.this.id
      D1_DATABASE_NAME = cloudflare_d1_database.this.name
      TEAM_DOMAIN      = data.cloudflare_zero_trust_organization.this.auth_domain
      ACCESS_AUD       = one(cloudflare_zero_trust_access_application.app[*].aud)
      ADMIN_EMAILS     = join(",", var.admin_emails)
      DEFAULT_LOCALE   = var.default_locale
      CURRENCY         = var.currency
      IMAGES_BUCKET    = one(cloudflare_r2_bucket.images[*].name)
      OAUTH_KV_ID      = one(cloudflare_workers_kv_namespace.oauth[*].id)
    } : key => value if value != null
  }
}
