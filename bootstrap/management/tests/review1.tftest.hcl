# Regression tests for bootstrap/management (spec 031, review round 1: AC-19 to AC-26).
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

  override_resource {
    target          = aws_ce_anomaly_monitor.services
    override_during = plan
    values = {
      arn = "arn:aws:ce::111111111111:anomalymonitor/example"
    }
  }
}

variables {
  alert_email = "alerts@example.com"
}

# AC-19: the trail has no log prefix (the bucket policy only allows AWSLogs/...)
run "ac19_trail_has_no_s3_key_prefix" {
  command = plan

  assert {
    condition     = aws_cloudtrail.org.s3_key_prefix == null || aws_cloudtrail.org.s3_key_prefix == ""
    error_message = "aws_cloudtrail.org.s3_key_prefix must be unset or empty: the bucket policy only allows AWSLogs/..."
  }
}

# AC-19: no event selector excludes a management event source
run "ac19_trail_excludes_no_management_event_sources" {
  command = plan

  assert {
    condition = alltrue([
      for e in aws_cloudtrail.org.event_selector :
      try(length(e.exclude_management_event_sources), 0) == 0
    ])
    error_message = "no event_selector may set exclude_management_event_sources"
  }
}

# AC-20: the Region statement exempts no regional service (no '*' and no ec2, s3, kms... wildcard)
run "ac20_scp_region_not_action_has_no_regional_wildcards" {
  command = plan

  assert {
    condition = length([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      s if contains(keys(s), "NotAction")
    ]) == 1
    error_message = "the SCP must have exactly one Region statement (NotAction)"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      length(setintersection(
        toset(flatten([s.NotAction])),
        toset(["*", "ec2:*", "s3:*", "kms:*", "lambda:*", "rds:*", "dynamodb:*", "cloudtrail:*", "acm:*"])
      )) == 0
      if contains(keys(s), "NotAction")
    ])
    error_message = "the Region statement NotAction must not contain '*', ec2:*, s3:*, kms:*, lambda:*, rds:*, dynamodb:*, cloudtrail:* or acm:*"
  }
}

# AC-20: the Region condition is exactly StringNotEquals on aws:RequestedRegion, nothing else
run "ac20_scp_region_condition_is_only_requested_region" {
  command = plan

  assert {
    condition = length([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      s if contains(keys(s), "NotAction")
    ]) == 1
    error_message = "the SCP must have exactly one Region statement (NotAction)"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      toset(keys(s.Condition)) == toset(["StringNotEquals"]) &&
      toset(keys(s.Condition.StringNotEquals)) == toset(["aws:RequestedRegion"])
      if contains(keys(s), "NotAction")
    ])
    error_message = "the Region condition must have exactly one operator (StringNotEquals) with exactly one key (aws:RequestedRegion)"
  }
}

# AC-21: every SCP statement applies to Resource '*' (a string or a one-element list)
run "ac21_scp_every_statement_has_resource_star" {
  command = plan

  assert {
    condition = alltrue([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      length(flatten([s.Resource])) == 1 && flatten([s.Resource])[0] == "*"
    ])
    error_message = "every SCP statement must have Resource = '*'"
  }
}

# AC-21: only the Region statement has a Condition
run "ac21_scp_only_the_region_statement_has_a_condition" {
  command = plan

  assert {
    condition = length([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      s if contains(keys(s), "NotAction")
    ]) == 1
    error_message = "the SCP must have exactly one Region statement (NotAction)"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_organizations_policy.guardrails.content).Statement :
      contains(keys(s), "Condition") == contains(keys(s), "NotAction")
    ])
    error_message = "only the Region statement may have a Condition; the other deny statements must have none"
  }
}

# AC-22: every Allow in the log bucket policy is for exactly { Service = cloudtrail.amazonaws.com }
run "ac22_log_policy_allow_principal_is_only_the_cloudtrail_service" {
  command = plan

  assert {
    condition = length([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement : s if s.Effect == "Allow"
    ]) >= 3
    error_message = "the log bucket policy must have its Allow statements"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement :
      toset(try(keys(s.Principal), ["not-an-object"])) == toset(["Service"]) &&
      toset(flatten([try(s.Principal.Service, "none")])) == toset(["cloudtrail.amazonaws.com"])
      if s.Effect == "Allow"
    ])
    error_message = "every Allow Principal must be exactly { Service = 'cloudtrail.amazonaws.com' } with no other key (no AWS, no *)"
  }
}

