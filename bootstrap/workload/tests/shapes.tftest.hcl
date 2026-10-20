# Tests for bootstrap/workload (spec 032): the shape shared by every policy document of the stack.
# All runs use command = plan with a mock provider, so nothing touches AWS.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
}

variables {
  github_sub_prefix = "repo:example-owner@1000/example-repo@2000"
}

# AC-23: bucket_policy is a 2012-10-17 document with statements
run "ac23_bucket_policy_has_statements_and_the_current_version" {
  command = plan

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.state.policy).Version == "2012-10-17"
    error_message = "bucket_policy: Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_s3_bucket_policy.state.policy).Statement) > 0
    error_message = "bucket_policy: the policy must have at least one statement"
  }
}

# AC-23: bucket_policy has no NotPrincipal
run "ac23_bucket_policy_never_uses_not_principal" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_s3_bucket_policy.state.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : !contains(keys(s), "NotPrincipal")])
    error_message = "bucket_policy: no statement may use NotPrincipal"
  }
}

# AC-23: bucket_policy never combines Resource and NotResource
run "ac23_bucket_policy_resource_xor_not_resource" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_s3_bucket_policy.state.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : !(contains(keys(s), "Resource") && contains(keys(s), "NotResource"))])
    error_message = "bucket_policy: a statement must not have both Resource and NotResource"
  }
}

# AC-23: tf_plan_trust is a 2012-10-17 document with statements
run "ac23_tf_plan_trust_has_statements_and_the_current_version" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role.tf_plan.assume_role_policy).Version == "2012-10-17"
    error_message = "tf_plan_trust: Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.tf_plan.assume_role_policy).Statement) > 0
    error_message = "tf_plan_trust: the policy must have at least one statement"
  }
}

# AC-23: tf_plan_trust has no NotPrincipal
run "ac23_tf_plan_trust_never_uses_not_principal" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role.tf_plan.assume_role_policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role.tf_plan.assume_role_policy).Statement : !contains(keys(s), "NotPrincipal")])
    error_message = "tf_plan_trust: no statement may use NotPrincipal"
  }
}

# AC-23: tf_plan_trust never combines Resource and NotResource
run "ac23_tf_plan_trust_resource_xor_not_resource" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role.tf_plan.assume_role_policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role.tf_plan.assume_role_policy).Statement : !(contains(keys(s), "Resource") && contains(keys(s), "NotResource"))])
    error_message = "tf_plan_trust: a statement must not have both Resource and NotResource"
  }
}

# AC-23: tf_apply_trust is a 2012-10-17 document with statements
run "ac23_tf_apply_trust_has_statements_and_the_current_version" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role.tf_apply.assume_role_policy).Version == "2012-10-17"
    error_message = "tf_apply_trust: Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement) > 0
    error_message = "tf_apply_trust: the policy must have at least one statement"
  }
}

# AC-23: tf_apply_trust has no NotPrincipal
run "ac23_tf_apply_trust_never_uses_not_principal" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement : !contains(keys(s), "NotPrincipal")])
    error_message = "tf_apply_trust: no statement may use NotPrincipal"
  }
}

# AC-23: tf_apply_trust never combines Resource and NotResource
run "ac23_tf_apply_trust_resource_xor_not_resource" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement : !(contains(keys(s), "Resource") && contains(keys(s), "NotResource"))])
    error_message = "tf_apply_trust: a statement must not have both Resource and NotResource"
  }
}

# AC-23: tf_plan_deny is a 2012-10-17 document with statements
run "ac23_tf_plan_deny_has_statements_and_the_current_version" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Version == "2012-10-17"
    error_message = "tf_plan_deny: Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement) > 0
    error_message = "tf_plan_deny: the policy must have at least one statement"
  }
}

# AC-23: tf_plan_deny has no NotPrincipal
run "ac23_tf_plan_deny_never_uses_not_principal" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : !contains(keys(s), "NotPrincipal")])
    error_message = "tf_plan_deny: no statement may use NotPrincipal"
  }
}

# AC-23: tf_plan_deny never combines Resource and NotResource
run "ac23_tf_plan_deny_resource_xor_not_resource" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : !(contains(keys(s), "Resource") && contains(keys(s), "NotResource"))])
    error_message = "tf_plan_deny: a statement must not have both Resource and NotResource"
  }
}

# AC-23: tf_apply_deny is a 2012-10-17 document with statements
run "ac23_tf_apply_deny_has_statements_and_the_current_version" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Version == "2012-10-17"
    error_message = "tf_apply_deny: Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement) > 0
    error_message = "tf_apply_deny: the policy must have at least one statement"
  }
}

# AC-23: tf_apply_deny has no NotPrincipal
run "ac23_tf_apply_deny_never_uses_not_principal" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : !contains(keys(s), "NotPrincipal")])
    error_message = "tf_apply_deny: no statement may use NotPrincipal"
  }
}

# AC-23: tf_apply_deny never combines Resource and NotResource
run "ac23_tf_apply_deny_resource_xor_not_resource" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : !(contains(keys(s), "Resource") && contains(keys(s), "NotResource"))])
    error_message = "tf_apply_deny: a statement must not have both Resource and NotResource"
  }
}

# AC-23: boundary is a 2012-10-17 document with statements
run "ac23_boundary_has_statements_and_the_current_version" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_policy.boundary.policy).Version == "2012-10-17"
    error_message = "boundary: Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_policy.boundary.policy).Statement) > 0
    error_message = "boundary: the policy must have at least one statement"
  }
}

# AC-23: boundary has no NotPrincipal
run "ac23_boundary_never_uses_not_principal" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_policy.boundary.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : !contains(keys(s), "NotPrincipal")])
    error_message = "boundary: no statement may use NotPrincipal"
  }
}

# AC-23: boundary never combines Resource and NotResource
run "ac23_boundary_resource_xor_not_resource" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_policy.boundary.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : !(contains(keys(s), "Resource") && contains(keys(s), "NotResource"))])
    error_message = "boundary: a statement must not have both Resource and NotResource"
  }
}
