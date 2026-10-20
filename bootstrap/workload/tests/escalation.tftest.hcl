# Tests for bootstrap/workload (spec 032): the deny statements of the tf-apply inline policy and of the
# fg-workload-boundary permissions boundary. All runs use command = plan with a mock provider.

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

# AC-18: the tf_apply_deny policy denies role changes unless the boundary is set
run "ac18_apply_no_role_changes_without_boundary" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:CreateRole" || (endswith(a, "*") && startswith("iam:CreateRole", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:PutRolePermissionsBoundary" || (endswith(a, "*") && startswith("iam:PutRolePermissionsBoundary", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:PutRolePolicy" || (endswith(a, "*") && startswith("iam:PutRolePolicy", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:DeleteRolePolicy" || (endswith(a, "*") && startswith("iam:DeleteRolePolicy", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:AttachRolePolicy" || (endswith(a, "*") && startswith("iam:AttachRolePolicy", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:DetachRolePolicy" || (endswith(a, "*") && startswith("iam:DetachRolePolicy", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && toset(keys(try(s.Condition, {}))) == toset(["StringNotEquals"]) && toset(keys(try(s.Condition["StringNotEquals"], {}))) == toset(["iam:PermissionsBoundary"]) && toset([for v in flatten([try(s.Condition["StringNotEquals"]["iam:PermissionsBoundary"], [])]) : tostring(v)]) == toset(["arn:aws:iam::111111111111:policy/fg-workload-boundary"])])
    error_message = "the tf_apply_deny policy needs a Deny on CreateRole, PutRolePermissionsBoundary, PutRolePolicy, DeleteRolePolicy, AttachRolePolicy and DetachRolePolicy over '*' whose only condition is StringNotEquals iam:PermissionsBoundary = the boundary ARN"
  }
}

# AC-18: the tf_apply_deny policy denies removing a permissions boundary
run "ac18_apply_boundary_cannot_be_removed" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:DeleteRolePermissionsBoundary" || (endswith(a, "*") && startswith("iam:DeleteRolePermissionsBoundary", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on iam:DeleteRolePermissionsBoundary over '*'"
  }
}

# AC-19: the tf_apply_deny policy protects the CI roles, the org role, the boundary and the OIDC provider
run "ac19_apply_protected_iam_resources" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && toset([for v in flatten([try(s.NotAction, [])]) : tostring(v)]) == toset(["iam:Get*", "iam:List*"]) && !contains(keys(s), "Action") && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:iam::111111111111:role/fg-tf-plan", "arn:aws:iam::111111111111:role/fg-tf-apply", "arn:aws:iam::111111111111:role/OrganizationAccountAccessRole", "arn:aws:iam::111111111111:policy/fg-workload-boundary", "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny with NotAction exactly {iam:Get*, iam:List*} on exactly the tf-plan, tf-apply, OrganizationAccountAccessRole, boundary and OIDC provider ARNs"
  }
}

