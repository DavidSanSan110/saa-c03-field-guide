variable "lab" {
  description = "Lab id used as the value of the lab tag: two digits and a lowercase kebab-case name (for example 00-site-hosting), or bootstrap-management / bootstrap-workload."
  type        = string

  validation {
    condition     = can(regex("^([0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*|bootstrap-(management|workload))$", var.lab))
    error_message = "lab must be two digits followed by lowercase kebab-case segments (for example 00-site-hosting), or one of bootstrap-management and bootstrap-workload."
  }
}

variable "extra" {
  description = "Additional tags merged with the required project and lab tags. The keys project and lab (any case) and keys starting with aws: (any case) are not allowed."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for key in keys(var.extra) : !contains(["project", "lab"], lower(key))
    ])
    error_message = "extra must not contain the keys project or lab (in any case): the module sets them."
  }

  validation {
    condition = alltrue([
      for key in keys(var.extra) : !startswith(lower(key), "aws:")
    ])
    error_message = "extra must not contain keys starting with aws: (in any case): AWS reserves that prefix."
  }
}
