# Tests for bootstrap/workload (spec 032): the Terraform state bucket, its lifecycle and its policy.
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

# AC-1: the state bucket is named after the account and cannot be force-destroyed
run "ac1_bucket_name_and_no_force_destroy" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "field-guide-tfstate-111111111111"
    error_message = "aws_s3_bucket.state.bucket is not 'field-guide-tfstate-111111111111'"
  }

  assert {
    condition     = aws_s3_bucket.state.force_destroy != true
    error_message = "aws_s3_bucket.state.force_destroy must be false (or unset)"
  }
}

# AC-1: versioning is Enabled
run "ac1_versioning_enabled" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_versioning.state.versioning_configuration) == 1 && aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "aws_s3_bucket_versioning.state status is not 'Enabled'"
  }
}

# AC-1: the bucket is encrypted with SSE-S3 (AES256)
run "ac1_sse_aes256" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_server_side_encryption_configuration.state.rule) > 0 && alltrue([for r in aws_s3_bucket_server_side_encryption_configuration.state.rule : length(r.apply_server_side_encryption_by_default) == 1 && alltrue([for d in r.apply_server_side_encryption_by_default : d.sse_algorithm == "AES256"])])
    error_message = "aws_s3_bucket_server_side_encryption_configuration.state does not use AES256"
  }
}

# AC-1: Block Public Access is fully on for the state bucket
run "ac1_block_public_access" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.state.block_public_acls == true
    error_message = "state bucket: block_public_acls must be true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.state.block_public_policy == true
    error_message = "state bucket: block_public_policy must be true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.state.ignore_public_acls == true
    error_message = "state bucket: ignore_public_acls must be true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.state.restrict_public_buckets == true
    error_message = "state bucket: restrict_public_buckets must be true"
  }
}

# AC-1: ACLs are disabled (BucketOwnerEnforced)
run "ac1_owner_enforced" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_ownership_controls.state.rule) == 1 && aws_s3_bucket_ownership_controls.state.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "aws_s3_bucket_ownership_controls.state object_ownership is not 'BucketOwnerEnforced'"
  }
}

# AC-2: exactly one lifecycle rule and it is enabled
run "ac2_single_enabled_rule" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.state.rule) == 1
    error_message = "the state bucket lifecycle must have exactly one rule"
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_lifecycle_configuration.state.rule : r.status == "Enabled"])
    error_message = "the lifecycle rule status is not 'Enabled'"
  }
}

# AC-2: noncurrent versions expire after 90 days
run "ac2_noncurrent_versions_expire_after_90_days" {
  command = plan

  assert {
    condition     = alltrue([for r in aws_s3_bucket_lifecycle_configuration.state.rule : length(r.noncurrent_version_expiration) == 1 && alltrue([for n in r.noncurrent_version_expiration : n.noncurrent_days == 90])])
    error_message = "noncurrent versions must expire after exactly 90 days"
  }
}

# AC-2: incomplete multipart uploads are aborted after 7 days
run "ac2_incomplete_multipart_aborted_after_7_days" {
  command = plan

  assert {
    condition     = alltrue([for r in aws_s3_bucket_lifecycle_configuration.state.rule : length(r.abort_incomplete_multipart_upload) == 1 && alltrue([for a in r.abort_incomplete_multipart_upload : a.days_after_initiation == 7])])
    error_message = "incomplete multipart uploads must be aborted after exactly 7 days"
  }
}

# AC-2: current objects never expire
run "ac2_current_objects_never_expire" {
  command = plan

  assert {
    condition     = alltrue([for r in aws_s3_bucket_lifecycle_configuration.state.rule : alltrue([for e in r.expiration : try(e.days, 0) == 0 && try(e.date, null) == null])])
    error_message = "the lifecycle rule must not expire current objects (no expiration days or date)"
  }
}

