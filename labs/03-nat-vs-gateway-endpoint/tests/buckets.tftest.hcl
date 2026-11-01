# Tests for labs/03-nat-vs-gateway-endpoint (spec 042): the data bucket, the other bucket and the
# bucket policy of the data bucket (AC-13, AC-14).
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# Names and ARNs are built from the account ID, so they are known at plan time. The endpoint ID is
# overridden during plan: the bucket policy refers to it. The bucket policy is a jsonencode() of a
# local; statements are compared as jsonencode() text: jsonencode sorts the keys of an object, so the
# comparison does not depend on the order the stack writes them in, and it tells a string from a list.
# The order of the statements themselves is part of the contract (a list comparison). The rule of the
# encryption configuration is a set in the provider schema, hence one(...) and tolist(...).

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }

  override_data {
    target = data.aws_ami.al2023_arm64
    values = {
      id = "ami-0123456789abcdef0"
    }
  }

  override_data {
    target = data.aws_ec2_instance_type_offerings.nano
    values = {
      locations = ["us-east-1b", "us-east-1a"]
    }
  }
}

override_resource {
  target          = aws_vpc.lab
  override_during = plan
  values = {
    id = "vpc-0123456789abcdef0"
  }
}

override_resource {
  target          = aws_internet_gateway.lab
  override_during = plan
  values = {
    id = "igw-0123456789abcdef0"
  }
}

override_resource {
  target          = aws_subnet.public
  override_during = plan
  values = {
    id = "subnet-0123456789abcdef1"
  }
}

override_resource {
  target          = aws_subnet.private
  override_during = plan
  values = {
    id = "subnet-0123456789abcdef2"
  }
}

override_resource {
  target          = aws_route_table.public
  override_during = plan
  values = {
    id = "rtb-0123456789abcdef1"
  }
}

override_resource {
  target          = aws_route_table.private
  override_during = plan
  values = {
    id = "rtb-0123456789abcdef2"
  }
}

override_resource {
  target          = aws_eip.nat
  override_during = plan
  values = {
    id        = "eipalloc-0123456789abcdef0"
    public_ip = "203.0.113.10"
  }
}

override_resource {
  target          = aws_nat_gateway.lab
  override_during = plan
  values = {
    id = "nat-0123456789abcdef0"
  }
}

override_resource {
  target          = aws_vpc_endpoint.s3
  override_during = plan
  values = {
    id = "vpce-0123456789abcdef0"
  }
}

override_resource {
  target          = aws_security_group.instance
  override_during = plan
  values = {
    id = "sg-0123456789abcdef0"
  }
}

override_resource {
  target          = aws_iam_role.instance
  override_during = plan
  values = {
    arn = "arn:aws:iam::111111111111:role/lab/fg-lab03-instance"
  }
}

override_resource {
  target          = aws_instance.private
  override_during = plan
  values = {
    id = "i-0123456789abcdef0"
  }
}

# AC-13: the two buckets: names and force_destroy
run "ac13_buckets" {
  command = plan

  assert {
    condition     = aws_s3_bucket.data.bucket == "field-guide-lab03-data-111111111111"
    error_message = "the data bucket name is not field-guide-lab03-data-<account_id>"
  }

  assert {
    condition     = aws_s3_bucket.other.bucket == "field-guide-lab03-other-111111111111"
    error_message = "the other bucket name is not field-guide-lab03-other-<account_id>"
  }

  assert {
    condition     = aws_s3_bucket.data.force_destroy == true
    error_message = "force_destroy must be true on the data bucket: the probe objects must not block destroy"
  }

  assert {
    condition     = aws_s3_bucket.other.force_destroy == true
    error_message = "force_destroy must be true on the other bucket: the probe objects must not block destroy"
  }
}

# AC-13: every sub-resource points at its bucket by name
run "ac13_sub_resources_name_their_bucket" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.data.bucket == "field-guide-lab03-data-111111111111"
    error_message = "the data public access block does not name the data bucket"
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.data.bucket == "field-guide-lab03-data-111111111111"
    error_message = "the data ownership controls do not name the data bucket"
  }

  assert {
    condition     = aws_s3_bucket_server_side_encryption_configuration.data.bucket == "field-guide-lab03-data-111111111111"
    error_message = "the data encryption configuration does not name the data bucket"
  }

  assert {
    condition     = aws_s3_bucket_policy.data.bucket == "field-guide-lab03-data-111111111111"
    error_message = "the bucket policy does not name the data bucket"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.other.bucket == "field-guide-lab03-other-111111111111"
    error_message = "the other public access block does not name the other bucket"
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.other.bucket == "field-guide-lab03-other-111111111111"
    error_message = "the other ownership controls do not name the other bucket"
  }

  assert {
    condition     = aws_s3_bucket_server_side_encryption_configuration.other.bucket == "field-guide-lab03-other-111111111111"
    error_message = "the other encryption configuration does not name the other bucket"
  }
}

