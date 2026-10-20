variable "alert_email" {
  description = "Address that receives the budget and cost anomaly emails. Set it in the git-ignored terraform.tfvars, never in a tracked file."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must look like an email address: something, an at sign, a domain with at least one dot, and no spaces."
  }
}

variable "workload_account_name" {
  description = "Name of the Organization account that the guardrails SCP is attached to, looked up by name among the member accounts."
  type        = string
  default     = "field-guide"
}
