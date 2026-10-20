# Tests for bootstrap/workload (spec 032): account guardrails and the optional Route 53 hosted zone.
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

# AC-7: account-level S3 Block Public Access is fully on
run "ac7_account_block_public_access" {
  command = plan

  assert {
    condition     = aws_s3_account_public_access_block.this.block_public_acls == true
    error_message = "account: block_public_acls must be true"
  }

  assert {
    condition     = aws_s3_account_public_access_block.this.block_public_policy == true
    error_message = "account: block_public_policy must be true"
  }

  assert {
    condition     = aws_s3_account_public_access_block.this.ignore_public_acls == true
    error_message = "account: ignore_public_acls must be true"
  }

  assert {
    condition     = aws_s3_account_public_access_block.this.restrict_public_buckets == true
    error_message = "account: restrict_public_buckets must be true"
  }
}

# AC-8: an account-level (external access) Access Analyzer
run "ac8_access_analyzer" {
  command = plan

  assert {
    condition     = aws_accessanalyzer_analyzer.account.analyzer_name == "field-guide-account"
    error_message = "analyzer_name is not 'field-guide-account'"
  }

  assert {
    condition     = aws_accessanalyzer_analyzer.account.type == "ACCOUNT"
    error_message = "the analyzer type is not 'ACCOUNT'"
  }
}

# AC-9: EBS encryption by default is on
run "ac9_ebs_encryption_by_default" {
  command = plan

  assert {
    condition     = aws_ebs_encryption_by_default.this.enabled == true
    error_message = "aws_ebs_encryption_by_default.this.enabled must be true"
  }
}

# AC-10: no hosted zone when hosted_zone_name is unset
run "ac10_zone_off_by_default" {
  command = plan

  assert {
    condition     = length(aws_route53_zone.site) == 0
    error_message = "aws_route53_zone.site must have no instance when hosted_zone_name is unset"
  }

  assert {
    condition     = length(output.name_servers) == 0
    error_message = "output name_servers must be an empty list without a zone"
  }

  assert {
    condition     = output.hosted_zone_id == null
    error_message = "output hosted_zone_id must be null without a zone"
  }
}

# AC-11: with a hosted_zone_name there is one public zone
run "ac11_zone_on_is_public_and_not_force_destroyable" {
  command = plan

  variables {
    hosted_zone_name = "field-guide.example.com"
  }

  assert {
    condition     = length(aws_route53_zone.site) == 1
    error_message = "aws_route53_zone.site must have exactly one instance when hosted_zone_name is set"
  }

  assert {
    condition     = length(aws_route53_zone.site) == 1 && aws_route53_zone.site[0].name == "field-guide.example.com"
    error_message = "the hosted zone name is not 'field-guide.example.com'"
  }

  assert {
    condition     = length(aws_route53_zone.site) == 1 && length(aws_route53_zone.site[0].vpc) == 0
    error_message = "the hosted zone must be public (no vpc block)"
  }

  assert {
    condition     = length(aws_route53_zone.site) == 1 && aws_route53_zone.site[0].force_destroy != true
    error_message = "the hosted zone force_destroy must be false (or unset)"
  }
}
