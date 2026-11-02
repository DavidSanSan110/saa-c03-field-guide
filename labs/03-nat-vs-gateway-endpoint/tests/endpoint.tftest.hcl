# Tests for labs/03-nat-vs-gateway-endpoint (spec 042): the S3 gateway endpoint and its endpoint
# policy (AC-8).
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# The endpoint policy is a jsonencode() of a local, so it is asserted on jsondecode(policy).
# Statements are compared as jsonencode() text: jsonencode sorts the keys of an object, so the
# comparison does not depend on the order the stack writes them in, and it tells a string from a list.
# The IDs that AWS would assign are overridden during plan.

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

# AC-8: the endpoint is the gateway endpoint of S3 in us-east-1, in the lab VPC
run "ac8_endpoint_basics" {
  command = plan

  assert {
    condition     = aws_vpc_endpoint.s3.service_name == "com.amazonaws.us-east-1.s3"
    error_message = "the endpoint service_name is not com.amazonaws.us-east-1.s3"
  }

  assert {
    condition     = aws_vpc_endpoint.s3.vpc_endpoint_type == "Gateway"
    error_message = "the endpoint type is not 'Gateway'"
  }

  assert {
    condition     = aws_vpc_endpoint.s3.vpc_id == "vpc-0123456789abcdef0"
    error_message = "the endpoint is not in the lab VPC"
  }
}

# AC-8: the endpoint policy has one statement
run "ac8_endpoint_policy_shape" {
  command = plan

  assert {
    condition     = jsondecode(aws_vpc_endpoint.s3.policy).Version == "2012-10-17"
    error_message = "the endpoint policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_vpc_endpoint.s3.policy).Statement) == 1
    error_message = "the endpoint policy must have exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_vpc_endpoint.s3.policy).Statement[0].Sid == "OnlyTheLabDataBucket"
    error_message = "the endpoint policy statement Sid is not 'OnlyTheLabDataBucket'"
  }
}

# AC-8: the statement allows three S3 actions on the data bucket and nothing else
run "ac8_endpoint_policy_statement" {
  command = plan

  assert {
    condition = jsonencode(jsondecode(aws_vpc_endpoint.s3.policy).Statement[0]) == jsonencode({
      Sid       = "OnlyTheLabDataBucket"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject", "s3:ListBucket", "s3:PutObject"]
      Resource  = ["arn:aws:s3:::field-guide-lab03-data-111111111111", "arn:aws:s3:::field-guide-lab03-data-111111111111/*"]
    })
    error_message = "the statement must be exactly OnlyTheLabDataBucket: Allow '*' [s3:GetObject, s3:ListBucket, s3:PutObject] on the data bucket ARN and <data bucket ARN>/*"
  }

  assert {
    condition     = !strcontains(jsonencode(jsondecode(aws_vpc_endpoint.s3.policy).Statement[0].Resource), "other")
    error_message = "the endpoint policy must not name the other bucket"
  }

  assert {
    condition     = !contains(keys(jsondecode(aws_vpc_endpoint.s3.policy).Statement[0]), "Condition")
    error_message = "the endpoint policy statement must not have a Condition"
  }
}
