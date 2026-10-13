# Cloudflare resources of a Kitting installation: the D1 database, the optional R2 bucket (photos) and KV namespace
# (MCP server), and the Access applications in front of the hostname. The Worker itself, its custom domain (DNS) and
# the database schema are deployed from a release bundle by scripts/deploy-release.mjs (D141): this module only
# creates what that script needs and outputs the settings to give it.

locals {
  images_bucket_name = "${var.name}-images"

  # These paths check OAuth tokens themselves, so Access must let them through (docs/mcp.md).
  mcp_paths = ["mcp", "token", "register", ".well-known/*"]
  # Paths that skip Access: the health check always, the OAuth paths with MCP. The Worker checks them itself.
  public_paths = concat(["health"], var.enable_mcp ? local.mcp_paths : [])

  # An Allow rule matches any of these (they are ORed).
  allow_include = concat(
    [for email in var.allowed_emails : { email = { email = email } }],
    [for domain in var.allowed_email_domains : { email_domain = { domain = domain } }],
  )
}

# The Zero Trust organization must exist (it is created once in the dashboard, with the team name).
data "cloudflare_zero_trust_organization" "this" {
  account_id = var.account_id
}

resource "cloudflare_d1_database" "this" {
  account_id            = var.account_id
  name                  = var.name
  primary_location_hint = var.d1_location_hint

  # The business data lives here: terraform destroy must never drop it.
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "images" {
  count = var.enable_images ? 1 : 0

  account_id = var.account_id
  name       = local.images_bucket_name
  location   = var.r2_location

  # Product photos: turning enable_images off must not delete them.
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_workers_kv_namespace" "oauth" {
  count = var.enable_mcp ? 1 : 0

  account_id = var.account_id
  title      = "${var.name}-oauth"
}

# Access: the main application protects the whole hostname.
resource "cloudflare_zero_trust_access_policy" "allow" {
  count = var.manage_access ? 1 : 0

  account_id = var.account_id
  name       = "${var.name} allow"
  decision   = "allow"
  include    = local.allow_include
}

resource "cloudflare_zero_trust_access_application" "app" {
  count = var.manage_access ? 1 : 0

  account_id       = var.account_id
  name             = var.name
  type             = "self_hosted"
  domain           = var.hostname
  destinations     = [{ type = "public", uri = var.hostname }]
  session_duration = var.access_session_duration
  allowed_idps     = var.access_allowed_idps

  policies = [{ id = cloudflare_zero_trust_access_policy.allow[0].id, precedence = 1 }]
}

# Access: a second application with a Bypass policy on the public paths (/health, plus the MCP and OAuth paths with
# MCP). Access applies the most specific path, so everything else (including the consent page) stays behind the main
# application.
resource "cloudflare_zero_trust_access_policy" "bypass" {
  count = var.manage_access ? 1 : 0

  account_id = var.account_id
  name       = "${var.name} public paths"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_application" "public" {
  count = var.manage_access ? 1 : 0

  account_id           = var.account_id
  name                 = "${var.name} public paths"
  type                 = "self_hosted"
  domain               = "${var.hostname}/${local.public_paths[0]}"
  destinations         = [for path in local.public_paths : { type = "public", uri = "${var.hostname}/${path}" }]
  app_launcher_visible = false

  policies = [{ id = cloudflare_zero_trust_access_policy.bypass[0].id, precedence = 1 }]
}
