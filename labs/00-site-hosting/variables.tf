variable "github_sub_prefix" {
  description = "OIDC subject prefix of the GitHub repository whose production environment may deploy the site, for example repo:your-user/saa-c03-field-guide. Same value as the bootstrap stack; repositories with immutable subject claims use repo:<owner>@<owner id>/<repo>@<repo id>."
  type        = string

  validation {
    condition     = can(regex("^repo:[A-Za-z0-9-]+(@[0-9]+)?/[A-Za-z0-9._-]+(@[0-9]+)?$", var.github_sub_prefix))
    error_message = "github_sub_prefix must be repo:<owner>/<repo> or repo:<owner>@<id>/<repo>@<id>: no wildcards, no suffix such as :environment:production, and no empty part."
  }
}

variable "domain_name" {
  description = "Custom domain of the site, for example site.example.com, or null to use the cloudfront.net name. Needs hosted_zone_id."
  type        = string
  default     = null

  validation {
    # The conditional is lazy: a plain || would still evaluate regex() on null.
    condition     = var.domain_name == null ? true : can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "domain_name must be null or a lowercase DNS name with at least two labels, no trailing dot and no wildcard (for example site.example.com)."
  }
}

variable "hosted_zone_id" {
  description = "ID of the public Route 53 hosted zone that holds domain_name (the bootstrap/workload output hosted_zone_id), or null. Set if and only if domain_name is set."
  type        = string
  default     = null

  validation {
    condition     = var.hosted_zone_id == null ? true : can(regex("^Z[A-Z0-9]{1,31}$", var.hosted_zone_id))
    error_message = "hosted_zone_id must be null or a Route 53 hosted zone ID: Z followed by 1 to 31 upper-case letters or digits."
  }

  # This rule sits here, not on domain_name, so that it is reported once and fails in both directions.
  validation {
    condition     = (var.domain_name == null) == (var.hosted_zone_id == null)
    error_message = "hosted_zone_id and domain_name go together: set both (a custom domain) or neither (the cloudfront.net name)."
  }
}

variable "headers_json" {
  description = "JSON text of the response headers, only for the tests. Leave it unset: the stack then reads apps/site/headers.json."
  type        = string
  default     = null
}
