# Tests for bootstrap/workload (spec 049, issue #161): the read-only CI role fg-tf-plan can no longer
# receive SQS messages or read CloudWatch Logs content. Its inline policy deny-data-reads
# (aws_iam_role_policy.tf_plan_deny) has five Deny statements: the three of spec 032 AC-17/AC-33
# followed by DenyMessageReads and DenyLogReads.
# All runs use command = plan with a mock provider, so nothing touches AWS.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }

  override_resource {
    target          = aws_s3_bucket.state
    override_during = plan
    values = {
      id     = "field-guide-tfstate-111111111111"
      bucket = "field-guide-tfstate-111111111111"
    }
  }
}

variables {
  github_sub_prefix = "repo:example-owner@1000/example-repo@2000"
}

# AC-1: tf_plan_deny has exactly five statements
run "ac1_tf_plan_deny_has_five_statements" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement) == 5
    error_message = "tf_plan_deny must have exactly 5 statements"
  }
}

# AC-1: the five Sids are the three existing ones, then the two new ones, in that order
run "ac1_tf_plan_deny_sids_in_order" {
  command = plan

  assert {
    condition     = [for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : try(s.Sid, "")] == ["DenyObjectReadsOutsideLabState", "DenySecretReads", "DenyParameterReads", "DenyMessageReads", "DenyLogReads"]
    error_message = "tf_plan_deny Sids must be DenyObjectReadsOutsideLabState, DenySecretReads, DenyParameterReads, DenyMessageReads, DenyLogReads, in that order"
  }
}

# AC-1: every statement of tf_plan_deny is a Deny
run "ac1_tf_plan_deny_statements_are_all_denies" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s.Effect == "Deny"])
    error_message = "every tf_plan_deny statement must be a Deny"
  }
}

# AC-1: the object read statement keeps its spec 032 shape
run "ac1_existing_object_read_statement_unchanged" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenyObjectReadsOutsideLabState" && s.Effect == "Deny" && toset([for v in flatten([try(s.NotResource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111/labs/*"]) && length(flatten([try(s.NotResource, [])])) == 1 && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["s3:GetObject", "s3:GetObjectVersion"]) && length(flatten([try(s.Action, [])])) == 2 && !contains(keys(s), "Resource") && !contains(keys(s), "Condition")]) == 1
    error_message = "DenyObjectReadsOutsideLabState must still deny exactly s3:GetObject and s3:GetObjectVersion on NotResource '<state bucket ARN>/labs/*'"
  }
}

# AC-1: the secret read statement keeps its spec 032 shape
run "ac1_existing_secret_read_statement_unchanged" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenySecretReads" && s.Effect == "Deny" && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:secretsmanager:*:111111111111:secret:*"]) && length(flatten([try(s.Resource, [])])) == 1 && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["secretsmanager:GetSecretValue"]) && length(flatten([try(s.Action, [])])) == 1 && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")]) == 1
    error_message = "DenySecretReads must still deny exactly secretsmanager:GetSecretValue on 'arn:aws:secretsmanager:*:111111111111:secret:*'"
  }
}

# AC-1: the parameter read statement keeps its spec 032 shape
run "ac1_existing_parameter_read_statement_unchanged" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenyParameterReads" && s.Effect == "Deny" && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:ssm:*:111111111111:parameter/*"]) && length(flatten([try(s.Resource, [])])) == 1 && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"]) && length(flatten([try(s.Action, [])])) == 4 && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")]) == 1
    error_message = "DenyParameterReads must still deny exactly the four ssm: read actions on 'arn:aws:ssm:*:111111111111:parameter/*'"
  }
}

# AC-2: exactly one statement has the Sid DenyMessageReads
run "ac2_message_reads_statement_exists_once" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenyMessageReads"]) == 1
    error_message = "tf_plan_deny needs exactly one statement with Sid DenyMessageReads"
  }
}

# AC-2: DenyMessageReads is a Deny
run "ac2_message_reads_is_a_deny" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenyMessageReads" && s.Effect == "Deny"]) == 1
    error_message = "DenyMessageReads must have Effect Deny"
  }
}

# AC-2: DenyMessageReads denies exactly sqs:ReceiveMessage
run "ac2_message_reads_action_is_exactly_receive_message" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenyMessageReads" && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["sqs:ReceiveMessage"]) && length(flatten([try(s.Action, [])])) == 1]) == 1
    error_message = "DenyMessageReads must have Action exactly {sqs:ReceiveMessage}"
  }
}