# AC-13: all four public access settings are on and ACLs are off, on both buckets
run "ac13_public_access_block_and_ownership" {
  command = plan

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.data.block_public_acls,
      aws_s3_bucket_public_access_block.data.ignore_public_acls,
      aws_s3_bucket_public_access_block.data.block_public_policy,
      aws_s3_bucket_public_access_block.data.restrict_public_buckets,
    ])
    error_message = "the four public access settings of the data bucket are not all true"
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.other.block_public_acls,
      aws_s3_bucket_public_access_block.other.ignore_public_acls,
      aws_s3_bucket_public_access_block.other.block_public_policy,
      aws_s3_bucket_public_access_block.other.restrict_public_buckets,
    ])
    error_message = "the four public access settings of the other bucket are not all true"
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.data.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "the data bucket object_ownership is not 'BucketOwnerEnforced'"
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.other.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "the other bucket object_ownership is not 'BucketOwnerEnforced'"
  }
}

# AC-13: default encryption is SSE-S3 with no Bucket Key and SSE-C blocked, on both buckets. That no
# rule names a KMS key (kms_master_key_id) cannot be asserted in a plan: the provider computes it and it
# is unknown until apply, so lab-03-nat-vs-gateway-endpoint.test.ts reads the HCL for it.
run "ac13_default_encryption" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_server_side_encryption_configuration.data.rule) == 1 && length(aws_s3_bucket_server_side_encryption_configuration.other.rule) == 1
    error_message = "each encryption configuration must have exactly one rule"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.data.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "the data bucket rule sse_algorithm is not 'AES256'"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.other.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "the other bucket rule sse_algorithm is not 'AES256'"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.data.rule).bucket_key_enabled == false
    error_message = "the data bucket bucket_key_enabled is not false"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.other.rule).bucket_key_enabled == false
    error_message = "the other bucket bucket_key_enabled is not false"
  }

  assert {
    condition     = tolist(one(aws_s3_bucket_server_side_encryption_configuration.data.rule).blocked_encryption_types) == tolist(["SSE-C"])
    error_message = "the data bucket blocked_encryption_types is not exactly ['SSE-C']"
  }

  assert {
    condition     = tolist(one(aws_s3_bucket_server_side_encryption_configuration.other.rule).blocked_encryption_types) == tolist(["SSE-C"])
    error_message = "the other bucket blocked_encryption_types is not exactly ['SSE-C']"
  }
}

# AC-14: the data bucket policy has the two statements of the spec, in this order, and only denies
run "ac14_bucket_policy_shape" {
  command = plan

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.data.policy).Version == "2012-10-17"
    error_message = "the bucket policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_s3_bucket_policy.data.policy).Statement) == 2
    error_message = "the bucket policy must have exactly two statements"
  }

  assert {
    condition     = [for s in jsondecode(aws_s3_bucket_policy.data.policy).Statement : s.Sid] == ["DenyInsecureTransport", "DenyReadOutsideEndpoint"]
    error_message = "the statement Sids must be DenyInsecureTransport, DenyReadOutsideEndpoint, in this order"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.data.policy).Statement : s.Effect == "Deny"])
    error_message = "every statement of the bucket policy must be a Deny"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.data.policy).Statement : s.Principal == "*"])
    error_message = "every statement of the bucket policy must have Principal '*' (a string)"
  }
}

# AC-14: DenyInsecureTransport refuses every request that is not TLS, on the bucket and its objects
run "ac14_deny_insecure_transport" {
  command = plan

  assert {
    condition = jsonencode(jsondecode(aws_s3_bucket_policy.data.policy).Statement[0]) == jsonencode({
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = ["arn:aws:s3:::field-guide-lab03-data-111111111111", "arn:aws:s3:::field-guide-lab03-data-111111111111/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    })
    error_message = "statement 1 must be exactly DenyInsecureTransport: Deny '*' s3:* on the bucket ARN and <bucket ARN>/* when aws:SecureTransport is false"
  }
}

# AC-14: DenyReadOutsideEndpoint refuses a read of endpoint-only/ unless it comes through the endpoint.
# One operator, StringNotEquals, with no Null condition: a request from outside the VPC has no
# aws:SourceVpce key, and a negated operator is true on a missing key, which is the deny wanted here.
run "ac14_deny_read_outside_endpoint" {
  command = plan

  assert {
    condition = jsonencode(jsondecode(aws_s3_bucket_policy.data.policy).Statement[1]) == jsonencode({
      Sid       = "DenyReadOutsideEndpoint"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "arn:aws:s3:::field-guide-lab03-data-111111111111/endpoint-only/*"
      Condition = { StringNotEquals = { "aws:SourceVpce" = "vpce-0123456789abcdef0" } }
    })
    error_message = "statement 2 must be exactly DenyReadOutsideEndpoint: Deny '*' s3:GetObject (a string) on <data bucket ARN>/endpoint-only/* (a string) with StringNotEquals aws:SourceVpce = the endpoint ID"
  }

  assert {
    condition     = keys(jsondecode(aws_s3_bucket_policy.data.policy).Statement[1].Condition) == ["StringNotEquals"]
    error_message = "statement 2 must have exactly one condition operator, StringNotEquals (no Null, no IfExists)"
  }

  assert {
    condition     = keys(jsondecode(aws_s3_bucket_policy.data.policy).Statement[1].Condition.StringNotEquals) == ["aws:SourceVpce"]
    error_message = "statement 2 must test exactly the key aws:SourceVpce"
  }
}
