# Tests for labs/03-nat-vs-gateway-endpoint (spec 042): the VPC, the subnets, the route tables and
# routes, the NAT gateway and its address, the endpoint association, and the outputs
# (AC-5, AC-6, AC-7, AC-15).
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# The three data sources are overridden (account ID, AMI, the zones that offer t4g.nano). The IDs that
# AWS would assign are overridden during plan, so that references between resources are known and the
# assertions can compare them. The Availability Zone is the sorted first of the mock's locations, so
# the mock lists "us-east-1b" before "us-east-1a" to show that the stack sorts.

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

# AC-5: the VPC has the lab CIDR and both DNS settings on (the endpoint and the Systems Manager names
# need Amazon's DNS)
run "ac5_vpc_cidr_and_dns" {
  command = plan

  assert {
    condition     = aws_vpc.lab.cidr_block == "10.30.0.0/16"
    error_message = "the VPC CIDR is not 10.30.0.0/16"
  }

  assert {
    condition     = aws_vpc.lab.enable_dns_support == true
    error_message = "enable_dns_support is not true"
  }

  assert {
    condition     = aws_vpc.lab.enable_dns_hostnames == true
    error_message = "enable_dns_hostnames is not true"
  }
}

# AC-5: both subnets are in the sorted first zone of the offerings, and neither hands out public IPs
run "ac5_subnets" {
  command = plan

  assert {
    condition     = aws_subnet.public.cidr_block == "10.30.0.0/24"
    error_message = "the public subnet CIDR is not 10.30.0.0/24"
  }

  assert {
    condition     = aws_subnet.private.cidr_block == "10.30.1.0/24"
    error_message = "the private subnet CIDR is not 10.30.1.0/24"
  }

  assert {
    condition     = aws_subnet.public.availability_zone == "us-east-1a"
    error_message = "the public subnet is not in us-east-1a (the sorted first of the offerings)"
  }

  assert {
    condition     = aws_subnet.private.availability_zone == "us-east-1a"
    error_message = "the private subnet is not in us-east-1a (the sorted first of the offerings)"
  }

  assert {
    condition     = aws_subnet.public.map_public_ip_on_launch == false
    error_message = "the public subnet maps public IPs on launch"
  }

  assert {
    condition     = aws_subnet.private.map_public_ip_on_launch == false
    error_message = "the private subnet maps public IPs on launch"
  }

  assert {
    condition     = aws_subnet.public.vpc_id == "vpc-0123456789abcdef0" && aws_subnet.private.vpc_id == "vpc-0123456789abcdef0"
    error_message = "both subnets must be in the lab VPC"
  }
}

# AC-6: each table is in the VPC and the internet gateway is attached to it
run "ac6_tables_and_gateway" {
  command = plan

  assert {
    condition     = aws_internet_gateway.lab.vpc_id == "vpc-0123456789abcdef0"
    error_message = "the internet gateway is not in the lab VPC"
  }

  assert {
    condition     = aws_route_table.public.vpc_id == "vpc-0123456789abcdef0"
    error_message = "the public route table is not in the lab VPC"
  }

  assert {
    condition     = aws_route_table.private.vpc_id == "vpc-0123456789abcdef0"
    error_message = "the private route table is not in the lab VPC"
  }
}

# AC-6: the public table goes to the internet gateway, the private table to the NAT gateway
run "ac6_routes" {
  command = plan

  assert {
    condition     = aws_route.public_internet.route_table_id == "rtb-0123456789abcdef1"
    error_message = "the public internet route is not in the public route table"
  }

  assert {
    condition     = aws_route.public_internet.destination_cidr_block == "0.0.0.0/0"
    error_message = "the public internet route is not 0.0.0.0/0"
  }

  assert {
    condition     = aws_route.public_internet.gateway_id == "igw-0123456789abcdef0"
    error_message = "the public internet route does not go to the internet gateway"
  }

  assert {
    condition     = aws_route.private_nat.route_table_id == "rtb-0123456789abcdef2"
    error_message = "the private NAT route is not in the private route table"
  }

  assert {
    condition     = aws_route.private_nat.destination_cidr_block == "0.0.0.0/0"
    error_message = "the private NAT route is not 0.0.0.0/0"
  }

  assert {
    condition     = aws_route.private_nat.nat_gateway_id == "nat-0123456789abcdef0"
    error_message = "the private NAT route does not go to the NAT gateway"
  }
}

