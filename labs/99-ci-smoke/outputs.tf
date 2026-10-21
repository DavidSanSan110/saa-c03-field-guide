output "message" {
  description = "The message the smoke resource stored in the state."
  value       = terraform_data.smoke.output
}
