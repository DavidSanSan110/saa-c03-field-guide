# Tests for bootstrap/workload (spec 032, review round 1): the lab role path rule, guardrail extras,
# bucket sub-resource wiring and exactness of the deny statements.
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

# AC-29: the tf_apply_deny policy denies role writes outside the /lab/ path
run "ac29_apply_role_writes_confined_to_lab_path" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && toset([for v in flatten([try(s.NotResource, [])]) : tostring(v)]) == toset(["arn:aws:iam::111111111111:role/lab/*"]) && length(flatten([try(s.NotResource, [])])) == 1 && !contains(keys(s), "Resource") && !contains(keys(s), "Condition") && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:PassRole", "sts:AssumeRole"]) && length(flatten([try(s.Action, [])])) == 15 && !contains(keys(s), "NotAction")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny with NotResource exactly 'arn:aws:iam::111111111111:role/lab/*' (no Resource) whose Action is exactly the 15 role-write actions"
  }
}

# AC-29: the tf_apply_deny policy never matches iam:CreateServiceLinkedRole
run "ac29_apply_service_linked_roles_stay_allowed" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect != "Deny" || !anytrue([for a in flatten([try(s.Action, [])]) : can(regex(join("", ["^", replace(replace(a, "*", ".*"), "?", "."), "$"]), "iam:CreateServiceLinkedRole"))])])
    error_message = "the tf_apply_deny policy: no Deny statement may have an Action that matches iam:CreateServiceLinkedRole (service-linked roles stay allowed)"
  }
}

# AC-30: the tf_apply_deny policy also protects the default EBS key and the Access Analyzer findings
run "ac30_apply_guardrail_extras" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "ec2:ModifyEbsDefaultKmsKeyId" || (endswith(a, "*") && startswith("ec2:ModifyEbsDefaultKmsKeyId", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on ec2:ModifyEbsDefaultKmsKeyId over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "access-analyzer:CreateArchiveRule" || (endswith(a, "*") && startswith("access-analyzer:CreateArchiveRule", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on access-analyzer:CreateArchiveRule over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "access-analyzer:UpdateArchiveRule" || (endswith(a, "*") && startswith("access-analyzer:UpdateArchiveRule", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on access-analyzer:UpdateArchiveRule over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "access-analyzer:ApplyArchiveRule" || (endswith(a, "*") && startswith("access-analyzer:ApplyArchiveRule", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on access-analyzer:ApplyArchiveRule over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "access-analyzer:UpdateFindings" || (endswith(a, "*") && startswith("access-analyzer:UpdateFindings", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on access-analyzer:UpdateFindings over '*'"
  }
}

# AC-34: the tf_apply_deny policy: only the six actions that carry iam:PermissionsBoundary have the StringNotEquals condition
run "ac34_apply_boundary_condition_statement_is_exactly_the_six_actions" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s if contains(keys(try(s.Condition, {})), "StringNotEquals")]) >= 1
    error_message = "the tf_apply_deny policy needs a statement with a StringNotEquals condition"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : !contains(keys(try(s.Condition, {})), "StringNotEquals") || (toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["iam:CreateRole", "iam:PutRolePermissionsBoundary", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy"]) && length(flatten([try(s.Action, [])])) == 6)])
    error_message = "the tf_apply_deny policy: every StringNotEquals statement must have Action exactly the six actions CreateRole, PutRolePermissionsBoundary, PutRolePolicy, DeleteRolePolicy, AttachRolePolicy, DetachRolePolicy"
  }
}

# AC-29: the boundary policy denies role writes outside the /lab/ path
run "ac29_boundary_role_writes_confined_to_lab_path" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && toset([for v in flatten([try(s.NotResource, [])]) : tostring(v)]) == toset(["arn:aws:iam::111111111111:role/lab/*"]) && length(flatten([try(s.NotResource, [])])) == 1 && !contains(keys(s), "Resource") && !contains(keys(s), "Condition") && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:PassRole", "sts:AssumeRole"]) && length(flatten([try(s.Action, [])])) == 15 && !contains(keys(s), "NotAction")])
    error_message = "the boundary policy needs an unconditional Deny with NotResource exactly 'arn:aws:iam::111111111111:role/lab/*' (no Resource) whose Action is exactly the 15 role-write actions"
  }
}

# AC-29: the boundary policy never matches iam:CreateServiceLinkedRole
run "ac29_boundary_service_linked_roles_stay_allowed" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_policy.boundary.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect != "Deny" || !anytrue([for a in flatten([try(s.Action, [])]) : can(regex(join("", ["^", replace(replace(a, "*", ".*"), "?", "."), "$"]), "iam:CreateServiceLinkedRole"))])])
    error_message = "the boundary policy: no Deny statement may have an Action that matches iam:CreateServiceLinkedRole (service-linked roles stay allowed)"
  }
}

