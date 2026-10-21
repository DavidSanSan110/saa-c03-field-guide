# Tests for labs/00-site-hosting (spec 035): the stack without a custom domain: the site bucket, the
# log bucket, standard logs v2 and the no-domain variant (AC-17 to AC-23, AC-35, AC-40).
# All runs use command = plan with mock providers, so nothing touches AWS.
#
# The distribution values only exist after creation, so they are overridden during plan. Nothing
# else is overridden: the log bucket policy and the bucket names are built from names and the
# (mocked) account ID, so they must be known at plan time.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

override_resource {
  target          = aws_cloudfront_distribution.site
  override_during = plan
  values = {
    arn            = "arn:aws:cloudfront::111111111111:distribution/E2EXAMPLE12345"
    domain_name    = "d111111abcdef8.cloudfront.net"
    hosted_zone_id = "Z0123456789EXAMPLE"
    id             = "E2EXAMPLE12345"
  }
}

override_resource {
  target          = aws_cloudwatch_log_delivery_destination.site
  override_during = plan
  values = {
    arn = "arn:aws:logs:us-east-1:111111111111:delivery-destination:fg-site-access-logs-s3"
  }
}

variables {
  github_sub_prefix = "repo:your-user/saa-c03-field-guide"
}

# ---- site bucket ------------------------------------------------------------------------------------

# AC-17: the site bucket is named after the account and can be force-destroyed
run "ac17_site_bucket_name_and_force_destroy" {
  command = plan

  assert {
    condition     = aws_s3_bucket.site.bucket == "field-guide-site-111111111111"
    error_message = "aws_s3_bucket.site.bucket is not 'field-guide-site-111111111111'"
  }

  assert {
    condition     = aws_s3_bucket.site.force_destroy == true
    error_message = "aws_s3_bucket.site.force_destroy must be true"
  }
}

# AC-17: ACLs are disabled (BucketOwnerEnforced)
run "ac17_site_bucket_owner_enforced" {
  command = plan

  assert {
    condition     = [for r in aws_s3_bucket_ownership_controls.site.rule : r.object_ownership] == ["BucketOwnerEnforced"]
    error_message = "the site bucket ownership rule is not exactly BucketOwnerEnforced"
  }
}

# AC-17: Block Public Access is fully on
run "ac17_site_bucket_block_public_access" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.site.block_public_acls == true
    error_message = "site bucket: block_public_acls must be true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.site.block_public_policy == true
    error_message = "site bucket: block_public_policy must be true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.site.ignore_public_acls == true
    error_message = "site bucket: ignore_public_acls must be true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.site.restrict_public_buckets == true
    error_message = "site bucket: restrict_public_buckets must be true"
  }
}

# AC-17: SSE-S3 (AES256) and versioning Enabled
run "ac17_site_bucket_encryption_and_versioning" {
  command = plan

  assert {
    condition     = flatten([for r in aws_s3_bucket_server_side_encryption_configuration.site.rule : [for d in r.apply_server_side_encryption_by_default : d.sse_algorithm]]) == ["AES256"]
    error_message = "the site bucket must be encrypted with exactly AES256"
  }

  assert {
    condition     = [for v in aws_s3_bucket_versioning.site.versioning_configuration : v.status] == ["Enabled"]
    error_message = "aws_s3_bucket_versioning.site status is not 'Enabled'"
  }
}

# AC-18: one enabled rule; noncurrent versions expire after 30 days, multipart uploads are aborted
# after 7 days and expired delete markers are removed. (The empty filter and the absence of a days
# expiration for current objects are checked on the HCL text by lab-00-site-hosting.test.ts.)
run "ac18_site_lifecycle" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.site.rule) == 1
    error_message = "the site bucket lifecycle must have exactly one rule"
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_lifecycle_configuration.site.rule : r.status == "Enabled"])
    error_message = "the site bucket lifecycle rule must be Enabled"
  }

  assert {
    condition     = [for r in aws_s3_bucket_lifecycle_configuration.site.rule : [for n in r.noncurrent_version_expiration : n.noncurrent_days]] == [[30]]
    error_message = "noncurrent versions must expire after exactly 30 days"
  }

  assert {
    condition     = [for r in aws_s3_bucket_lifecycle_configuration.site.rule : [for a in r.abort_incomplete_multipart_upload : a.days_after_initiation]] == [[7]]
    error_message = "incomplete multipart uploads must be aborted after exactly 7 days"
  }

  assert {
    condition     = [for r in aws_s3_bucket_lifecycle_configuration.site.rule : [for e in r.expiration : e.expired_object_delete_marker]] == [[true]]
    error_message = "expired object delete markers must be removed (expiration.expired_object_delete_marker = true)"
  }
}

