output "ip_address" {
  description = "Point the four DNS records at this address."
  value       = google_compute_address.wolf.address
}

output "dns_records" {
  description = "Add these at Cloudflare, each as DNS only (grey cloud)."
  value = [
    "A  ${var.dashboard_host}.${var.domain}  ${google_compute_address.wolf.address}",
    "A  api.${var.domain}        ${google_compute_address.wolf.address}",
    "A  relay.${var.domain}      ${google_compute_address.wolf.address}",
    "A  turn.${var.domain}       ${google_compute_address.wolf.address}",
  ]
}

output "domain" {
  value = var.domain
}

output "dashboard" {
  value = "https://${var.dashboard_host}.${var.domain}"
}

output "registry" {
  value = local.registry
}

output "instance" {
  value = { name = google_compute_instance.wolf.name, zone = google_compute_instance.wolf.zone }
}
