# Tests for bootstrap/workload (spec 032): the GitHub OIDC provider and the tf-plan / tf-apply roles.
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

# AC-13: the GitHub OIDC provider trusts only sts.amazonaws.com tokens from GitHub
run "ac13_github_oidc_provider" {
  command = plan

  assert {
    condition     = aws_iam_openid_connect_provider.github.url == "https://token.actions.githubusercontent.com"
    error_message = "the OIDC provider url is not 'https://token.actions.githubusercontent.com'"
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github.client_id_list) == 1 && toset(aws_iam_openid_connect_provider.github.client_id_list) == toset(["sts.amazonaws.com"])
    error_message = "client_id_list must be exactly ['sts.amazonaws.com']"
  }
}

# AC-14: fg-tf-plan can only be assumed through GitHub OIDC by the expected subjects
run "ac14_tf_plan_trust_policy" {
  command = plan

  assert {
    condition     = aws_iam_role.tf_plan.name == "fg-tf-plan"
    error_message = "aws_iam_role.tf_plan.name is not 'fg-tf-plan'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.tf_plan.assume_role_policy).Statement) == 1
    error_message = "the trust policy must have exactly one statement"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.tf_plan.assume_role_policy).Statement : s.Effect == "Allow" && try(s.Principal, null) == { Federated = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com" } && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["sts:AssumeRoleWithWebIdentity"]) && length(flatten([try(s.Action, [])])) == 1 && !contains(keys(s), "NotAction") && !contains(keys(s), "Resource") && !contains(keys(s), "NotResource")])
    error_message = "the trust statement must be an Allow for Principal exactly { Federated = <OIDC provider ARN> } with Action sts:AssumeRoleWithWebIdentity"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.tf_plan.assume_role_policy).Statement : toset(keys(try(s.Condition, {}))) == toset(["StringEquals"]) && toset(keys(try(s.Condition.StringEquals, {}))) == toset(["token.actions.githubusercontent.com:aud", "token.actions.githubusercontent.com:sub"])])
    error_message = "the Condition must have exactly one operator (StringEquals) with exactly the aud and sub keys"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.tf_plan.assume_role_policy).Statement : toset([for v in flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:aud"], [])]) : tostring(v)]) == toset(["sts.amazonaws.com"]) && length(flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:aud"], [])])) == 1])
    error_message = "the aud condition must be exactly 'sts.amazonaws.com'"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.tf_plan.assume_role_policy).Statement : toset([for v in flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:sub"], [])]) : tostring(v)]) == toset(["repo:example-owner@1000/example-repo@2000:pull_request", "repo:example-owner@1000/example-repo@2000:ref:refs/heads/main"]) && length(flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:sub"], [])])) == 2])
    error_message = "the sub condition must be exactly repo:example-owner@1000/example-repo@2000:pull_request and repo:example-owner@1000/example-repo@2000:ref:refs/heads/main"
  }

  assert {
    condition     = !can(regex("[*?]", aws_iam_role.tf_plan.assume_role_policy))
    error_message = "the trust policy must not contain a wildcard (* or ?) anywhere"
  }
}

# AC-15: fg-tf-apply can only be assumed through GitHub OIDC by the expected subjects
run "ac15_tf_apply_trust_policy" {
  command = plan

  assert {
    condition     = aws_iam_role.tf_apply.name == "fg-tf-apply"
    error_message = "aws_iam_role.tf_apply.name is not 'fg-tf-apply'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement) == 1
    error_message = "the trust policy must have exactly one statement"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement : s.Effect == "Allow" && try(s.Principal, null) == { Federated = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com" } && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["sts:AssumeRoleWithWebIdentity"]) && length(flatten([try(s.Action, [])])) == 1 && !contains(keys(s), "NotAction") && !contains(keys(s), "Resource") && !contains(keys(s), "NotResource")])
    error_message = "the trust statement must be an Allow for Principal exactly { Federated = <OIDC provider ARN> } with Action sts:AssumeRoleWithWebIdentity"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement : toset(keys(try(s.Condition, {}))) == toset(["StringEquals"]) && toset(keys(try(s.Condition.StringEquals, {}))) == toset(["token.actions.githubusercontent.com:aud", "token.actions.githubusercontent.com:sub"])])
    error_message = "the Condition must have exactly one operator (StringEquals) with exactly the aud and sub keys"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement : toset([for v in flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:aud"], [])]) : tostring(v)]) == toset(["sts.amazonaws.com"]) && length(flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:aud"], [])])) == 1])
    error_message = "the aud condition must be exactly 'sts.amazonaws.com'"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement : toset([for v in flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:sub"], [])]) : tostring(v)]) == toset(["repo:example-owner@1000/example-repo@2000:environment:infra"]) && length(flatten([try(s.Condition.StringEquals["token.actions.githubusercontent.com:sub"], [])])) == 1])
    error_message = "the sub condition must be exactly repo:example-owner@1000/example-repo@2000:environment:infra"
  }

  assert {
    condition     = !can(regex("[*?]", aws_iam_role.tf_apply.assume_role_policy))
    error_message = "the trust policy must not contain a wildcard (* or ?) anywhere"
  }
}

