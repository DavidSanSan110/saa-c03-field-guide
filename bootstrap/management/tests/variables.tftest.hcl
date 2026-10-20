# Tests for bootstrap/management (spec 031): variables and tags. All runs use command = plan with a
# mock provider, so nothing touches AWS.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }

  override_resource {
    target          = aws_organizations_organization.this
    override_during = plan
    values = {
      id = "o-exampleorg1"
      non_master_accounts = [
        {
          arn    = "arn:aws:organizations::111111111111:account/o-exampleorg1/222222222222"
          email  = "workload@example.com"
          id     = "222222222222"
          name   = "field-guide"
          status = "ACTIVE"
        },
        {
          arn    = "arn:aws:organizations::111111111111:account/o-exampleorg1/333333333333"
          email  = "other@example.com"
          id     = "333333333333"
          name   = "other"
          status = "ACTIVE"
        },
      ]
    }
  }
}

variables {
  alert_email = "alerts@example.com"
}

# AC-13: "not-an-email" (no @) fails validation
run "ac13_alert_email_without_at_is_rejected" {
  command = plan

  variables {
    alert_email = "not-an-email"
  }

  expect_failures = [var.alert_email]
}

# AC-13: the empty string fails validation
run "ac13_alert_email_empty_is_rejected" {
  command = plan

  variables {
    alert_email = ""
  }

  expect_failures = [var.alert_email]
}

# AC-13: "a@b" (no dot in the domain) fails validation
run "ac13_alert_email_without_domain_dot_is_rejected" {
  command = plan

  variables {
    alert_email = "a@b"
  }

  expect_failures = [var.alert_email]
}

# AC-13: an address with a space fails validation
run "ac13_alert_email_with_space_is_rejected" {
  command = plan

  variables {
    alert_email = "a b@example.com"
  }

  expect_failures = [var.alert_email]
}

# AC-13: a plain example.com address passes validation
run "ac13_alert_email_valid_is_accepted" {
  command = plan

  variables {
    alert_email = "you@example.com"
  }

  assert {
    condition     = var.alert_email == "you@example.com"
    error_message = "alert_email = 'you@example.com' should pass validation and be kept as is"
  }
}

# AC-14: the module tags are exactly the project and lab tags
run "ac14_tags_are_project_and_lab" {
  command = plan

  assert {
    condition     = module.tags.tags == { project = "saa-c03-field-guide", lab = "bootstrap-management" }
    error_message = "module.tags.tags is not exactly { project = 'saa-c03-field-guide', lab = 'bootstrap-management' }"
  }
}