# AC-2: DenyMessageReads covers the account's queues in every Region
run "ac2_message_reads_resource_is_the_account_queues" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenyMessageReads" && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:sqs:*:111111111111:*"]) && length(flatten([try(s.Resource, [])])) == 1]) == 1
    error_message = "DenyMessageReads must have Resource exactly {arn:aws:sqs:*:111111111111:*}"
  }
}

# AC-2: DenyMessageReads is unconditional
run "ac2_message_reads_has_no_not_keys_or_condition" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenyMessageReads" && !contains(keys(s), "NotResource") && !contains(keys(s), "NotAction") && !contains(keys(s), "Condition")]) == 1
    error_message = "DenyMessageReads must have no NotResource, NotAction or Condition"
  }
}

# AC-3: exactly one statement has the Sid DenyLogReads
run "ac3_log_reads_statement_exists_once" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenyLogReads"]) == 1
    error_message = "tf_plan_deny needs exactly one statement with Sid DenyLogReads"
  }
}

# AC-3: DenyLogReads is a Deny
run "ac3_log_reads_is_a_deny" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenyLogReads" && s.Effect == "Deny"]) == 1
    error_message = "DenyLogReads must have Effect Deny"
  }
}

# AC-3: DenyLogReads denies exactly the seven log content actions
run "ac3_log_reads_action_is_exactly_the_seven_log_reads" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenyLogReads" && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["logs:FilterLogEvents", "logs:GetLogEvents", "logs:GetLogRecord", "logs:GetQueryResults", "logs:StartLiveTail", "logs:StartQuery", "logs:Unmask"]) && length(flatten([try(s.Action, [])])) == 7]) == 1
    error_message = "DenyLogReads must have Action exactly {logs:FilterLogEvents, logs:GetLogEvents, logs:GetLogRecord, logs:GetQueryResults, logs:StartLiveTail, logs:StartQuery, logs:Unmask}"
  }
}

# AC-3: DenyLogReads covers the account's log groups (and so their streams) in every Region
run "ac3_log_reads_resource_is_the_account_log_groups" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenyLogReads" && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:logs:*:111111111111:log-group:*"]) && length(flatten([try(s.Resource, [])])) == 1]) == 1
    error_message = "DenyLogReads must have Resource exactly {arn:aws:logs:*:111111111111:log-group:*}"
  }
}

# AC-3: DenyLogReads is unconditional
run "ac3_log_reads_has_no_not_keys_or_condition" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if try(s.Sid, "") == "DenyLogReads" && !contains(keys(s), "NotResource") && !contains(keys(s), "NotAction") && !contains(keys(s), "Condition")]) == 1
    error_message = "DenyLogReads must have no NotResource, NotAction or Condition"
  }
}

# AC-4: no tf_plan_deny action is a catch-all (*, sqs:*, logs:*)
run "ac4_no_catch_all_actions" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : !anytrue([for a in flatten([try(s.Action, [])]) : contains(["*", "sqs:*", "logs:*"], a)])])
    error_message = "no tf_plan_deny action may be '*', 'sqs:*' or 'logs:*'"
  }
}

# AC-4: no tf_plan_deny statement uses NotAction, which would deny everything but the listed actions
run "ac4_no_not_action_statements" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : !contains(keys(s), "NotAction")])
    error_message = "no tf_plan_deny statement may use NotAction"
  }
}

# AC-4: no tf_plan_deny action starts with the SQS and Logs refresh prefixes
run "ac4_no_action_in_the_refresh_families" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : !anytrue([for a in flatten([try(s.Action, [])]) : anytrue([for p in ["sqs:Get", "sqs:List", "logs:Describe", "logs:List"] : startswith(a, p)])])])
    error_message = "no tf_plan_deny action may be or start with sqs:Get, sqs:List, logs:Describe or logs:List"
  }
}

