# WOLF on Google Cloud, as one small VM.
#
# The VM runs infrastructure/docker/compose.yml: Caddy for HTTPS, the dashboard, the API, the realtime relay,
# Postgres and TURN. Chosen for a free-trial deployment; the services themselves are unchanged from what Cloud Run
# and Cloud SQL would run (see docs/operations/deployment.md).
#
# What is reachable from the internet: 80 and 443 (Caddy), 3478 and the TURN relay ports. SSH only through
# Identity-Aware Proxy, for accounts with IAM access to this project. Nothing else.

locals {
  name     = "wolf"
  registry = "${var.region}-docker.pkg.dev/${var.project_id}/${local.name}"

  # Created empty. `node scripts/deploy-gcp.mjs secrets` generates the values on the owner's machine and hands them
  # straight to Secret Manager, so they never pass through Terraform state.
  secrets = toset([
    "wolf-token-secret",
    "wolf-database-password",
    "wolf-turn-secret",
    "wolf-webhook-key",
    "wolf-fcm-credentials",
  ])
}

# --- APIs ------------------------------------------------------------------------------------------------------------

resource "google_project_service" "services" {
  for_each = toset([
    "compute.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "iap.googleapis.com",
  ])

  service            = each.value
  disable_on_destroy = false
}

# --- Images ----------------------------------------------------------------------------------------------------------

resource "google_artifact_registry_repository" "images" {
  repository_id = local.name
  location      = var.region
  format        = "DOCKER"
  description   = "WOLF server and dashboard images"

  # Old images cost storage and are never deployed again; the newest five stay for a rollback.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "604800s"
    }
  }

  depends_on = [google_project_service.services]
}

# --- Secrets ---------------------------------------------------------------------------------------------------------

resource "google_secret_manager_secret" "wolf" {
  for_each  = local.secrets
  secret_id = each.value

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.services]
}

# --- Identity --------------------------------------------------------------------------------------------------------

# The VM's own account: it may pull WOLF's images and read WOLF's secrets, and nothing else in the project.
resource "google_service_account" "vm" {
  account_id   = "wolf-vm"
  display_name = "WOLF VM"
}

resource "google_artifact_registry_repository_iam_member" "vm_pull" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_secret_manager_secret_iam_member" "vm_read" {
  for_each  = google_secret_manager_secret.wolf
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}

# --- Network ---------------------------------------------------------------------------------------------------------

# Its own network rather than the project's default one, whose rules open SSH and RDP to the whole internet.
resource "google_compute_network" "wolf" {
  name                    = local.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.services]
}

resource "google_compute_subnetwork" "wolf" {
  name          = local.name
  network       = google_compute_network.wolf.id
  region        = var.region
  ip_cidr_range = "10.20.0.0/24"
}

resource "google_compute_address" "wolf" {
  name   = local.name
  region = var.region

  depends_on = [google_project_service.services]
}

resource "google_compute_firewall" "web" {
  name          = "wolf-allow-web"
  network       = google_compute_network.wolf.name
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = [local.name]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
  allow {
    protocol = "udp"
    ports    = ["443"]
  }
}

resource "google_compute_firewall" "turn" {
  name          = "wolf-allow-turn"
  network       = google_compute_network.wolf.name
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = [local.name]

  allow {
    protocol = "tcp"
    ports    = ["3478"]
  }
  allow {
    protocol = "udp"
    ports    = ["3478", "49160-49200"]
  }
}

# SSH from Google's Identity-Aware Proxy range only: `gcloud compute ssh --tunnel-through-iap`, for an account with
# IAM access. The VM has no SSH port open to the internet.
resource "google_compute_firewall" "iap_ssh" {
  name          = "wolf-allow-iap-ssh"
  network       = google_compute_network.wolf.name
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = [local.name]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# --- The VM ----------------------------------------------------------------------------------------------------------

resource "google_compute_instance" "wolf" {
  name         = local.name
  machine_type = var.machine_type
  zone         = var.zone
  tags         = [local.name]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-13"
      size  = 20
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.wolf.id
    access_config {
      nat_ip = google_compute_address.wolf.address
    }
  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    startup-script         = replace(file("${path.module}/../gcp/startup.sh"), "\r\n", "\n")
    wolf-compose           = replace(file("${path.module}/../docker/compose.yml"), "\r\n", "\n")
    wolf-caddyfile         = replace(file("${path.module}/../docker/Caddyfile"), "\r\n", "\n")
    wolf-domain            = var.domain
    wolf-acme-email        = var.acme_email
    wolf-registry          = local.registry
    wolf-fcm-project-id    = var.fcm_project_id
    wolf-image-tag         = var.image_tag
  }

  lifecycle {
    # The deploy script moves the image tag; a later `terraform apply` must not roll it back.
    ignore_changes = [metadata["wolf-image-tag"]]
  }

  allow_stopping_for_update = true

  depends_on = [
    google_artifact_registry_repository_iam_member.vm_pull,
    google_secret_manager_secret_iam_member.vm_read,
  ]
}

# --- Backups ---------------------------------------------------------------------------------------------------------

# A snapshot of the disk every night, kept for a week. The database lives on this disk.
resource "google_compute_resource_policy" "nightly" {
  name   = "wolf-nightly-snapshot"
  region = var.region

  depends_on = [google_project_service.services]

  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        start_time    = "20:00" # UTC; 01:30 in India
      }
    }
    retention_policy {
      max_retention_days    = 7
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }
    snapshot_properties {
      storage_locations = [var.region]
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "nightly" {
  name = google_compute_resource_policy.nightly.name
  disk = google_compute_instance.wolf.name
  zone = var.zone
}
