# Tests for bootstrap/management (spec 031): the organization trail and its log bucket.
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

# AC-4: the trail is an organization, multi-region trail with global events and log validation
run "ac4_trail_scope_and_integrity_flags" {
  command = plan

  assert {
    condition     = aws_cloudtrail.org.is_organization_trail == true
    error_message = "aws_cloudtrail.org.is_organization_trail must be true"
  }

  assert {
    condition     = aws_cloudtrail.org.is_multi_region_trail == true
    error_message = "aws_cloudtrail.org.is_multi_region_trail must be true"
  }

  assert {
    condition     = aws_cloudtrail.org.include_global_service_events == true
    error_message = "aws_cloudtrail.org.include_global_service_events must be true"
  }

  assert {
    condition     = aws_cloudtrail.org.enable_log_file_validation == true
    error_message = "aws_cloudtrail.org.enable_log_file_validation must be true"
  }

  assert {
    condition     = aws_cloudtrail.org.enable_logging != false
    error_message = "aws_cloudtrail.org.enable_logging must not be false"
  }
}

# AC-4: the trail has the pinned name and delivers to the pinned log bucket
run "ac4_trail_name_and_bucket" {
  command = plan

  assert {
    condition     = aws_cloudtrail.org.name == "field-guide-org-trail"
    error_message = "aws_cloudtrail.org.name is not 'field-guide-org-trail'"
  }

  assert {
    condition     = aws_cloudtrail.org.s3_bucket_name == "field-guide-org-trail-111111111111"
    error_message = "aws_cloudtrail.org.s3_bucket_name is not 'field-guide-org-trail-111111111111'"
  }
}

# AC-4: management events (read and write) are recorded: a classic event selector or the equivalent
# advanced selector (event category Management, no readOnly filter)
run "ac4_trail_records_all_management_events" {
  command = plan

  assert {
    condition = (
      anytrue([
        for e in aws_cloudtrail.org.event_selector :
        e.read_write_type == "All" && e.include_management_events == true
      ]) ||
      anytrue([
        for a in aws_cloudtrail.org.advanced_event_selector :
        anytrue([for f in a.field_selector : f.field == "eventCategory" && contains(f.equals, "Management")]) &&
        !anytrue([for f in a.field_selector : f.field == "readOnly"])
      ])
    )
    error_message = "the trail must record management events with read/write type All"
  }
}

# AC-4: no data events and no Insights
run "ac4_trail_has_no_data_events_or_insights" {
  command = plan

  assert {
    condition = alltrue([
      for e in aws_cloudtrail.org.event_selector : length(e.data_resource) == 0
    ])
    error_message = "the trail must not record data events (no data_resource)"
  }

  assert {
    condition     = length(aws_cloudtrail.org.insight_selector) == 0
    error_message = "the trail must not have insight selectors"
  }
}

# AC-4: no KMS key, CloudWatch Logs group or SNS topic
run "ac4_trail_has_no_kms_cloudwatch_or_sns" {
  command = plan

  assert {
    condition     = aws_cloudtrail.org.kms_key_id == null || aws_cloudtrail.org.kms_key_id == ""
    error_message = "the trail must not use a KMS key"
  }

  assert {
    condition     = aws_cloudtrail.org.cloud_watch_logs_group_arn == null || aws_cloudtrail.org.cloud_watch_logs_group_arn == ""
    error_message = "the trail must not send logs to CloudWatch Logs"
  }

  assert {
    condition     = aws_cloudtrail.org.sns_topic_name == null || aws_cloudtrail.org.sns_topic_name == ""
    error_message = "the trail must not publish to an SNS topic"
  }
}

# AC-5: the log bucket is named after the management account and is not force-destroyable
run "ac5_log_bucket_name_and_no_force_destroy" {
  command = plan

  assert {
    condition     = aws_s3_bucket.trail_logs.bucket == "field-guide-org-trail-111111111111"
    error_message = "aws_s3_bucket.trail_logs.bucket is not 'field-guide-org-trail-111111111111'"
  }

  assert {
    condition     = aws_s3_bucket.trail_logs.force_destroy != true
    error_message = "aws_s3_bucket.trail_logs.force_destroy must be false (or unset)"
  }
}