# AC-23: every enabled lifecycle rule applies to the whole bucket (no filter, or an empty one).
# filter.prefix and the object size limits are Optional+Computed, so they are unknown at plan time
# when the filter is empty and a plan-time assertion on them cannot be evaluated: a non-empty prefix
# is pinned by the contract test in tools/guardrails/src/bootstrap-management.test.ts instead.
run "ac23_log_lifecycle_rules_cover_the_whole_bucket" {
  command = plan

  assert {
    condition = alltrue([
      for r in aws_s3_bucket_lifecycle_configuration.trail_logs.rule :
      alltrue([
        for f in r.filter :
        length(f.and) == 0 && length(f.tag) == 0
      ])
      if r.status == "Enabled"
    ])
    error_message = "every enabled lifecycle rule must apply to the whole bucket: no filter, or an empty filter / empty prefix"
  }
}

# AC-23: no enabled rule expires current objects before 365 days
run "ac23_log_lifecycle_never_expires_current_objects_early" {
  command = plan

  assert {
    condition = alltrue([
      for r in aws_s3_bucket_lifecycle_configuration.trail_logs.rule :
      alltrue([for e in r.expiration : try(e.days, null) == null || e.days >= 365])
      if r.status == "Enabled"
    ])
    error_message = "no enabled lifecycle rule may expire current objects sooner than 365 days"
  }
}

# AC-23: no enabled rule expires noncurrent versions before 30 days
run "ac23_log_lifecycle_never_expires_noncurrent_versions_early" {
  command = plan

  assert {
    condition = alltrue([
      for r in aws_s3_bucket_lifecycle_configuration.trail_logs.rule :
      alltrue([for n in r.noncurrent_version_expiration : try(n.noncurrent_days, null) == null || n.noncurrent_days >= 30])
      if r.status == "Enabled"
    ])
    error_message = "no enabled lifecycle rule may expire noncurrent versions sooner than 30 days"
  }
}

# AC-24: the Organization enables exactly the SCP policy type (no TAG_POLICY, BACKUP_POLICY...)
run "ac24_organization_enables_only_the_scp_policy_type" {
  command = plan

  assert {
    condition     = toset(aws_organizations_organization.this.enabled_policy_types) == toset(["SERVICE_CONTROL_POLICY"])
    error_message = "enabled_policy_types must be exactly {SERVICE_CONTROL_POLICY}"
  }
}

# AC-25: the budget keeps the primary billing view of the management account
run "ac25_budget_billing_view_is_the_primary_view" {
  command = plan

  assert {
    condition     = aws_budgets_budget.monthly.billing_view_arn == "arn:aws:billing::111111111111:billingview/primary"
    error_message = "aws_budgets_budget.monthly.billing_view_arn is not 'arn:aws:billing::111111111111:billingview/primary'"
  }
}

# AC-25: no budget notification has SNS topic subscribers
run "ac25_budget_notifications_have_no_sns_subscribers" {
  command = plan

  assert {
    condition = alltrue([
      for n in aws_budgets_budget.monthly.notification :
      try(length(n.subscriber_sns_topic_arns), 0) == 0
    ])
    error_message = "no budget notification may have subscriber_sns_topic_arns"
  }
}

# AC-25: the budget has no auto_adjust_data block
run "ac25_budget_has_no_auto_adjust_data" {
  command = plan

  assert {
    condition     = try(length(aws_budgets_budget.monthly.auto_adjust_data), 0) == 0
    error_message = "aws_budgets_budget.monthly must not set auto_adjust_data"
  }
}

# AC-26: the new anomaly subscription has the pinned name
run "ac26_anomaly_subscription_name" {
  command = plan

  assert {
    condition     = aws_ce_anomaly_subscription.impact_5usd.name == "field-guide-impact-5usd"
    error_message = "aws_ce_anomaly_subscription.impact_5usd.name is not 'field-guide-impact-5usd'"
  }
}
