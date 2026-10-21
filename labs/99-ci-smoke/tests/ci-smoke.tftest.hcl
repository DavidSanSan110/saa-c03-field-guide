# Tests for labs/99-ci-smoke (spec 033). No provider is involved: terraform_data is built in,
# and `terraform test` ignores the S3 backend, so every run works without AWS credentials.

# AC-22: a plan shows the default message as the resource input
run "ac22_plan_input_is_the_default_message" {
  command = plan

  assert {
    condition     = terraform_data.smoke.input == "infra.yml smoke test"
    error_message = "terraform_data.smoke.input is not 'infra.yml smoke test'"
  }
}

# AC-22: an apply exposes the default message as output.message
run "ac22_apply_output_is_the_default_message" {
  command = apply

  assert {
    condition     = output.message == "infra.yml smoke test"
    error_message = "output.message is not 'infra.yml smoke test'"
  }
}

# AC-22: another message flows through to output.message
run "ac22_other_message_flows_to_the_output" {
  command = apply

  variables {
    message = "other"
  }

  assert {
    condition     = output.message == "other"
    error_message = "output.message is not 'other' when var.message is 'other'"
  }
}
