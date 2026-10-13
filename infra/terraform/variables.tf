variable "account_id" {
  description = "Cloudflare account ID that owns the resources."
  type        = string
}

variable "hostname" {
  description = "Public hostname of the app, without scheme or path (for example kitting.yourco.example). It must be on a zone of this account: wrangler attaches it to the Worker at deploy time."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.hostname)) && !endswith(var.hostname, ".workers.dev")
    error_message = "hostname must be a custom domain name such as kitting.yourco.example, with no scheme, no path and not on workers.dev."
  }
}

variable "name" {
  description = "Prefix of every resource name, and the Worker name. Changing it later renames or replaces resources."
  type        = string
  default     = "kitting"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$", var.name))
    error_message = "name must be 2 to 40 lower case letters, digits or dashes, not starting or ending with a dash."
  }
}

variable "admin_emails" {
  description = "People who are always administrators (ADMIN_EMAILS). They give every other person a role in the app."
  type        = list(string)

  validation {
    condition     = length(var.admin_emails) > 0
    error_message = "admin_emails needs at least one address."
  }
}

variable "default_locale" {
  description = "Language of the app for people who did not choose one: en or fr."
  type        = string
  default     = "en"

  validation {
    condition     = contains(["en", "fr"], var.default_locale)
    error_message = "default_locale must be en or fr."
  }
}

variable "currency" {
  description = "ISO 4217 code used to display amounts."
  type        = string
  default     = "EUR"

  validation {
    condition     = can(regex("^[A-Z]{3}$", var.currency))
    error_message = "currency must be a three-letter ISO 4217 code such as EUR or USD."
  }
}

variable "enable_images" {
  description = "Create the R2 bucket for product photos. Without it the app runs without photos."
  type        = bool
  default     = false
}

variable "enable_mcp" {
  description = "Create the KV namespace of the MCP server for AI assistants and the Access application that lets its OAuth paths through (see docs/mcp.md). Without it /mcp answers 404."
  type        = bool
  default     = false
}

variable "d1_location_hint" {
  description = "Where to create the database: wnam, enam, weur, eeur, apac or oc. Null lets Cloudflare choose. It cannot be changed afterwards."
  type        = string
  default     = null
}

variable "r2_location" {
  description = "Where to create the photos bucket: wnam, enam, weur, eeur, apac or oc. Null lets Cloudflare choose."
  type        = string
  default     = null
}

variable "manage_access" {
  description = "Create the Cloudflare Access applications and policies. Set it to false if you manage Access yourself; then access_aud is null and you give ACCESS_AUD to the deploy script."
  type        = bool
  default     = true
}

variable "allowed_emails" {
  description = "Email addresses allowed to sign in through Access."
  type        = list(string)
  default     = []

  validation {
    condition     = !var.manage_access || length(var.allowed_emails) + length(var.allowed_email_domains) > 0
    error_message = "Give allowed_emails or allowed_email_domains, or nobody can sign in. Set manage_access to false to manage Access yourself."
  }
}

variable "allowed_email_domains" {
  description = "Email domains (for example yourco.example) whose people are allowed to sign in through Access."
  type        = list(string)
  default     = []
}

variable "access_session_duration" {
  description = "How long an Access sign-in lasts, as a duration such as 24h or 168h (a week suits shop-floor tablets)."
  type        = string
  default     = "168h"
}

variable "access_allowed_idps" {
  description = "IDs of the identity providers people may use. Null offers every provider configured in the account."
  type        = list(string)
  default     = null
}