# AC-5: versioning is Enabled on the log bucket
run "ac5_log_bucket_versioning_enabled" {
  command = plan

  assert {
    condition     = aws_s3_bucket_versioning.trail_logs.versioning_configuration[0].status == "Enabled"
    error_message = "aws_s3_bucket_versioning.trail_logs status is not 'Enabled'"
  }
}

# AC-5: the log bucket is encrypted with SSE-S3 (AES256)
run "ac5_log_bucket_sse_aes256" {
  command = plan

  assert {
    condition = (
      length(aws_s3_bucket_server_side_encryption_configuration.trail_logs.rule) > 0 &&
      alltrue([
        for r in aws_s3_bucket_server_side_encryption_configuration.trail_logs.rule :
        alltrue([for d in r.apply_server_side_encryption_by_default : d.sse_algorithm == "AES256"])
      ])
    )
    error_message = "aws_s3_bucket_server_side_encryption_configuration.trail_logs does not use AES256"
  }
}

# AC-5: Block Public Access is fully on for the log bucket
run "ac5_log_bucket_block_public_access" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.trail_logs.block_public_acls == true
    error_message = "log bucket: block_public_acls must be true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.trail_logs.block_public_policy == true
    error_message = "log bucket: block_public_policy must be true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.trail_logs.ignore_public_acls == true
    error_message = "log bucket: ignore_public_acls must be true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.trail_logs.restrict_public_buckets == true
    error_message = "log bucket: restrict_public_buckets must be true"
  }
}

# AC-5: the log bucket enforces bucket-owner ownership (ACLs disabled)
run "ac5_log_bucket_owner_enforced" {
  command = plan

  assert {
    condition     = aws_s3_bucket_ownership_controls.trail_logs.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "aws_s3_bucket_ownership_controls.trail_logs object_ownership is not 'BucketOwnerEnforced'"
  }
}

# AC-5: current log objects expire after 365 days (in an enabled rule)
run "ac5_log_bucket_lifecycle_expires_current_after_365_days" {
  command = plan

  assert {
    condition = anytrue([
      for r in aws_s3_bucket_lifecycle_configuration.trail_logs.rule :
      r.status == "Enabled" && contains([for e in r.expiration : e.days], 365)
    ])
    error_message = "an enabled lifecycle rule must expire current objects after 365 days"
  }
}

# AC-5: noncurrent versions expire after 30 days (in an enabled rule)
run "ac5_log_bucket_lifecycle_expires_noncurrent_after_30_days" {
  command = plan

  assert {
    condition = anytrue([
      for r in aws_s3_bucket_lifecycle_configuration.trail_logs.rule :
      r.status == "Enabled" && contains([for n in r.noncurrent_version_expiration : n.noncurrent_days], 30)
    ])
    error_message = "an enabled lifecycle rule must expire noncurrent versions after 30 days"
  }
}

# AC-5: incomplete multipart uploads are aborted after 7 days (in an enabled rule)
run "ac5_log_bucket_lifecycle_aborts_multipart_after_7_days" {
  command = plan

  assert {
    condition = anytrue([
      for r in aws_s3_bucket_lifecycle_configuration.trail_logs.rule :
      r.status == "Enabled" && contains([for a in r.abort_incomplete_multipart_upload : a.days_after_initiation], 7)
    ])
    error_message = "an enabled lifecycle rule must abort incomplete multipart uploads after 7 days"
  }
}

# AC-6: GetBucketAcl is allowed only to CloudTrail, on the bucket ARN
run "ac6_log_policy_acl_check_statement" {
  command = plan

  assert {
    condition = length([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement :
      s if s.Effect == "Allow" && contains(flatten([s.Action]), "s3:GetBucketAcl")
    ]) >= 1
    error_message = "the log bucket policy must allow s3:GetBucketAcl"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement :
      toset(flatten([s.Resource])) == toset(["arn:aws:s3:::field-guide-org-trail-111111111111"]) &&
      toset(flatten([s.Action])) == toset(["s3:GetBucketAcl"]) &&
      toset(flatten([try(s.Principal.Service, "none")])) == toset(["cloudtrail.amazonaws.com"])
      if s.Effect == "Allow" && contains(flatten([s.Action]), "s3:GetBucketAcl")
    ])
    error_message = "s3:GetBucketAcl must be allowed only to cloudtrail.amazonaws.com on exactly the log bucket ARN"
  }
}

