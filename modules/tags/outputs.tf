output "tags" {
  description = "The required tags (project and lab) merged with any extra tags, ready for default_tags or an explicit tags argument."
  value = merge(var.extra, {
    project = "saa-c03-field-guide"
    lab     = var.lab
  })
}
