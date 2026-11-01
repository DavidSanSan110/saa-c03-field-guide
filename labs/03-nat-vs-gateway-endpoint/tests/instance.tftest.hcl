# Tests for labs/03-nat-vs-gateway-endpoint (spec 042): the private instance, its security group, the
# default security group, the instance role, its trust policy, its attachment, its instance profile and
# its inline policy (AC-9, AC-10, AC-11, AC-12).
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# Policies are jsonencode() of locals, so they are asserted on jsondecode(<resource>.<policy>).
# Statements are compared as jsonencode() text: jsonencode sorts the keys of an object, so the
# comparison does not depend on the order the stack writes them in, and it tells a string from a list.
# The order of the statements themselves is part of the contract (a list comparison). The block lists
# of aws_instance (metadata_options, root_block_device, credit_specification) are indexed with [0].

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

# AC-9: the instance is the cheapest arm64 type, from the mock AMI, in the private subnet, with no
# public IP, the instance profile and only the instance security group
run "ac9_instance_placement" {
  command = plan

  assert {
    condition     = aws_instance.private.instance_type == "t4g.nano"
    error_message = "the instance type is not t4g.nano"
  }

  assert {
    condition     = aws_instance.private.ami == "ami-0123456789abcdef0"
    error_message = "the instance does not use the AMI of the aws_ami data source"
  }

  assert {
    condition     = aws_instance.private.subnet_id == "subnet-0123456789abcdef2"
    error_message = "the instance is not in the private subnet"
  }

  assert {
    condition     = aws_instance.private.associate_public_ip_address == false
    error_message = "associate_public_ip_address is not false"
  }

  assert {
    condition     = aws_instance.private.iam_instance_profile == "fg-lab03-instance"
    error_message = "the instance does not use the instance profile 'fg-lab03-instance'"
  }

  assert {
    condition     = length(aws_instance.private.vpc_security_group_ids) == 1 && one(aws_instance.private.vpc_security_group_ids) == "sg-0123456789abcdef0"
    error_message = "the instance must have the instance security group only"
  }
}

# AC-9: IMDSv2 only, with one hop
run "ac9_instance_metadata_options" {
  command = plan

  assert {
    condition     = aws_instance.private.metadata_options[0].http_tokens == "required"
    error_message = "http_tokens is not 'required' (IMDSv2)"
  }

  assert {
    condition     = aws_instance.private.metadata_options[0].http_put_response_hop_limit == 1
    error_message = "http_put_response_hop_limit is not 1"
  }

  assert {
    condition     = aws_instance.private.metadata_options[0].http_endpoint == "enabled"
    error_message = "http_endpoint is not 'enabled'"
  }
}

# AC-9: an encrypted 8 GB gp3 root volume (the account default covers eu-west-1 only), standard CPU
# credits and no detailed monitoring
run "ac9_instance_volume_and_credits" {
  command = plan

  assert {
    condition     = aws_instance.private.root_block_device[0].encrypted == true
    error_message = "the root volume is not encrypted"
  }

  assert {
    condition     = aws_instance.private.root_block_device[0].volume_type == "gp3"
    error_message = "the root volume type is not gp3"
  }

  assert {
    condition     = aws_instance.private.root_block_device[0].volume_size == 8
    error_message = "the root volume size is not 8"
  }

  assert {
    condition     = aws_instance.private.root_block_device[0].delete_on_termination == true
    error_message = "the root volume must be deleted with the instance"
  }

  assert {
    condition     = aws_instance.private.credit_specification[0].cpu_credits == "unlimited"
    error_message = "cpu_credits is not 'unlimited'"
  }

  assert {
    condition     = aws_instance.private.monitoring == false
    error_message = "monitoring is not false"
  }

  assert {
    condition     = aws_instance.private.ebs_optimized == true
    error_message = "ebs_optimized is not true"
  }
}

# AC-10: the instance security group is in the VPC and allows outbound HTTPS only
run "ac10_instance_security_group" {
  command = plan

  assert {
    condition     = aws_security_group.instance.name == "fg-lab03-instance"
    error_message = "the security group name is not 'fg-lab03-instance'"
  }

  assert {
    condition     = aws_security_group.instance.vpc_id == "vpc-0123456789abcdef0"
    error_message = "the security group is not in the lab VPC"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.https.security_group_id == "sg-0123456789abcdef0"
    error_message = "the egress rule is not on the instance security group"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.https.ip_protocol == "tcp"
    error_message = "the egress rule protocol is not tcp"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.https.from_port == 443 && aws_vpc_security_group_egress_rule.https.to_port == 443
    error_message = "the egress rule is not exactly port 443"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.https.cidr_ipv4 == "0.0.0.0/0"
    error_message = "the egress rule destination is not 0.0.0.0/0 (it covers the S3 prefix list too)"
  }
}

# AC-10: the default security group is the one of the lab VPC. That it has no ingress and no egress
# block (so that it is closed) cannot be asserted in a plan: both sets are computed by the provider
# and unknown until apply, so the vitest file lab-03-nat-vs-gateway-endpoint.test.ts reads the HCL.
run "ac10_default_security_group_is_the_vpc_default" {
  command = plan

  assert {
    condition     = aws_default_security_group.lab.vpc_id == "vpc-0123456789abcdef0"
    error_message = "the default security group is not the one of the lab VPC"
  }
}