# AC-4: no tf_plan_deny action pattern matches the actions Terraform refresh of queues and log groups calls
run "ac4_refresh_actions_stay_allowed" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s.Effect != "Deny" || !anytrue([for a in flatten([try(s.Action, [])]) : anytrue([for t in ["sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListQueues", "sqs:ListQueueTags", "logs:DescribeLogGroups", "logs:ListTagsForResource", "logs:ListTagsLogGroup"] : can(regex(join("", ["^", replace(replace(a, "*", ".*"), "?", "."), "$"]), t))])])])
    error_message = "no tf_plan_deny Deny may match sqs:GetQueueAttributes, sqs:GetQueueUrl, sqs:ListQueues, sqs:ListQueueTags, logs:DescribeLogGroups, logs:ListTagsForResource or logs:ListTagsLogGroup (plan refresh must keep working)"
  }
}

# AC-4: the new statements only use the literal actions of AC-2 and AC-3 (no wildcards)
run "ac4_new_statements_use_only_the_listed_literals" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s if contains(["DenyMessageReads", "DenyLogReads"], try(s.Sid, ""))]) == 2 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : !contains(["DenyMessageReads", "DenyLogReads"], try(s.Sid, "")) || alltrue([for a in flatten([try(s.Action, [])]) : contains(["sqs:ReceiveMessage", "logs:FilterLogEvents", "logs:GetLogEvents", "logs:GetLogRecord", "logs:GetQueryResults", "logs:StartLiveTail", "logs:StartQuery", "logs:Unmask"], a) && !strcontains(a, "*") && !strcontains(a, "?")])])
    error_message = "every action of DenyMessageReads and DenyLogReads must be one of the literals sqs:ReceiveMessage, logs:FilterLogEvents, logs:GetLogEvents, logs:GetLogRecord, logs:GetQueryResults, logs:StartLiveTail, logs:StartQuery, logs:Unmask"
  }
}

# AC-5: tf_apply_deny has no Deny that names or covers sqs:ReceiveMessage
run "ac5_apply_deny_does_not_cover_receive_message" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect != "Deny" || !anytrue([for a in flatten([try(s.Action, [])]) : can(regex(join("", ["^", replace(replace(a, "*", ".*"), "?", "."), "$"]), "sqs:ReceiveMessage"))])])
    error_message = "the tf_apply_deny policy: no Deny may name or cover sqs:ReceiveMessage (the deny is the plan role's only)"
  }
}

# AC-5: tf_apply_deny has no Deny that names or covers a log content read
run "ac5_apply_deny_does_not_cover_log_reads" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect != "Deny" || !anytrue([for a in flatten([try(s.Action, [])]) : anytrue([for t in ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:GetLogRecord", "logs:GetQueryResults", "logs:StartLiveTail", "logs:StartQuery", "logs:Unmask"] : can(regex(join("", ["^", replace(replace(a, "*", ".*"), "?", "."), "$"]), t))])])])
    error_message = "the tf_apply_deny policy: no Deny may name or cover logs:FilterLogEvents, GetLogEvents, GetLogRecord, GetQueryResults, StartLiveTail, StartQuery or Unmask"
  }
}

# AC-5: the boundary has no Deny that names or covers sqs:ReceiveMessage
run "ac5_boundary_does_not_cover_receive_message" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_policy.boundary.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect != "Deny" || !anytrue([for a in flatten([try(s.Action, [])]) : can(regex(join("", ["^", replace(replace(a, "*", ".*"), "?", "."), "$"]), "sqs:ReceiveMessage"))])])
    error_message = "the boundary policy: no Deny may name or cover sqs:ReceiveMessage (the deny is the plan role's only)"
  }
}

