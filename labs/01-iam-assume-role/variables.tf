variable "external_id" {
  description = "External ID the reports reader role demands from every caller (the confused deputy defence). It is not a secret: it travels in the AssumeRole call and shows in the run log. 2 to 1224 characters from the set A-Z a-z 0-9 _ + = , . @ : / -."
  type        = string
  default     = "field-guide-lab-01"
  nullable    = false

  validation {
    # STS accepts 2 to 1224 characters matching [\w+=,.@:\/-]*.
    condition     = length(var.external_id) >= 2 && length(var.external_id) <= 1224 && can(regex("^[\\w+=,.@:/-]+$", var.external_id))
    error_message = "external_id must be 2 to 1224 characters from the set A-Z a-z 0-9 _ + = , . @ : / - (no spaces, no other punctuation)."
  }
}

variable "trusted_account_id" {
  description = "ID of a second AWS account that may also assume the reports reader role (with the external ID), or null to trust only this account. Local runs only: a repository variable would print the ID in the public plan log."
  type        = string
  default     = null

  validation {
    # The conditional is lazy: a plain || would still evaluate regex() on null.
    condition     = var.trusted_account_id == null ? true : can(regex("^[0-9]{12}$", var.trusted_account_id))
    error_message = "trusted_account_id must be null or exactly 12 digits."
  }
}
