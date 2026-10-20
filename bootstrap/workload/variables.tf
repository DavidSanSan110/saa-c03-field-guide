variable "github_sub_prefix" {
  description = "OIDC subject prefix of the GitHub repository allowed to use the CI roles, for example repo:your-user/saa-c03-field-guide. Repositories with immutable subject claims use repo:<owner>@<owner id>/<repo>@<repo id>; the README shows how to read yours."
  type        = string

  validation {
    condition     = can(regex("^repo:[A-Za-z0-9-]+(@[0-9]+)?/[A-Za-z0-9._-]+(@[0-9]+)?$", var.github_sub_prefix))
    error_message = "github_sub_prefix must be repo:<owner>/<repo> or repo:<owner>@<id>/<repo>@<id>: no wildcards, no suffix such as :ref:refs/heads/main, and no empty part."
  }
}

variable "hosted_zone_name" {
  description = "Name of the public Route 53 hosted zone to create, for example field-guide.example.com, or null to create none."
  type        = string
  default     = null

  validation {
    # The conditional is lazy: a plain || would still evaluate regex() on null.
    condition     = var.hosted_zone_name == null ? true : can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.hosted_zone_name))
    error_message = "hosted_zone_name must be null or a lowercase DNS name with at least two labels, no trailing dot and no wildcard (for example field-guide.example.com)."
  }
}
