# The three numbers of the timeout rule. CI sets no TF_VAR_* variable, so it uses the defaults.

variable "function_timeout_seconds" {
  description = "How long the consumer function may run for one batch, in seconds (1 to 900, a whole number). The visibility timeout of the source queue must cover it six times over."
  type        = number
  default     = 5
  nullable    = false

  validation {
    condition     = var.function_timeout_seconds == floor(var.function_timeout_seconds) && var.function_timeout_seconds >= 1 && var.function_timeout_seconds <= 900
    error_message = "function_timeout_seconds must be a whole number from 1 to 900."
  }
}

variable "batching_window_seconds" {
  description = "How long Lambda gathers messages into one batch before it invokes the function, in seconds (0 to 300, a whole number). It counts in the visibility timeout rule."
  type        = number
  default     = 5
  nullable    = false

  validation {
    condition     = var.batching_window_seconds == floor(var.batching_window_seconds) && var.batching_window_seconds >= 0 && var.batching_window_seconds <= 300
    error_message = "batching_window_seconds must be a whole number from 0 to 300."
  }
}

variable "visibility_timeout_seconds" {
  description = "Visibility timeout of the source queue, in seconds (a whole number, at most 43200). The Lambda documentation asks for at least 6 times the function timeout plus the batching window; the default 35 is 6 x 5 + 5."
  type        = number
  default     = 35
  nullable    = false

  validation {
    condition     = var.visibility_timeout_seconds == floor(var.visibility_timeout_seconds) && var.visibility_timeout_seconds >= 0 && var.visibility_timeout_seconds <= 43200
    error_message = "visibility_timeout_seconds must be a whole number from 0 to 43200."
  }

  validation {
    condition     = var.visibility_timeout_seconds >= 6 * var.function_timeout_seconds + var.batching_window_seconds
    error_message = "visibility_timeout_seconds must be at least 6 times the function timeout plus the batching window (Lambda refuses a mapping whose queue visibility timeout is shorter than the function timeout, and the documentation asks for six times)."
  }
}
