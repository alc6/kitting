terraform {
  # 1.9 allows a variable validation to look at another variable.
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # v5 changes resource schemas between minor versions: stay on the one this module was validated with.
      version = "~> 5.27.0"
    }
  }
}