# AC-6: each subnet is associated with its own table
run "ac6_associations" {
  command = plan

  assert {
    condition     = aws_route_table_association.public.subnet_id == "subnet-0123456789abcdef1" && aws_route_table_association.public.route_table_id == "rtb-0123456789abcdef1"
    error_message = "the public subnet must be associated with the public route table"
  }

  assert {
    condition     = aws_route_table_association.private.subnet_id == "subnet-0123456789abcdef2" && aws_route_table_association.private.route_table_id == "rtb-0123456789abcdef2"
    error_message = "the private subnet must be associated with the private route table"
  }
}

# AC-6: the endpoint is associated with the private table only (this is what adds the prefix list route)
run "ac6_endpoint_association" {
  command = plan

  assert {
    condition     = aws_vpc_endpoint_route_table_association.s3_private.vpc_endpoint_id == "vpce-0123456789abcdef0"
    error_message = "the association must name the S3 endpoint"
  }

  assert {
    condition     = aws_vpc_endpoint_route_table_association.s3_private.route_table_id == "rtb-0123456789abcdef2"
    error_message = "the association must name the private route table, not the public one"
  }
}

# AC-7: the NAT gateway uses the elastic IP, sits in the public subnet and is a public one
run "ac7_eip_and_nat_gateway" {
  command = plan

  assert {
    condition     = aws_eip.nat.domain == "vpc"
    error_message = "the elastic IP domain is not 'vpc'"
  }

  assert {
    condition     = aws_nat_gateway.lab.allocation_id == "eipalloc-0123456789abcdef0"
    error_message = "the NAT gateway does not use the elastic IP allocation"
  }

  assert {
    condition     = aws_nat_gateway.lab.subnet_id == "subnet-0123456789abcdef1"
    error_message = "the NAT gateway must be in the public subnet, not the private one"
  }

  assert {
    condition     = aws_nat_gateway.lab.connectivity_type == "public"
    error_message = "the NAT gateway connectivity_type is not 'public'"
  }
}

# AC-15: the eleven outputs equal the overridden or computed values
run "ac15_outputs" {
  command = plan

  assert {
    condition     = output.vpc_id == "vpc-0123456789abcdef0"
    error_message = "output vpc_id is not the VPC ID"
  }

  assert {
    condition     = output.public_route_table_id == "rtb-0123456789abcdef1"
    error_message = "output public_route_table_id is not the public route table ID"
  }

  assert {
    condition     = output.private_route_table_id == "rtb-0123456789abcdef2"
    error_message = "output private_route_table_id is not the private route table ID"
  }

  assert {
    condition     = output.nat_gateway_id == "nat-0123456789abcdef0"
    error_message = "output nat_gateway_id is not the NAT gateway ID"
  }

  assert {
    condition     = output.nat_public_ip == "203.0.113.10"
    error_message = "output nat_public_ip is not the public IP of the elastic IP"
  }

  assert {
    condition     = output.s3_endpoint_id == "vpce-0123456789abcdef0"
    error_message = "output s3_endpoint_id is not the endpoint ID"
  }

  assert {
    condition     = output.instance_id == "i-0123456789abcdef0"
    error_message = "output instance_id is not the instance ID"
  }

  assert {
    condition     = output.instance_security_group_id == "sg-0123456789abcdef0"
    error_message = "output instance_security_group_id is not the instance security group ID"
  }

  assert {
    condition     = output.instance_role_arn == "arn:aws:iam::111111111111:role/lab/fg-lab03-instance"
    error_message = "output instance_role_arn is not the ARN of the instance role"
  }

  assert {
    condition     = output.data_bucket_name == "field-guide-lab03-data-111111111111"
    error_message = "output data_bucket_name is not field-guide-lab03-data-<account_id>"
  }

  assert {
    condition     = output.other_bucket_name == "field-guide-lab03-other-111111111111"
    error_message = "output other_bucket_name is not field-guide-lab03-other-<account_id>"
  }
}