# AC-6: PutObject is allowed to CloudTrail on exactly the account and the organization prefixes
run "ac6_log_policy_put_object_resources" {
  command = plan

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement :
      flatten([s.Resource]) if s.Effect == "Allow" && contains(flatten([s.Action]), "s3:PutObject")
      ])) == toset([
      "arn:aws:s3:::field-guide-org-trail-111111111111/AWSLogs/111111111111/*",
      "arn:aws:s3:::field-guide-org-trail-111111111111/AWSLogs/o-exampleorg1/*",
    ])
    error_message = "s3:PutObject must be allowed on exactly .../AWSLogs/<account id>/* and .../AWSLogs/<organization id>/*"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement :
      toset(flatten([s.Action])) == toset(["s3:PutObject"]) &&
      toset(flatten([try(s.Principal.Service, "none")])) == toset(["cloudtrail.amazonaws.com"])
      if s.Effect == "Allow" && contains(flatten([s.Action]), "s3:PutObject")
    ])
    error_message = "s3:PutObject must be allowed only to cloudtrail.amazonaws.com"
  }
}

# AC-6: the PutObject statements require the bucket-owner-full-control ACL
run "ac6_log_policy_put_object_requires_bucket_owner_full_control" {
  command = plan

  assert {
    condition = length([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement :
      s if s.Effect == "Allow" && contains(flatten([s.Action]), "s3:PutObject")
    ]) >= 1
    error_message = "the log bucket policy must allow s3:PutObject"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement :
      try(s.Condition.StringEquals["s3:x-amz-acl"], "") == "bucket-owner-full-control"
      if s.Effect == "Allow" && contains(flatten([s.Action]), "s3:PutObject")
    ])
    error_message = "every s3:PutObject statement must require s3:x-amz-acl = bucket-owner-full-control"
  }
}

# AC-6: every Allow statement is scoped to this trail with aws:SourceArn
run "ac6_log_policy_allow_statements_scoped_to_trail_arn" {
  command = plan

  assert {
    condition = length([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement : s if s.Effect == "Allow"
    ]) >= 3
    error_message = "the log bucket policy must have the GetBucketAcl and the two PutObject Allow statements"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement :
      try(s.Condition.StringEquals["aws:SourceArn"], "") == "arn:aws:cloudtrail:eu-west-1:111111111111:trail/field-guide-org-trail"
      if s.Effect == "Allow"
    ])
    error_message = "every Allow statement must have aws:SourceArn = arn:aws:cloudtrail:eu-west-1:111111111111:trail/field-guide-org-trail"
  }
}

# AC-6: no principal other than CloudTrail is allowed anything
run "ac6_log_policy_only_cloudtrail_is_allowed" {
  command = plan

  assert {
    condition = alltrue([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement :
      toset(flatten([try(s.Principal.Service, "none")])) == toset(["cloudtrail.amazonaws.com"])
      if s.Effect == "Allow"
    ])
    error_message = "every Allow statement must have Principal Service = cloudtrail.amazonaws.com and nothing else"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement :
      toset(flatten([s.Action])) == toset(["s3:GetBucketAcl"]) || toset(flatten([s.Action])) == toset(["s3:PutObject"])
      if s.Effect == "Allow"
    ])
    error_message = "the Allow statements may only grant s3:GetBucketAcl or s3:PutObject"
  }
}

# AC-6: a TLS-only Deny, as in the state bucket policy
run "ac6_log_policy_denies_insecure_transport" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_s3_bucket_policy.trail_logs.policy).Statement :
      try(s.Principal, "none") == "*" &&
      toset(flatten([s.Action])) == toset(["s3:*"]) &&
      toset(flatten([s.Resource])) == toset([
        "arn:aws:s3:::field-guide-org-trail-111111111111",
        "arn:aws:s3:::field-guide-org-trail-111111111111/*",
      ]) &&
      tostring(try(s.Condition.Bool["aws:SecureTransport"], "")) == "false"
      if s.Effect == "Deny"
    ])
    error_message = "the log bucket policy needs a Deny of s3:* on the bucket ARN and '<ARN>/*' when aws:SecureTransport is false"
  }
}
