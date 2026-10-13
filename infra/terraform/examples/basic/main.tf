# Cloudflare resources of a Kitting installation, in your own (private) repository.
# Copy this folder, copy terraform.tfvars.example to terraform.tfvars and fill it in.
# To upgrade Kitting, change the ref below and KITTING_VERSION in the deploy workflow to the same release
# (kitting-deploy.yml in this folder).

terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.27.0"
    }
  }

  # Keep the state somewhere shared, or every CI run starts from nothing and tries to create the database again.
  # Cloudflare R2 speaks the S3 protocol; give the endpoint and the keys at init time:
  #   terraform init -backend-config="endpoints={s3=\"https://<account id>.r2.cloudflarestorage.com\"}"
  # with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY set to an R2 API token. Any other backend works as well.
  backend "s3" {
    bucket = "terraform-state"
    key    = "kitting/terraform.tfstate"
    region = "auto"

    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

# The API token comes from the CLOUDFLARE_API_TOKEN environment variable.
provider "cloudflare" {}

variable "account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "hostname" {
  description = "Hostname of the app, on a zone of this account."
  type        = string
}

variable "admin_emails" {
  description = "People who are always administrators."
  type        = list(string)
}

variable "allowed_email_domains" {
  description = "Email domains allowed to sign in."
  type        = list(string)
  default     = []
}

variable "allowed_emails" {
  description = "Email addresses allowed to sign in."
  type        = list(string)
  default     = []
}

module "kitting" {
  source = "github.com/alc6/kitting//infra/terraform?ref=v0.2.0"

  account_id            = var.account_id
  hostname              = var.hostname
  admin_emails          = var.admin_emails
  allowed_emails        = var.allowed_emails
  allowed_email_domains = var.allowed_email_domains

  enable_images = true # photos in R2
  enable_mcp    = true # AI assistants (docs/mcp.md)

  default_locale = "en"
  currency       = "EUR"
}

# The deploy script reads this: terraform output -json deploy_env
output "deploy_env" {
  description = "Settings for scripts/deploy-release.mjs."
  value       = module.kitting.deploy_env
}