# AC-3: a Deny for everyone on s3:* over the bucket and its objects unless TLS
run "ac3_tls_only_deny" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s.Effect == "Deny" && try(s.Principal, null) == "*" && toset([for v in flatten([try(s.Action, [])]) : tostring(v)]) == toset(["s3:*"]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111", "arn:aws:s3:::field-guide-tfstate-111111111111/*"]) && !contains(keys(s), "NotResource") && toset(keys(try(s.Condition, {}))) == toset(["Bool"]) && toset(keys(try(s.Condition["Bool"], {}))) == toset(["aws:SecureTransport"]) && toset([for v in flatten([try(s.Condition["Bool"]["aws:SecureTransport"], [])]) : tostring(v)]) == toset(["false"])])
    error_message = "the bucket policy needs a Deny for Principal '*', s3:*, on exactly the bucket ARN and '<bucket ARN>/*', with the only condition Bool aws:SecureTransport = 'false'"
  }
}

# AC-3: the bucket policy has no Allow statement
run "ac3_no_allow_statement" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_s3_bucket_policy.state.policy).Statement) > 0
    error_message = "the bucket policy must have statements"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s.Effect != "Allow"])
    error_message = "the bucket policy must not have an Allow statement"
  }
}

# AC-4: bootstrap/* is denied to everyone who is not an IAM Identity Center role
run "ac4_bootstrap_keys_only_for_sso_roles" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s.Effect == "Deny" && try(s.Principal, null) == "*" && (contains(flatten([try(s.Action, [])]), "s3:*") || (anytrue([for a in flatten([try(s.Action, [])]) : a == "s3:GetObject" || (endswith(a, "*") && startswith("s3:GetObject", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "s3:PutObject" || (endswith(a, "*") && startswith("s3:PutObject", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "s3:DeleteObject" || (endswith(a, "*") && startswith("s3:DeleteObject", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]))) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111/bootstrap/*"]) && !contains(keys(s), "NotResource") && toset(keys(try(s.Condition, {}))) == toset(["ArnNotLike"]) && toset(keys(try(s.Condition["ArnNotLike"], {}))) == toset(["aws:PrincipalArn"]) && toset([for v in flatten([try(s.Condition["ArnNotLike"]["aws:PrincipalArn"], [])]) : tostring(v)]) == toset(["arn:aws:iam::111111111111:role/aws-reserved/sso.amazonaws.com/*"])])
    error_message = "the bucket policy needs a Deny for Principal '*' on s3:* (or Get/Put/DeleteObject) over exactly '<bucket ARN>/bootstrap/*' whose only condition is ArnNotLike aws:PrincipalArn = the SSO role path"
  }
}

# AC-5: the CI roles are denied object access outside labs/*
run "ac5_ci_roles_confined_to_labs_keys" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s.Effect == "Deny" && try(s.Principal, null) == "*" && anytrue([for a in flatten([try(s.Action, [])]) : a == "s3:GetObject" || (endswith(a, "*") && startswith("s3:GetObject", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "s3:PutObject" || (endswith(a, "*") && startswith("s3:PutObject", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "s3:DeleteObject" || (endswith(a, "*") && startswith("s3:DeleteObject", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.NotResource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111/labs/*"]) && !contains(keys(s), "Resource") && toset(keys(try(s.Condition, {}))) == toset(["ArnEquals"]) && toset(keys(try(s.Condition["ArnEquals"], {}))) == toset(["aws:PrincipalArn"]) && toset([for v in flatten([try(s.Condition["ArnEquals"]["aws:PrincipalArn"], [])]) : tostring(v)]) == toset(["arn:aws:iam::111111111111:role/fg-tf-plan", "arn:aws:iam::111111111111:role/fg-tf-apply"])])
    error_message = "the bucket policy needs a Deny for Principal '*' on Get/Put/DeleteObject with NotResource exactly '<bucket ARN>/labs/*' (and no Resource), conditioned ArnEquals aws:PrincipalArn on exactly the tf-plan and tf-apply role ARNs"
  }
}

# AC-6: the tf-plan role cannot write or delete any object (state or lock files)
run "ac6_plan_role_cannot_write_state" {
  command = plan

  assert {
    condition     = anytrue([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s.Effect == "Deny" && try(s.Principal, null) == "*" && anytrue([for a in flatten([try(s.Action, [])]) : a == "s3:PutObject" || (endswith(a, "*") && startswith("s3:PutObject", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && anytrue([for a in flatten([try(s.Action, [])]) : a == "s3:DeleteObject" || (endswith(a, "*") && startswith("s3:DeleteObject", trimsuffix(a, "*")) && !endswith(a, ":*") && a != "*")]) && toset([for v in flatten([try(s.Resource, [])]) : tostring(v)]) == toset(["arn:aws:s3:::field-guide-tfstate-111111111111/*"]) && !contains(keys(s), "NotResource") && toset(keys(try(s.Condition, {}))) == toset(["ArnEquals"]) && toset(keys(try(s.Condition["ArnEquals"], {}))) == toset(["aws:PrincipalArn"]) && toset([for v in flatten([try(s.Condition["ArnEquals"]["aws:PrincipalArn"], [])]) : tostring(v)]) == toset(["arn:aws:iam::111111111111:role/fg-tf-plan"])])
    error_message = "the bucket policy needs a Deny for Principal '*' on PutObject and DeleteObject over '<bucket ARN>/*' conditioned ArnEquals aws:PrincipalArn on exactly the tf-plan role ARN"
  }
}
