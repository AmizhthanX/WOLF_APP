variable "project_id" {
  description = "The Google Cloud project WOLF runs in."
  type        = string
}

variable "domain" {
  description = "The owner's domain. The dashboard is served at it; api., relay. and turn. are made under it."
  type        = string
  default     = "amizhthan.app"
}

variable "acme_email" {
  description = "Where Let's Encrypt writes about certificates that are about to expire. Optional."
  type        = string
  default     = ""
}

variable "region" {
  description = "Mumbai, the region nearest the owner."
  type        = string
  default     = "asia-south1"
}

variable "zone" {
  type    = string
  default = "asia-south1-a"
}

variable "machine_type" {
  description = "2 GB of memory holds Postgres, the API, the relay, the dashboard, TURN and Caddy with room to spare."
  type        = string
  default     = "e2-small"
}

variable "fcm_project_id" {
  description = "The Firebase project for push wake-ups (owner guide, Part 4). Empty: push is off."
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Set by scripts/deploy-gcp.mjs. Terraform leaves the deployed tag alone after the first apply."
  type        = string
  default     = ""
}