# AC-19: the site bucket policy has exactly two statements
run "ac19_site_policy_has_two_statements" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_s3_bucket_policy.site.policy).Statement) == 2
    error_message = "the site bucket policy must have exactly two statements"
  }

  assert {
    condition     = toset([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : s.Sid]) == toset(["AllowCloudFrontRead", "DenyInsecureTransport"])
    error_message = "the site bucket policy statements must be AllowCloudFrontRead and DenyInsecureTransport"
  }
}

# AC-19: CloudFront may only read objects, and only for this distribution
run "ac19_site_policy_allow_cloudfront_read" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : s if s.Sid == "AllowCloudFrontRead"]) == 1
    error_message = "there must be exactly one AllowCloudFrontRead statement"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : s.Effect == "Allow" && keys(s.Principal) == ["Service"] && flatten([s.Principal.Service]) == ["cloudfront.amazonaws.com"] if s.Sid == "AllowCloudFrontRead"])
    error_message = "AllowCloudFrontRead must be an Allow for exactly the principal { Service = cloudfront.amazonaws.com }"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : flatten([s.Action]) == ["s3:GetObject"] && flatten([s.Resource]) == ["arn:aws:s3:::field-guide-site-111111111111/*"] if s.Sid == "AllowCloudFrontRead"])
    error_message = "AllowCloudFrontRead must allow exactly s3:GetObject on <site bucket ARN>/*"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : keys(s.Condition) == ["StringEquals"] && keys(s.Condition.StringEquals) == ["AWS:SourceArn"] && flatten([s.Condition.StringEquals["AWS:SourceArn"]]) == [aws_cloudfront_distribution.site.arn] if s.Sid == "AllowCloudFrontRead"])
    error_message = "AllowCloudFrontRead must have exactly the condition StringEquals AWS:SourceArn = the distribution ARN"
  }
}

# AC-19: plain HTTP is denied on the bucket and its objects
run "ac19_site_policy_deny_insecure_transport" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : s if s.Sid == "DenyInsecureTransport"]) == 1
    error_message = "there must be exactly one DenyInsecureTransport statement"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : s.Effect == "Deny" && s.Principal == "*" && flatten([s.Action]) == ["s3:*"] if s.Sid == "DenyInsecureTransport"])
    error_message = "DenyInsecureTransport must be a Deny for Principal '*' on s3:*"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : toset(flatten([s.Resource])) == toset(["arn:aws:s3:::field-guide-site-111111111111", "arn:aws:s3:::field-guide-site-111111111111/*"]) if s.Sid == "DenyInsecureTransport"])
    error_message = "DenyInsecureTransport must cover the bucket and its objects"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : keys(s.Condition) == ["Bool"] && tostring(s.Condition.Bool["aws:SecureTransport"]) == "false" if s.Sid == "DenyInsecureTransport"])
    error_message = "DenyInsecureTransport must have exactly the condition Bool aws:SecureTransport = false"
  }
}

# AC-19: nothing lists the bucket and nothing is allowed for everyone
run "ac19_site_policy_no_list_and_no_public_allow" {
  command = plan

  assert {
    condition     = !contains(flatten([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : flatten([s.Action])]), "s3:ListBucket")
    error_message = "no statement of the site bucket policy may grant s3:ListBucket"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : !(s.Effect == "Allow" && try(contains(flatten(values(s.Principal)), "*"), false)) && !(s.Effect == "Allow" && s.Principal == "*")])
    error_message = "no Allow statement of the site bucket policy may have Principal '*'"
  }
}

# ---- log bucket -------------------------------------------------------------------------------------