# AC-16: each role gets exactly one AWS managed policy
run "ac16_managed_policy_attachments" {
  command = plan

  assert {
    condition     = aws_iam_role_policy_attachment.tf_plan_read_only.policy_arn == "arn:aws:iam::aws:policy/ReadOnlyAccess"
    error_message = "tf_plan_read_only must attach arn:aws:iam::aws:policy/ReadOnlyAccess"
  }

  assert {
    condition     = aws_iam_role_policy_attachment.tf_plan_read_only.role == "fg-tf-plan"
    error_message = "tf_plan_read_only must be attached to fg-tf-plan"
  }

  assert {
    condition     = aws_iam_role_policy_attachment.tf_apply_admin.policy_arn == "arn:aws:iam::aws:policy/AdministratorAccess"
    error_message = "tf_apply_admin must attach arn:aws:iam::aws:policy/AdministratorAccess"
  }

  assert {
    condition     = aws_iam_role_policy_attachment.tf_apply_admin.role == "fg-tf-apply"
    error_message = "tf_apply_admin must be attached to fg-tf-apply"
  }
}

# AC-16: the inline policies only deny
run "ac16_inline_policies_never_allow" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s.Effect != "Allow"])
    error_message = "the tf_plan_deny inline policy must have statements and no Allow"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement) > 0 && alltrue([for s in jsondecode(aws_iam_role_policy.tf_apply_deny.policy).Statement : s.Effect != "Allow"])
    error_message = "the tf_apply_deny inline policy must have statements and no Allow"
  }
}

# AC-17: tf-plan cannot read state objects outside labs/*
run "ac17_tf_plan_denies_object_reads_outside_labs" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.tf_plan_deny.role == "fg-tf-plan"
    error_message = "tf_plan_deny must be attached to fg-tf-plan"
  }

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "s3:GetObject" || (endswith(a, "*") && startswith("s3:GetObject", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "s3:GetObjectVersion" || (endswith(a, "*") && startswith("s3:GetObjectVersion", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.NotResource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111/labs/*"]) && !contains(keys(s), "Resource") && !contains(keys(s), "Condition")])
    error_message = "tf_plan_deny needs an unconditional Deny on s3:GetObject and s3:GetObjectVersion with NotResource exactly '<bucket ARN>/labs/*'"
  }
}

# AC-17: tf-plan cannot read secret values
run "ac17_tf_plan_denies_secret_reads" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "secretsmanager:GetSecretValue" || (endswith(a, "*") && startswith("secretsmanager:GetSecretValue", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:secretsmanager:*:111111111111:secret:*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "tf_plan_deny needs an unconditional Deny on secretsmanager:GetSecretValue over exactly 'arn:aws:secretsmanager:*:<account>:secret:*'"
  }
}

# AC-17: tf-plan cannot read the account's own parameters
run "ac17_tf_plan_denies_parameter_reads" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.tf_plan_deny.policy).Statement : s.Effect == "Deny" && anytrue([for a in flatten([try(s.Action, [])]) : a == "ssm:GetParameter" || (endswith(a, "*") && startswith("ssm:GetParameter", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "ssm:GetParameters" || (endswith(a, "*") && startswith("ssm:GetParameters", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "ssm:GetParametersByPath" || (endswith(a, "*") && startswith("ssm:GetParametersByPath", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "ssm:GetParameterHistory" || (endswith(a, "*") && startswith("ssm:GetParameterHistory", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:ssm:*:111111111111:parameter/*"]) && !contains(keys(s), "NotResource") && !contains(keys(s), "Condition")])
    error_message = "tf_plan_deny needs an unconditional Deny on ssm:GetParameter, GetParameters, GetParametersByPath and GetParameterHistory over exactly 'arn:aws:ssm:*:<account>:parameter/*'"
  }
}