# AC-11: name, path, permissions boundary and session length of the instance role
run "ac11_role_basics" {
  command = plan

  assert {
    condition     = aws_iam_role.instance.name == "fg-lab03-instance"
    error_message = "the instance role name is not 'fg-lab03-instance'"
  }

  assert {
    condition     = aws_iam_role.instance.path == "/lab/"
    error_message = "the instance role path is not '/lab/' (fg-workload-boundary denies other paths)"
  }

  assert {
    condition     = aws_iam_role.instance.permissions_boundary == "arn:aws:iam::111111111111:policy/fg-workload-boundary"
    error_message = "the instance role permissions boundary is not arn:aws:iam::<account_id>:policy/fg-workload-boundary"
  }

  assert {
    condition     = aws_iam_role.instance.max_session_duration == 3600
    error_message = "max_session_duration is not 3600"
  }
}

# AC-11: the instance role trusts the EC2 service, with one plain statement and no condition
run "ac11_role_trust_policy" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role.instance.assume_role_policy).Version == "2012-10-17"
    error_message = "the trust policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.instance.assume_role_policy).Statement) == 1
    error_message = "the trust policy must have exactly one statement"
  }

  assert {
    condition = jsonencode(jsondecode(aws_iam_role.instance.assume_role_policy).Statement[0]) == jsonencode({
      Sid       = "Ec2Service"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    })
    error_message = "the trust statement must be exactly Ec2Service: Allow Principal.Service 'ec2.amazonaws.com' Action 'sts:AssumeRole' (a string)"
  }

  assert {
    condition     = !contains(keys(jsondecode(aws_iam_role.instance.assume_role_policy).Statement[0]), "Condition")
    error_message = "the trust statement must not have a Condition"
  }
}

# AC-11: the managed policy for Systems Manager is attached with its own resource, and the instance
# profile carries the role
run "ac11_attachment_and_instance_profile" {
  command = plan

  assert {
    condition     = aws_iam_role_policy_attachment.ssm_core.role == "fg-lab03-instance"
    error_message = "the attachment is not on the role 'fg-lab03-instance'"
  }

  assert {
    condition     = aws_iam_role_policy_attachment.ssm_core.policy_arn == "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
    error_message = "the attached policy is not arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
  }

  assert {
    condition     = aws_iam_instance_profile.instance.name == "fg-lab03-instance"
    error_message = "the instance profile name is not 'fg-lab03-instance'"
  }

  assert {
    condition     = aws_iam_instance_profile.instance.role == "fg-lab03-instance"
    error_message = "the instance profile does not carry the role 'fg-lab03-instance'"
  }
}

# AC-12: the inline policy: name, role and shape
run "ac12_inline_policy_shape" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.instance.name == "use-lab-buckets"
    error_message = "the inline policy name is not 'use-lab-buckets'"
  }

  assert {
    condition     = aws_iam_role_policy.instance.role == "fg-lab03-instance"
    error_message = "the inline policy is not attached to the role 'fg-lab03-instance'"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.instance.policy).Version == "2012-10-17"
    error_message = "the inline policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.instance.policy).Statement) == 2
    error_message = "the inline policy must have exactly two statements"
  }

  assert {
    condition     = [for s in jsondecode(aws_iam_role_policy.instance.policy).Statement : s.Sid] == ["ListBuckets", "ReadWriteObjects"]
    error_message = "the statement Sids must be ListBuckets, ReadWriteObjects, in this order"
  }
}

# AC-12: the two statements, exactly, with both buckets: the endpoint policy tells them apart, not IAM
run "ac12_inline_policy_statements" {
  command = plan

  assert {
    condition = jsonencode(jsondecode(aws_iam_role_policy.instance.policy).Statement[0]) == jsonencode({
      Sid      = "ListBuckets"
      Effect   = "Allow"
      Action   = "s3:ListBucket"
      Resource = ["arn:aws:s3:::field-guide-lab03-data-111111111111", "arn:aws:s3:::field-guide-lab03-other-111111111111"]
    })
    error_message = "statement 1 must be exactly ListBuckets: Allow s3:ListBucket on the data and the other bucket ARNs"
  }

  assert {
    condition = jsonencode(jsondecode(aws_iam_role_policy.instance.policy).Statement[1]) == jsonencode({
      Sid      = "ReadWriteObjects"
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = ["arn:aws:s3:::field-guide-lab03-data-111111111111/*", "arn:aws:s3:::field-guide-lab03-other-111111111111/*"]
    })
    error_message = "statement 2 must be exactly ReadWriteObjects: Allow ['s3:GetObject', 's3:PutObject'] on <data bucket ARN>/* and <other bucket ARN>/*"
  }
}

# AC-12: no wildcard in any action of the inline policy
run "ac12_inline_policy_no_wildcard_actions" {
  command = plan

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.instance.policy).Statement : !strcontains(jsonencode(s.Action), "*")])
    error_message = "no action of the inline policy may contain '*'"
  }
}