# AC-20: the log bucket is named after the account and can be force-destroyed
run "ac20_log_bucket_name_and_force_destroy" {
  command = plan

  assert {
    condition     = aws_s3_bucket.logs.bucket == "field-guide-site-logs-111111111111"
    error_message = "aws_s3_bucket.logs.bucket is not 'field-guide-site-logs-111111111111'"
  }

  assert {
    condition     = aws_s3_bucket.logs.force_destroy == true
    error_message = "aws_s3_bucket.logs.force_destroy must be true"
  }
}

# AC-20: ACLs are disabled, public access is blocked, SSE-S3
run "ac20_log_bucket_hardening" {
  command = plan

  assert {
    condition     = [for r in aws_s3_bucket_ownership_controls.logs.rule : r.object_ownership] == ["BucketOwnerEnforced"]
    error_message = "the log bucket ownership rule is not exactly BucketOwnerEnforced"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.logs.block_public_acls == true && aws_s3_bucket_public_access_block.logs.block_public_policy == true && aws_s3_bucket_public_access_block.logs.ignore_public_acls == true && aws_s3_bucket_public_access_block.logs.restrict_public_buckets == true
    error_message = "the log bucket must have all four Block Public Access settings on"
  }

  assert {
    condition     = flatten([for r in aws_s3_bucket_server_side_encryption_configuration.logs.rule : [for d in r.apply_server_side_encryption_by_default : d.sse_algorithm]]) == ["AES256"]
    error_message = "the log bucket must be encrypted with exactly AES256"
  }
}

# AC-21: one enabled rule; current objects expire after 30 days, multipart uploads are aborted after 7
run "ac21_log_lifecycle" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.logs.rule) == 1
    error_message = "the log bucket lifecycle must have exactly one rule"
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_lifecycle_configuration.logs.rule : r.status == "Enabled"])
    error_message = "the log bucket lifecycle rule must be Enabled"
  }

  assert {
    condition     = [for r in aws_s3_bucket_lifecycle_configuration.logs.rule : [for e in r.expiration : e.days]] == [[30]]
    error_message = "log objects must expire after exactly 30 days"
  }

  assert {
    condition     = [for r in aws_s3_bucket_lifecycle_configuration.logs.rule : [for a in r.abort_incomplete_multipart_upload : a.days_after_initiation]] == [[7]]
    error_message = "incomplete multipart uploads must be aborted after exactly 7 days"
  }
}

# AC-22: exactly three statements: the two AWS statements and the TLS deny
run "ac22_log_policy_has_three_statements" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_s3_bucket_policy.logs.policy).Statement) == 3
    error_message = "the log bucket policy must have exactly three statements"
  }

  assert {
    condition     = toset([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s.Sid]) == toset(["AWSLogDeliveryWrite", "AWSLogDeliveryAclCheck", "DenyInsecureTransport"])
    error_message = "the log bucket policy statements must be AWSLogDeliveryWrite, AWSLogDeliveryAclCheck and DenyInsecureTransport"
  }
}

# AC-22: AWSLogDeliveryWrite
run "ac22_log_policy_delivery_write" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s if s.Sid == "AWSLogDeliveryWrite"]) == 1
    error_message = "there must be exactly one AWSLogDeliveryWrite statement"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s.Effect == "Allow" && keys(s.Principal) == ["Service"] && flatten([s.Principal.Service]) == ["delivery.logs.amazonaws.com"] if s.Sid == "AWSLogDeliveryWrite"])
    error_message = "AWSLogDeliveryWrite must be an Allow for exactly { Service = delivery.logs.amazonaws.com }"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : flatten([s.Action]) == ["s3:PutObject"] && flatten([s.Resource]) == ["arn:aws:s3:::field-guide-site-logs-111111111111/AWSLogs/111111111111/*"] if s.Sid == "AWSLogDeliveryWrite"])
    error_message = "AWSLogDeliveryWrite must allow exactly s3:PutObject on <log bucket ARN>/AWSLogs/<account_id>/*"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : toset(keys(s.Condition)) == toset(["StringEquals", "ArnLike"]) && toset(keys(s.Condition.StringEquals)) == toset(["s3:x-amz-acl", "aws:SourceAccount"]) && flatten([s.Condition.StringEquals["s3:x-amz-acl"]]) == ["bucket-owner-full-control"] && flatten([s.Condition.StringEquals["aws:SourceAccount"]]) == ["111111111111"] if s.Sid == "AWSLogDeliveryWrite"])
    error_message = "AWSLogDeliveryWrite must have StringEquals s3:x-amz-acl = bucket-owner-full-control and aws:SourceAccount = [<account_id>]"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : keys(s.Condition.ArnLike) == ["aws:SourceArn"] && flatten([s.Condition.ArnLike["aws:SourceArn"]]) == ["arn:aws:logs:us-east-1:111111111111:delivery-source:*"] if s.Sid == "AWSLogDeliveryWrite"])
    error_message = "AWSLogDeliveryWrite must have ArnLike aws:SourceArn = [arn:aws:logs:us-east-1:<account_id>:delivery-source:*]"
  }
}

