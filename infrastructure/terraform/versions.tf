terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }

  # State stays on the owner's machine (terraform.tfstate, ignored by git). It holds names and addresses, never a
  # secret value: secrets are created empty here and filled by `node scripts/deploy-gcp.mjs secrets`.
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