# AC-30: the boundary policy also protects the default EBS key and the Access Analyzer findings
run "ac30_boundary_guardrail_extras" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "ec2:ModifyEbsDefaultKmsKeyId" || (endswith(a, "*") && startswith("ec2:ModifyEbsDefaultKmsKeyId", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on ec2:ModifyEbsDefaultKmsKeyId over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "access-analyzer:CreateArchiveRule" || (endswith(a, "*") && startswith("access-analyzer:CreateArchiveRule", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on access-analyzer:CreateArchiveRule over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "access-analyzer:UpdateArchiveRule" || (endswith(a, "*") && startswith("access-analyzer:UpdateArchiveRule", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on access-analyzer:UpdateArchiveRule over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "access-analyzer:ApplyArchiveRule" || (endswith(a, "*") && startswith("access-analyzer:ApplyArchiveRule", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on access-analyzer:ApplyArchiveRule over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "access-analyzer:UpdateFindings" || (endswith(a, "*") && startswith("access-analyzer:UpdateFindings", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on access-analyzer:UpdateFindings over '*'"
  }
}

# AC-34: the boundary policy: only the six actions that carry iam:PermissionsBoundary have the StringNotEquals condition
run "ac34_boundary_boundary_condition_statement_is_exactly_the_six_actions" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s if contains(keys(try(s.Condition, {})), "StringNotEquals")]) >= 1
    error_message = "the boundary policy needs a statement with a StringNotEquals condition"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : !contains(keys(try(s.Condition, {})), "StringNotEquals") || (toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["iam:CreateRole", "iam:PutRolePermissionsBoundary", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy"]) && length(flatten([try(s.Action, [])])) == 6)])
    error_message = "the boundary policy: every StringNotEquals statement must have Action exactly the six actions CreateRole, PutRolePermissionsBoundary, PutRolePolicy, DeleteRolePolicy, AttachRolePolicy, DetachRolePolicy"
  }
}

# AC-29: the lab role path is exported for the lab stacks
run "ac29_lab_role_path_output" {
  command = plan

  assert {
    condition     = output.lab_role_path == "/lab/"
    error_message = "output lab_role_path is not '/lab/'"
  }
}

# AC-31: every state bucket sub-resource points at the state bucket by name
run "ac31_sub_resources_target_the_state_bucket" {
  command = plan

  assert {
    condition     = aws_s3_bucket_versioning.state.bucket == "field-guide-tfstate-111111111111"
    error_message = "aws_s3_bucket_versioning.state.bucket is not the state bucket"
  }

  assert {
    condition     = aws_s3_bucket_server_side_encryption_configuration.state.bucket == "field-guide-tfstate-111111111111"
    error_message = "aws_s3_bucket_server_side_encryption_configuration.state.bucket is not the state bucket"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.state.bucket == "field-guide-tfstate-111111111111"
    error_message = "aws_s3_bucket_public_access_block.state.bucket is not the state bucket"
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.state.bucket == "field-guide-tfstate-111111111111"
    error_message = "aws_s3_bucket_ownership_controls.state.bucket is not the state bucket"
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.state.bucket == "field-guide-tfstate-111111111111"
    error_message = "aws_s3_bucket_lifecycle_configuration.state.bucket is not the state bucket"
  }

  assert {
    condition     = aws_s3_bucket_policy.state.bucket == "field-guide-tfstate-111111111111"
    error_message = "aws_s3_bucket_policy.state.bucket is not the state bucket"
  }
}

# AC-32: the CI-role deny only touches object actions (ListBucket stays allowed)
run "ac32_ci_deny_stays_object_level" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Effect == "Deny" && toset([for v in flatten([try(s.NotResource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111/labs/*"])]) >= 1
    error_message = "the bucket policy needs the CI-role deny (NotResource <bucket ARN>/labs/*)"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : !(s.Effect == "Deny" && toset([for v in flatten([try(s.NotResource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111/labs/*"])) || alltrue([for a in flatten([try(s.Action, [])]) : strcontains(a, "Object") && !contains(["s3:*", "s3:List*", "s3:ListBucket", "s3:Get*"], a)])])
    error_message = "every action of the CI-role deny must contain Object and none may be s3:*, s3:List*, s3:ListBucket or s3:Get*"
  }
}

# AC-32: the tf-plan write deny only has Put/Delete object actions
run "ac32_plan_role_deny_is_put_and_delete_object_only" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Effect == "Deny" && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111/*"]) && contains(keys(try(s.Condition, {})), "ArnEquals")]) >= 1
    error_message = "the bucket policy needs the tf-plan write deny (Resource <bucket ARN>/*, ArnEquals)"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : !(s.Effect == "Deny" && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111/*"]) && contains(keys(try(s.Condition, {})), "ArnEquals")) || alltrue([for a in flatten([try(s.Action, [])]) : (startswith(a, "s3:Put") || startswith(a, "s3:Delete")) && strcontains(a, "Object")])])
    error_message = "every action of the tf-plan write deny must start with s3:Put or s3:Delete and contain Object"
  }
}

# AC-32: the bootstrap deny only covers bootstrap/* keys, never the bucket ARN
run "ac32_bootstrap_deny_never_covers_the_bucket_arn" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Effect == "Deny" && contains(keys(try(s.Condition, {})), "ArnNotLike")]) >= 1
    error_message = "the bucket policy needs the bootstrap deny (ArnNotLike condition)"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : !(s.Effect == "Deny" && contains(keys(try(s.Condition, {})), "ArnNotLike")) || (toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111/bootstrap/*"]) && !contains(keys(s), "NotResource"))])
    error_message = "the bootstrap deny's resource must be exactly '<bucket ARN>/bootstrap/*'"
  }
}

# AC-33: the tf-plan inline policy has exactly the three expected denies
run "ac33_tf_plan_deny_is_exactly_three_statements" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement) == 3
    error_message = "tf_plan_deny must have exactly 3 statements"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s.Effect == "Deny" && toset([for v in flatten([try(s.NotResource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111/labs/*"]) && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["s3:GetObject", "s3:GetObjectVersion"]) && length(flatten([try(s.Action, [])])) == 2])
    error_message = "the NotResource statement must have Action exactly {s3:GetObject, s3:GetObjectVersion}"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s.Effect == "Deny" && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:secretsmanager:*:111111111111:secret:*"]) && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["secretsmanager:GetSecretValue"]) && length(flatten([try(s.Action, [])])) == 1])
    error_message = "the secrets statement must have Action exactly {secretsmanager:GetSecretValue}"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s.Effect == "Deny" && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:ssm:*:111111111111:parameter/*"]) && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"]) && length(flatten([try(s.Action, [])])) == 4])
    error_message = "the parameters statement must have Action exactly the four ssm: read actions"
  }
}

# AC-35: the boundary and tf_apply_deny carry the same shared statements
run "ac35_boundary_and_apply_share_their_denies" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s if !(s.Effect == "Allow" || (toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["s3:*"]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111", "arn:aws:s3:::field-guide-tfstate-111111111111/*"])))]) > 0
    error_message = "the boundary must have statements besides the Allow and the state bucket deny"
  }

  assert {
    condition     = toset([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : jsonencode(s) if !(s.Effect == "Allow" || (toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["s3:*"]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111", "arn:aws:s3:::field-guide-tfstate-111111111111/*"])))]) == toset([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : jsonencode(s) if !(toset([for v in flatten([try(s.NotAction, [])]) : tostring(v)]) == toset(["s3:Get*", "s3:List*"]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111"]))])
    error_message = "the boundary's statements (minus its Allow and the s3:* state deny) must equal tf_apply_deny's (minus DenyStateBucketSettings)"
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s if !(s.Effect == "Allow" || (toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["s3:*"]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111", "arn:aws:s3:::field-guide-tfstate-111111111111/*"])))]) == length([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s if !(toset([for v in flatten([try(s.NotAction, [])]) : tostring(v)]) == toset(["s3:Get*", "s3:List*"]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111"]))])
    error_message = "the two policies must have the same number of shared statements"
  }
}
