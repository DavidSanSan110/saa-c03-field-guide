variable "message" {
  description = "Text stored in the state by the smoke resource; verify.sh checks that the output equals this default."
  type        = string
  default     = "infra.yml smoke test"
}