# AC-5: the boundary has no Deny that names or covers a log content read
run "ac5_boundary_does_not_cover_log_reads" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_policy.boundary.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect != "Deny" || !anytrue([for a in flatten([try(s.Action, [])]) : anytrue([for t in ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:GetLogRecord", "logs:GetQueryResults", "logs:StartLiveTail", "logs:StartQuery", "logs:Unmask"] : can(regex(join("", ["^", replace(replace(a, "*", ".*"), "?", "."), "$"]), t))])])])
    error_message = "the boundary policy: no Deny may name or cover logs:FilterLogEvents, GetLogEvents, GetLogRecord, GetQueryResults, StartLiveTail, StartQuery or Unmask"
  }
}

# AC-11: the tf_apply_deny policy has no Deny with NotAction that covers sqs:ReceiveMessage and reaches a queue.
# A NotAction Deny covers an action when no NotAction pattern matches it; it reaches an ARN when its
# Resource has a matching pattern or its NotResource has none. IAM wildcards (* and ?) are matched
# with the regex specials of the patterns escaped. Actions and Resource patterns are matched
# case-insensitively (lower() on both sides); NotResource is matched case-sensitively like IAM does.
run "ac11_apply_not_action_does_not_reach_queue_receive_message" {
  command = plan

  assert {
    condition = (
      length(jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement) > 0
      && !anytrue([
        for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : anytrue([
          for a in ["sqs:ReceiveMessage"] : anytrue([
            for arn in ["arn:aws:sqs:eu-west-1:111111111111:q"] :
            s.Effect == "Deny" && contains(keys(s), "NotAction")
            && !anytrue([for p in flatten([try(s.NotAction, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(p), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(a)))])
            && (
              anytrue([for r in flatten([try(s.Resource, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(r), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(arn)))])
              || (contains(keys(s), "NotResource") && !anytrue([for r in flatten([try(s.NotResource, [])]) : can(regex(join("", ["^", replace(replace(replace(r, "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), arn))]))
            )
          ])
        ])
      ])
    )
    error_message = "the tf_apply_deny policy: a Deny with NotAction must not cover sqs:ReceiveMessage on a queue (it would shadow the lab 05 demo)"
  }

  # Positive control: the known NotAction statement DenyStateBucketSettings is found, its patterns match s3:GetObject
  # and its own resource (so the wildcard conversion matches), it covers the action under test and
  # does not reach the sample ARN. If the conversion matched nothing or everything, this fails.
  assert {
    condition = length([
      for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s
      if try(s.Sid, "") == "DenyStateBucketSettings" && s.Effect == "Deny" && contains(keys(s), "NotAction")
      && anytrue([for p in flatten([try(s.NotAction, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(p), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower("s3:GetObject")))])
      && anytrue([for r in flatten([try(s.Resource, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(r), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower("arn:aws:s3:::field-guide-tfstate-111111111111")))])
      && alltrue([for a in ["sqs:ReceiveMessage"] : !anytrue([for p in flatten([try(s.NotAction, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(p), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(a)))])])
      && alltrue([
        for arn in ["arn:aws:sqs:eu-west-1:111111111111:q"] : !(
          anytrue([for r in flatten([try(s.Resource, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(r), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(arn)))])
          || (contains(keys(s), "NotResource") && !anytrue([for r in flatten([try(s.NotResource, [])]) : can(regex(join("", ["^", replace(replace(replace(r, "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), arn))]))
        )
      ])
    ]) == 1
    error_message = "the tf_apply_deny policy: the known NotAction statement DenyStateBucketSettings must match s3:GetObject and arn:aws:s3:::field-guide-tfstate-111111111111, cover sqs:ReceiveMessage and not reach a queue (the wildcard conversion is broken)"
  }
}

# AC-11: the tf_apply_deny policy has no Deny with NotAction that covers an AC-3 log read and reaches a log group or a log stream.
# A NotAction Deny covers an action when no NotAction pattern matches it; it reaches an ARN when its
# Resource has a matching pattern or its NotResource has none. IAM wildcards (* and ?) are matched
# with the regex specials of the patterns escaped. Actions and Resource patterns are matched
# case-insensitively (lower() on both sides); NotResource is matched case-sensitively like IAM does.
run "ac11_apply_not_action_does_not_reach_log_reads" {
  command = plan

  assert {
    condition = (
      length(jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement) > 0
      && !anytrue([
        for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : anytrue([
          for a in ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:GetLogRecord", "logs:GetQueryResults", "logs:StartLiveTail", "logs:StartQuery", "logs:Unmask"] : anytrue([
            for arn in ["arn:aws:logs:eu-west-1:111111111111:log-group:g", "arn:aws:logs:eu-west-1:111111111111:log-group:g:log-stream:s"] :
            s.Effect == "Deny" && contains(keys(s), "NotAction")
            && !anytrue([for p in flatten([try(s.NotAction, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(p), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(a)))])
            && (
              anytrue([for r in flatten([try(s.Resource, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(r), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(arn)))])
              || (contains(keys(s), "NotResource") && !anytrue([for r in flatten([try(s.NotResource, [])]) : can(regex(join("", ["^", replace(replace(replace(r, "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), arn))]))
            )
          ])
        ])
      ])
    )
    error_message = "the tf_apply_deny policy: a Deny with NotAction must not cover an AC-3 log read on a log group or a log stream (it would shadow the lab 05 demo)"
  }

  # Positive control: the known NotAction statement DenyStateBucketSettings is found, its patterns match s3:GetObject
  # and its own resource (so the wildcard conversion matches), it covers the action under test and
  # does not reach the sample ARN. If the conversion matched nothing or everything, this fails.
  assert {
    condition = length([
      for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s
      if try(s.Sid, "") == "DenyStateBucketSettings" && s.Effect == "Deny" && contains(keys(s), "NotAction")
      && anytrue([for p in flatten([try(s.NotAction, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(p), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower("s3:GetObject")))])
      && anytrue([for r in flatten([try(s.Resource, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(r), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower("arn:aws:s3:::field-guide-tfstate-111111111111")))])
      && alltrue([for a in ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:GetLogRecord", "logs:GetQueryResults", "logs:StartLiveTail", "logs:StartQuery", "logs:Unmask"] : !anytrue([for p in flatten([try(s.NotAction, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(p), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(a)))])])
      && alltrue([
        for arn in ["arn:aws:logs:eu-west-1:111111111111:log-group:g", "arn:aws:logs:eu-west-1:111111111111:log-group:g:log-stream:s"] : !(
          anytrue([for r in flatten([try(s.Resource, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(r), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(arn)))])
          || (contains(keys(s), "NotResource") && !anytrue([for r in flatten([try(s.NotResource, [])]) : can(regex(join("", ["^", replace(replace(replace(r, "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), arn))]))
        )
      ])
    ]) == 1
    error_message = "the tf_apply_deny policy: the known NotAction statement DenyStateBucketSettings must match s3:GetObject and arn:aws:s3:::field-guide-tfstate-111111111111, cover an AC-3 log read and not reach a log group or a log stream (the wildcard conversion is broken)"
  }
}

# AC-11: the boundary policy has no Deny with NotAction that covers sqs:ReceiveMessage and reaches a queue.
# A NotAction Deny covers an action when no NotAction pattern matches it; it reaches an ARN when its
# Resource has a matching pattern or its NotResource has none. IAM wildcards (* and ?) are matched
# with the regex specials of the patterns escaped. Actions and Resource patterns are matched
# case-insensitively (lower() on both sides); NotResource is matched case-sensitively like IAM does.
run "ac11_boundary_not_action_does_not_reach_queue_receive_message" {
  command = plan

  assert {
    condition = (
      length(jsondecode(aws_iam_policy.boundary.policy).Statement) > 0
      && !anytrue([
        for s in jsondecode(aws_iam_policy.boundary.policy).Statement : anytrue([
          for a in ["sqs:ReceiveMessage"] : anytrue([
            for arn in ["arn:aws:sqs:eu-west-1:111111111111:q"] :
            s.Effect == "Deny" && contains(keys(s), "NotAction")
            && !anytrue([for p in flatten([try(s.NotAction, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(p), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(a)))])
            && (
              anytrue([for r in flatten([try(s.Resource, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(r), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(arn)))])
              || (contains(keys(s), "NotResource") && !anytrue([for r in flatten([try(s.NotResource, [])]) : can(regex(join("", ["^", replace(replace(replace(r, "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), arn))]))
            )
          ])
        ])
      ])
    )
    error_message = "the boundary policy: a Deny with NotAction must not cover sqs:ReceiveMessage on a queue (it would shadow the lab 05 demo)"
  }

  # Positive control: the known NotAction statement DenyProtectedIamChanges is found, its patterns match iam:GetRole
  # and its own resource (so the wildcard conversion matches), it covers the action under test and
  # does not reach the sample ARN. If the conversion matched nothing or everything, this fails.
  assert {
    condition = length([
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s
      if try(s.Sid, "") == "DenyProtectedIamChanges" && s.Effect == "Deny" && contains(keys(s), "NotAction")
      && anytrue([for p in flatten([try(s.NotAction, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(p), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower("iam:GetRole")))])
      && anytrue([for r in flatten([try(s.Resource, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(r), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower("arn:aws:iam::111111111111:role/fg-tf-plan")))])
      && alltrue([for a in ["sqs:ReceiveMessage"] : !anytrue([for p in flatten([try(s.NotAction, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(p), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(a)))])])
      && alltrue([
        for arn in ["arn:aws:sqs:eu-west-1:111111111111:q"] : !(
          anytrue([for r in flatten([try(s.Resource, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(r), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(arn)))])
          || (contains(keys(s), "NotResource") && !anytrue([for r in flatten([try(s.NotResource, [])]) : can(regex(join("", ["^", replace(replace(replace(r, "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), arn))]))
        )
      ])
    ]) == 1
    error_message = "the boundary policy: the known NotAction statement DenyProtectedIamChanges must match iam:GetRole and arn:aws:iam::111111111111:role/fg-tf-plan, cover sqs:ReceiveMessage and not reach a queue (the wildcard conversion is broken)"
  }
}

# AC-11: the boundary policy has no Deny with NotAction that covers an AC-3 log read and reaches a log group or a log stream.
# A NotAction Deny covers an action when no NotAction pattern matches it; it reaches an ARN when its
# Resource has a matching pattern or its NotResource has none. IAM wildcards (* and ?) are matched
# with the regex specials of the patterns escaped. Actions and Resource patterns are matched
# case-insensitively (lower() on both sides); NotResource is matched case-sensitively like IAM does.
run "ac11_boundary_not_action_does_not_reach_log_reads" {
  command = plan

  assert {
    condition = (
      length(jsondecode(aws_iam_policy.boundary.policy).Statement) > 0
      && !anytrue([
        for s in jsondecode(aws_iam_policy.boundary.policy).Statement : anytrue([
          for a in ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:GetLogRecord", "logs:GetQueryResults", "logs:StartLiveTail", "logs:StartQuery", "logs:Unmask"] : anytrue([
            for arn in ["arn:aws:logs:eu-west-1:111111111111:log-group:g", "arn:aws:logs:eu-west-1:111111111111:log-group:g:log-stream:s"] :
            s.Effect == "Deny" && contains(keys(s), "NotAction")
            && !anytrue([for p in flatten([try(s.NotAction, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(p), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(a)))])
            && (
              anytrue([for r in flatten([try(s.Resource, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(r), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(arn)))])
              || (contains(keys(s), "NotResource") && !anytrue([for r in flatten([try(s.NotResource, [])]) : can(regex(join("", ["^", replace(replace(replace(r, "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), arn))]))
            )
          ])
        ])
      ])
    )
    error_message = "the boundary policy: a Deny with NotAction must not cover an AC-3 log read on a log group or a log stream (it would shadow the lab 05 demo)"
  }

  # Positive control: the known NotAction statement DenyProtectedIamChanges is found, its patterns match iam:GetRole
  # and its own resource (so the wildcard conversion matches), it covers the action under test and
  # does not reach the sample ARN. If the conversion matched nothing or everything, this fails.
  assert {
    condition = length([
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s
      if try(s.Sid, "") == "DenyProtectedIamChanges" && s.Effect == "Deny" && contains(keys(s), "NotAction")
      && anytrue([for p in flatten([try(s.NotAction, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(p), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower("iam:GetRole")))])
      && anytrue([for r in flatten([try(s.Resource, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(r), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower("arn:aws:iam::111111111111:role/fg-tf-plan")))])
      && alltrue([for a in ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:GetLogRecord", "logs:GetQueryResults", "logs:StartLiveTail", "logs:StartQuery", "logs:Unmask"] : !anytrue([for p in flatten([try(s.NotAction, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(p), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(a)))])])
      && alltrue([
        for arn in ["arn:aws:logs:eu-west-1:111111111111:log-group:g", "arn:aws:logs:eu-west-1:111111111111:log-group:g:log-stream:s"] : !(
          anytrue([for r in flatten([try(s.Resource, [])]) : can(regex(join("", ["^", replace(replace(replace(lower(r), "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), lower(arn)))])
          || (contains(keys(s), "NotResource") && !anytrue([for r in flatten([try(s.NotResource, [])]) : can(regex(join("", ["^", replace(replace(replace(r, "/([.+^$${}()|\\[\\]\\\\])/", "\\$1"), "*", ".*"), "?", "."), "$"]), arn))]))
        )
      ])
    ]) == 1
    error_message = "the boundary policy: the known NotAction statement DenyProtectedIamChanges must match iam:GetRole and arn:aws:iam::111111111111:role/fg-tf-plan, cover an AC-3 log read and not reach a log group or a log stream (the wildcard conversion is broken)"
  }
}