# AC-22: AWSLogDeliveryAclCheck
run "ac22_log_policy_acl_check" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s if s.Sid == "AWSLogDeliveryAclCheck"]) == 1
    error_message = "there must be exactly one AWSLogDeliveryAclCheck statement"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s.Effect == "Allow" && keys(s.Principal) == ["Service"] && flatten([s.Principal.Service]) == ["delivery.logs.amazonaws.com"] if s.Sid == "AWSLogDeliveryAclCheck"])
    error_message = "AWSLogDeliveryAclCheck must be an Allow for exactly { Service = delivery.logs.amazonaws.com }"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : toset(flatten([s.Action])) == toset(["s3:GetBucketAcl", "s3:ListBucket"]) && flatten([s.Resource]) == ["arn:aws:s3:::field-guide-site-logs-111111111111"] if s.Sid == "AWSLogDeliveryAclCheck"])
    error_message = "AWSLogDeliveryAclCheck must allow exactly s3:GetBucketAcl and s3:ListBucket on the log bucket ARN"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : toset(keys(s.Condition)) == toset(["StringEquals", "ArnLike"]) && keys(s.Condition.StringEquals) == ["aws:SourceAccount"] && flatten([s.Condition.StringEquals["aws:SourceAccount"]]) == ["111111111111"] && keys(s.Condition.ArnLike) == ["aws:SourceArn"] && flatten([s.Condition.ArnLike["aws:SourceArn"]]) == ["arn:aws:logs:us-east-1:111111111111:delivery-source:*"] if s.Sid == "AWSLogDeliveryAclCheck"])
    error_message = "AWSLogDeliveryAclCheck must have exactly the aws:SourceAccount and aws:SourceArn conditions"
  }
}

# AC-22: the TLS deny, and nobody else is allowed anything
run "ac22_log_policy_deny_insecure_transport_and_no_other_principal" {
  command = plan

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s if s.Sid == "DenyInsecureTransport"]) == 1
    error_message = "there must be exactly one DenyInsecureTransport statement"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s.Effect == "Deny" && s.Principal == "*" && flatten([s.Action]) == ["s3:*"] && toset(flatten([s.Resource])) == toset(["arn:aws:s3:::field-guide-site-logs-111111111111", "arn:aws:s3:::field-guide-site-logs-111111111111/*"]) && keys(s.Condition) == ["Bool"] && tostring(s.Condition.Bool["aws:SecureTransport"]) == "false" if s.Sid == "DenyInsecureTransport"])
    error_message = "DenyInsecureTransport must deny s3:* for '*' on the log bucket and its objects when aws:SecureTransport is false"
  }

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s if s.Effect == "Allow"]) == 2
    error_message = "the log bucket policy must have exactly two Allow statements"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s.Effect == "Deny" || try(flatten([s.Principal.Service]) == ["delivery.logs.amazonaws.com"] && keys(s.Principal) == ["Service"], false)])
    error_message = "the only principal allowed anything in the log bucket policy is delivery.logs.amazonaws.com"
  }
}

# ---- standard logs v2 (us-east-1) -------------------------------------------------------------------