# AC-20: the tf_apply_deny policy denies IAM users, access keys and login profiles
run "ac20_apply_no_iam_users_or_keys" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:CreateUser" || (endswith(a, "*") && startswith("iam:CreateUser", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on iam:CreateUser over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:CreateAccessKey" || (endswith(a, "*") && startswith("iam:CreateAccessKey", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on iam:CreateAccessKey over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:CreateLoginProfile" || (endswith(a, "*") && startswith("iam:CreateLoginProfile", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on iam:CreateLoginProfile over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:UpdateLoginProfile" || (endswith(a, "*") && startswith("iam:UpdateLoginProfile", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on iam:UpdateLoginProfile over '*'"
  }
}

# AC-20: the tf_apply_deny policy protects the account guardrails
run "ac20_apply_guardrails_cannot_be_changed" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "s3:PutAccountPublicAccessBlock" || (endswith(a, "*") && startswith("s3:PutAccountPublicAccessBlock", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on s3:PutAccountPublicAccessBlock over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "ec2:DisableEbsEncryptionByDefault" || (endswith(a, "*") && startswith("ec2:DisableEbsEncryptionByDefault", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on ec2:DisableEbsEncryptionByDefault over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "access-analyzer:DeleteAnalyzer" || (endswith(a, "*") && startswith("access-analyzer:DeleteAnalyzer", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && (toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) || toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:access-analyzer:eu-west-1:111111111111:analyzer/field-guide-account"])) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the tf_apply_deny policy needs an unconditional Deny on access-analyzer:DeleteAnalyzer over '*' or exactly the field-guide-account analyzer ARN"
  }
}

# AC-18: the boundary policy denies role changes unless the boundary is set
run "ac18_boundary_no_role_changes_without_boundary" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:CreateRole" || (endswith(a, "*") && startswith("iam:CreateRole", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:PutRolePermissionsBoundary" || (endswith(a, "*") && startswith("iam:PutRolePermissionsBoundary", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:PutRolePolicy" || (endswith(a, "*") && startswith("iam:PutRolePolicy", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:DeleteRolePolicy" || (endswith(a, "*") && startswith("iam:DeleteRolePolicy", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:AttachRolePolicy" || (endswith(a, "*") && startswith("iam:AttachRolePolicy", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:DetachRolePolicy" || (endswith(a, "*") && startswith("iam:DetachRolePolicy", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && toset(keys(try(s.Condition, {}))) == toset(["StringNotEquals"]) && toset(keys(try(s.Condition["StringNotEquals"], {}))) == toset(["iam:PermissionsBoundary"]) && toset([for v in flatten([try(s.Condition["StringNotEquals"]["iam:PermissionsBoundary"], [])]) : tostring(v)]) == toset(["arn:aws:iam::111111111111:policy/fg-workload-boundary"])])
    error_message = "the boundary policy needs a Deny on CreateRole, PutRolePermissionsBoundary, PutRolePolicy, DeleteRolePolicy, AttachRolePolicy and DetachRolePolicy over '*' whose only condition is StringNotEquals iam:PermissionsBoundary = the boundary ARN"
  }
}

# AC-18: the boundary policy denies removing a permissions boundary
run "ac18_boundary_boundary_cannot_be_removed" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:DeleteRolePermissionsBoundary" || (endswith(a, "*") && startswith("iam:DeleteRolePermissionsBoundary", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on iam:DeleteRolePermissionsBoundary over '*'"
  }
}

# AC-19: the boundary policy protects the CI roles, the org role, the boundary and the OIDC provider
run "ac19_boundary_protected_iam_resources" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && toset([for v in flatten([try(s.NotAction, [])]) : tostring(v)]) == toset(["iam:Get*", "iam:List*"]) && !contains(keys(s), "Action") && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:iam::111111111111:role/fg-tf-plan", "arn:aws:iam::111111111111:role/fg-tf-apply", "arn:aws:iam::111111111111:role/OrganizationAccountAccessRole", "arn:aws:iam::111111111111:policy/fg-workload-boundary", "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny with NotAction exactly {iam:Get*, iam:List*} on exactly the tf-plan, tf-apply, OrganizationAccountAccessRole, boundary and OIDC provider ARNs"
  }
}

# AC-20: the boundary policy denies IAM users, access keys and login profiles
run "ac20_boundary_no_iam_users_or_keys" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:CreateUser" || (endswith(a, "*") && startswith("iam:CreateUser", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on iam:CreateUser over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:CreateAccessKey" || (endswith(a, "*") && startswith("iam:CreateAccessKey", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on iam:CreateAccessKey over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:CreateLoginProfile" || (endswith(a, "*") && startswith("iam:CreateLoginProfile", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on iam:CreateLoginProfile over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "iam:UpdateLoginProfile" || (endswith(a, "*") && startswith("iam:UpdateLoginProfile", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on iam:UpdateLoginProfile over '*'"
  }
}

# AC-20: the boundary policy protects the account guardrails
run "ac20_boundary_guardrails_cannot_be_changed" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "s3:PutAccountPublicAccessBlock" || (endswith(a, "*") && startswith("s3:PutAccountPublicAccessBlock", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on s3:PutAccountPublicAccessBlock over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "ec2:DisableEbsEncryptionByDefault" || (endswith(a, "*") && startswith("ec2:DisableEbsEncryptionByDefault", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on ec2:DisableEbsEncryptionByDefault over '*'"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "access-analyzer:DeleteAnalyzer" || (endswith(a, "*") && startswith("access-analyzer:DeleteAnalyzer", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && (toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) || toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:access-analyzer:eu-west-1:111111111111:analyzer/field-guide-account"])) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "the boundary policy needs an unconditional Deny on access-analyzer:DeleteAnalyzer over '*' or exactly the field-guide-account analyzer ARN"
  }
}

# AC-18: the escalation denies sit on the tf-apply role
run "ac18_apply_deny_policy_is_attached_to_the_apply_role" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.tf_apply_deny.role == "fg-tf-apply"
    error_message = "tf_apply_deny must be attached to fg-tf-apply"
  }
}

# AC-21: tf-apply cannot change bucket-level settings of the state bucket
run "ac21_apply_role_cannot_change_state_bucket_settings" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect == "Deny" && toset([for v in flatten([try(s.NotAction, [])]) : tostring(v)]) == toset(["s3:Get*", "s3:List*"]) && !contains(keys(s), "Action") && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111"]) && length(flatten([try(s.Resource, [])])) == 1 && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "tf_apply_deny needs an unconditional Deny with NotAction exactly {s3:Get*, s3:List*} on exactly the state bucket ARN (not '<bucket ARN>/*')"
  }
}

# AC-22: the boundary policy is named fg-workload-boundary
run "ac22_boundary_name" {
  command = plan

  assert {
    condition     = aws_iam_policy.boundary.name == "fg-workload-boundary"
    error_message = "aws_iam_policy.boundary.name is not 'fg-workload-boundary'"
  }
}

# AC-22: the boundary has exactly one Allow, and it is Allow * on *
run "ac22_boundary_has_one_unconditional_allow_all" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s if s.Effect == "Allow"]) == 1
    error_message = "the boundary must have exactly one Allow statement"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Allow" && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["*"]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["*"]) && length(flatten([try(s.Action, [])])) == 1 && length(flatten([try(s.Resource, [])])) == 1 && !contains(keys(s), "NotAction") && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition") && !contains(keys(s), "Principal")])
    error_message = "the boundary's Allow statement must be Action '*' on Resource '*' with no Condition"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : contains(["Allow", "Deny"], s.Effect)])
    error_message = "every boundary statement must be an Allow or a Deny"
  }
}

# AC-22: lab roles never touch the state bucket
run "ac22_boundary_denies_state_bucket_access" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Effect == "Deny" && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["s3:*"]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111", "arn:aws:s3:::field-guide-tfstate-111111111111/*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Principal")])
    error_message = "the boundary needs a Deny of s3:* on exactly the state bucket ARN and '<bucket ARN>/*'"
  }
}
