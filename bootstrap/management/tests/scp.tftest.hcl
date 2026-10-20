# Tests for bootstrap/management (spec 031): the field-guide-guardrails SCP and its attachment.
# All runs use command = plan with a mock provider, so nothing touches AWS.

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

# AC-9: exactly one statement uses NotAction (the Region guard); it is a Deny on every resource
run "ac9_scp_region_statement_is_a_deny_on_all_resources" {
  command = plan

  assert {
    condition = length([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      s if contains(keys(s), "NotAction")
    ]) == 1
    error_message = "the SCP must have exactly one NotAction statement (the Region guard)"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      s.Effect == "Deny" && toset(flatten([s.Resource])) == toset(["*"])
      if contains(keys(s), "NotAction")
    ])
    error_message = "the Region statement must be Effect Deny with Resource '*'"
  }
}

# AC-9: the allowed Regions are exactly eu-west-1 and us-east-1 (StringNotEquals aws:RequestedRegion)
run "ac9_scp_allowed_regions_are_exactly_two" {
  command = plan

  assert {
    condition = alltrue([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      toset(flatten([s.Condition.StringNotEquals["aws:RequestedRegion"]])) == toset(["eu-west-1", "us-east-1"])
      if contains(keys(s), "NotAction")
    ])
    error_message = "the Region statement condition must be StringNotEquals aws:RequestedRegion = {eu-west-1, us-east-1}"
  }

  assert {
    condition = length([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      s if contains(keys(s), "NotAction")
    ]) == 1
    error_message = "the SCP must have its Region statement (NotAction) to check the allowed Regions on"
  }
}

# AC-9: global services are exempt from the Region guard through NotAction, with no Action key
run "ac9_scp_region_statement_exempts_global_services" {
  command = plan

  assert {
    condition = alltrue([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      alltrue([
        for a in ["iam:*", "organizations:*", "sts:*", "route53:*", "cloudfront:*", "budgets:*", "ce:*", "support:*"] :
        contains(flatten([s.NotAction]), a)
      ])
      if contains(keys(s), "NotAction")
    ])
    error_message = "NotAction must contain iam:*, organizations:*, sts:*, route53:*, cloudfront:*, budgets:*, ce:* and support:*"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      !contains(keys(s), "Action")
      if contains(keys(s), "NotAction")
    ])
    error_message = "the Region statement must not have an Action key next to NotAction"
  }

  assert {
    condition = length([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      s if contains(keys(s), "NotAction")
    ]) == 1
    error_message = "the SCP must have its Region statement (NotAction) to check the exemptions on"
  }
}

# AC-10: the SCP denies IAM users and access keys
run "ac10_scp_denies_iam_users_and_keys" {
  command = plan

  assert {
    condition = length(setsubtract(
      toset(["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile"]),
      toset(flatten([
        for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
        flatten([s.Action]) if s.Effect == "Deny" && contains(keys(s), "Action")
      ]))
    )) == 0
    error_message = "the SCP must deny iam:CreateUser, iam:CreateAccessKey, iam:CreateLoginProfile and iam:UpdateLoginProfile"
  }
}

# AC-10: the SCP denies tampering with CloudTrail
run "ac10_scp_denies_cloudtrail_changes" {
  command = plan

  assert {
    condition = length(setsubtract(
      toset(["cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail", "cloudtrail:PutEventSelectors"]),
      toset(flatten([
        for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
        flatten([s.Action]) if s.Effect == "Deny" && contains(keys(s), "Action")
      ]))
    )) == 0
    error_message = "the SCP must deny cloudtrail:StopLogging, DeleteTrail, UpdateTrail and PutEventSelectors"
  }
}

# AC-10: the SCP denies leaving the Organization
run "ac10_scp_denies_leaving_the_organization" {
  command = plan

  assert {
    condition = contains(
      flatten([
        for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
        flatten([s.Action]) if s.Effect == "Deny" && contains(keys(s), "Action")
      ]),
      "organizations:LeaveOrganization"
    )
    error_message = "the SCP must deny organizations:LeaveOrganization"
  }
}

# AC-10: the SCP has only Deny statements and the 2012-10-17 policy version
run "ac10_scp_has_no_allow_statement_and_the_current_version" {
  command = plan

  assert {
    condition = alltrue([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement : s.Effect != "Allow"
    ])
    error_message = "the SCP must not have an Allow statement (FullAWSAccess stays attached)"
  }

  assert {
    condition     = jsondecode(aws_organizations_policy.guardrails.content).Version == "2012-10-17"
    error_message = "the SCP Version is not '2012-10-17'"
  }
}

# AC-10: the policy is named, typed and fits the 5120-character SCP limit
run "ac10_scp_name_type_and_size" {
  command = plan

  assert {
    condition     = aws_organizations_policy.guardrails.name == "field-guide-guardrails"
    error_message = "aws_organizations_policy.guardrails.name is not 'field-guide-guardrails'"
  }

  assert {
    condition     = aws_organizations_policy.guardrails.type == "SERVICE_CONTROL_POLICY"
    error_message = "aws_organizations_policy.guardrails.type is not 'SERVICE_CONTROL_POLICY'"
  }

  assert {
    condition     = length(aws_organizations_policy.guardrails.content) <= 5120
    error_message = "the SCP content is longer than the 5120-character limit"
  }
}

# AC-11: by default the SCP is attached to the account named field-guide
run "ac11_scp_target_is_the_default_workload_account" {
  command = plan

  assert {
    condition     = aws_organizations_policy_attachment.guardrails_workload.target_id == "222222222222"
    error_message = "the SCP target_id is not '222222222222' (the account named field-guide)"
  }
}

# AC-11: workload_account_name picks another account by name
run "ac11_scp_target_follows_workload_account_name" {
  command = plan

  variables {
    workload_account_name = "other"
  }

  assert {
    condition     = aws_organizations_policy_attachment.guardrails_workload.target_id == "333333333333"
    error_message = "with workload_account_name = 'other' the SCP target_id is not '333333333333'"
  }
}

# AC-12: a name that no account has fails the plan
run "ac12_scp_target_missing_account_fails_the_plan" {
  command = plan

  variables {
    workload_account_name = "missing"
  }

  expect_failures = [aws_organizations_policy_attachment.guardrails_workload]
}

# AC-12: two accounts with the same name fail the plan (the lookup would be ambiguous)
run "ac12_scp_target_duplicate_account_names_fail_the_plan" {
  command = plan

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
          name   = "field-guide"
          status = "ACTIVE"
        },
      ]
    }
  }

  expect_failures = [aws_organizations_policy_attachment.guardrails_workload]
}