# AC-23: delivery source, destination and delivery (the us_east_1 provider and the dependency on the
# log bucket policy are checked on the HCL text by lab-00-site-hosting.test.ts). The log bucket ARN
# is overridden here only.
run "ac23_logs_v2_delivery" {
  command = plan

  override_resource {
    target          = aws_s3_bucket.logs
    override_during = plan
    values = {
      arn = "arn:aws:s3:::field-guide-site-logs-111111111111"
    }
  }

  assert {
    condition     = aws_cloudwatch_log_delivery_source.site.name == "fg-site-access-logs"
    error_message = "the delivery source name is not 'fg-site-access-logs'"
  }

  assert {
    condition     = aws_cloudwatch_log_delivery_source.site.log_type == "ACCESS_LOGS"
    error_message = "the delivery source log_type is not 'ACCESS_LOGS'"
  }

  assert {
    condition     = aws_cloudwatch_log_delivery_source.site.resource_arn == aws_cloudfront_distribution.site.arn
    error_message = "the delivery source resource_arn is not the distribution ARN"
  }

  assert {
    condition     = aws_cloudwatch_log_delivery_destination.site.name == "fg-site-access-logs-s3"
    error_message = "the delivery destination name is not 'fg-site-access-logs-s3'"
  }

  assert {
    condition     = aws_cloudwatch_log_delivery_destination.site.output_format == "json"
    error_message = "the delivery destination output_format is not 'json'"
  }

  assert {
    condition     = [for c in aws_cloudwatch_log_delivery_destination.site.delivery_destination_configuration : c.destination_resource_arn] == ["arn:aws:s3:::field-guide-site-logs-111111111111"]
    error_message = "the delivery destination must point at the log bucket ARN"
  }

  assert {
    condition     = aws_cloudwatch_log_delivery.site.delivery_source_name == aws_cloudwatch_log_delivery_source.site.name
    error_message = "the delivery must link the delivery source by name"
  }

  assert {
    condition     = aws_cloudwatch_log_delivery.site.delivery_destination_arn == aws_cloudwatch_log_delivery_destination.site.arn
    error_message = "the delivery must link the delivery destination by ARN"
  }
}

# ---- no custom domain -------------------------------------------------------------------------------

# AC-35: no certificate, validation, validation records or A/AAAA records
run "ac35_no_domain_creates_no_domain_resources" {
  command = plan

  assert {
    condition     = length(aws_acm_certificate.site) == 0
    error_message = "no aws_acm_certificate.site without a domain"
  }

  assert {
    condition     = length(aws_acm_certificate_validation.site) == 0
    error_message = "no aws_acm_certificate_validation.site without a domain"
  }

  assert {
    condition     = length(aws_route53_record.cert_validation) == 0
    error_message = "no aws_route53_record.cert_validation without a domain"
  }

  assert {
    condition     = length(aws_route53_record.site_a) == 0 && length(aws_route53_record.site_aaaa) == 0
    error_message = "no A or AAAA records without a domain"
  }
}

# AC-35: no aliases, the default certificate and TLSv1
run "ac35_no_domain_distribution_uses_the_default_certificate" {
  command = plan

  assert {
    condition     = try(length(aws_cloudfront_distribution.site.aliases), 0) == 0
    error_message = "the distribution must have no aliases without a domain"
  }

  assert {
    condition     = [for v in aws_cloudfront_distribution.site.viewer_certificate : v.cloudfront_default_certificate] == [true]
    error_message = "viewer_certificate.cloudfront_default_certificate must be true without a domain"
  }

  assert {
    condition     = [for v in aws_cloudfront_distribution.site.viewer_certificate : v.minimum_protocol_version] == ["TLSv1"]
    error_message = "viewer_certificate.minimum_protocol_version must be 'TLSv1' without a domain"
  }
}

# AC-35, AC-40: site_url is https:// plus the distribution domain; the other outputs
run "ac40_outputs_without_a_domain" {
  command = plan

  assert {
    condition     = output.site_url == "https://d111111abcdef8.cloudfront.net"
    error_message = "output site_url must be https:// plus the distribution domain name without a domain"
  }

  assert {
    condition     = output.site_bucket_name == "field-guide-site-111111111111"
    error_message = "output site_bucket_name is not 'field-guide-site-111111111111'"
  }

  assert {
    condition     = output.log_bucket_name == "field-guide-site-logs-111111111111"
    error_message = "output log_bucket_name is not 'field-guide-site-logs-111111111111'"
  }

  assert {
    condition     = output.distribution_id == "E2EXAMPLE12345"
    error_message = "output distribution_id is not the distribution id"
  }

  assert {
    condition     = output.distribution_domain_name == "d111111abcdef8.cloudfront.net"
    error_message = "output distribution_domain_name is not the distribution domain name"
  }
}
