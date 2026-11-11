# Tests for labs/04-alb-asg-self-healing (spec 048): the VPC, the four subnets, the internet gateway,
# the route tables and the routes, and the associations (AC-6, AC-7).
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# The two data sources are overridden (the AMI and the zones that offer t4g.nano). The IDs that AWS
# would assign are overridden during plan, so that references between resources are known and the
# assertions can compare them. A count resource gets one override per index with its own ID: one
# override for the whole resource would give both subnets the same ID.
# The mock lists three zones in reverse order: the stack must sort them and use the first two, so a
# third zone is never used.

mock_provider "aws" {
  override_data {
    target = data.aws_ami.al2023_arm64
    values = {
      id               = "ami-0123456789abcdef0"
      root_device_name = "/dev/xvda"
    }
  }

  override_data {
    target = data.aws_ec2_instance_type_offerings.nano
    values = {
      locations = ["eu-west-1c", "eu-west-1b", "eu-west-1a"]
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
  target          = aws_subnet.public[0]
  override_during = plan
  values = {
    id = "subnet-0123456789abcdef0"
  }
}

override_resource {
  target          = aws_subnet.public[1]
  override_during = plan
  values = {
    id = "subnet-0123456789abcdef1"
  }
}

override_resource {
  target          = aws_subnet.private[0]
  override_during = plan
  values = {
    id = "subnet-0123456789abcdef2"
  }
}

override_resource {
  target          = aws_subnet.private[1]
  override_during = plan
  values = {
    id = "subnet-0123456789abcdef3"
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
  target          = aws_security_group.alb
  override_during = plan
  values = {
    id = "sg-0123456789abcdef1"
  }
}

override_resource {
  target          = aws_security_group.web
  override_during = plan
  values = {
    id = "sg-0123456789abcdef2"
  }
}

override_resource {
  target          = aws_lb.web
  override_during = plan
  values = {
    arn      = "arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/app/fg-lab04-web/0123456789abcdef"
    dns_name = "fg-lab04-web-1234567890.eu-west-1.elb.amazonaws.com"
  }
}

override_resource {
  target          = aws_lb_target_group.web
  override_during = plan
  values = {
    arn = "arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/fg-lab04-web/0123456789abcdef"
  }
}

override_resource {
  target          = aws_lb_listener.http
  override_during = plan
  values = {
    arn = "arn:aws:elasticloadbalancing:eu-west-1:111122223333:listener/app/fg-lab04-web/0123456789abcdef/0123456789abcdef"
  }
}

override_resource {
  target          = aws_launch_template.web
  override_during = plan
  values = {
    id             = "lt-0123456789abcdef0"
    latest_version = 1
  }
}

# AC-6: the VPC has the lab CIDR and both DNS settings on
run "ac6_vpc_cidr_and_dns" {
  command = plan

  assert {
    condition     = aws_vpc.lab.cidr_block == "10.40.0.0/16"
    error_message = "the VPC CIDR is not 10.40.0.0/16"
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

# AC-6: the public subnets are the /24s 10.40.0.0 and 10.40.1.0 in the first two sorted zones
run "ac6_public_subnets" {
  command = plan

  assert {
    condition     = length(aws_subnet.public) == 2
    error_message = "there must be exactly two public subnets"
  }

  assert {
    condition     = aws_subnet.public[0].cidr_block == "10.40.0.0/24" && aws_subnet.public[0].availability_zone == "eu-west-1a"
    error_message = "the first public subnet is not 10.40.0.0/24 in eu-west-1a"
  }

  assert {
    condition     = aws_subnet.public[1].cidr_block == "10.40.1.0/24" && aws_subnet.public[1].availability_zone == "eu-west-1b"
    error_message = "the second public subnet is not 10.40.1.0/24 in eu-west-1b"
  }
}

# AC-6: the private subnets are the /24s 10.40.10.0 and 10.40.11.0 in the same two zones
run "ac6_private_subnets" {
  command = plan

  assert {
    condition     = length(aws_subnet.private) == 2
    error_message = "there must be exactly two private subnets"
  }

  assert {
    condition     = aws_subnet.private[0].cidr_block == "10.40.10.0/24" && aws_subnet.private[0].availability_zone == "eu-west-1a"
    error_message = "the first private subnet is not 10.40.10.0/24 in eu-west-1a"
  }

  assert {
    condition     = aws_subnet.private[1].cidr_block == "10.40.11.0/24" && aws_subnet.private[1].availability_zone == "eu-west-1b"
    error_message = "the second private subnet is not 10.40.11.0/24 in eu-west-1b"
  }
}

# AC-6: a third zone is never used, whatever the mock lists
run "ac6_no_third_zone" {
  command = plan

  assert {
    condition     = alltrue([for s in concat(aws_subnet.public, aws_subnet.private) : s.availability_zone != "eu-west-1c"])
    error_message = "a subnet is in eu-west-1c: only the sorted first two zones may be used"
  }
}

# AC-6: no subnet hands out public IPs on launch
run "ac6_no_public_ip_on_launch" {
  command = plan

  assert {
    condition     = alltrue([for s in aws_subnet.public : s.map_public_ip_on_launch == false])
    error_message = "a public subnet maps public IPs on launch"
  }

  assert {
    condition     = alltrue([for s in aws_subnet.private : s.map_public_ip_on_launch == false])
    error_message = "a private subnet maps public IPs on launch"
  }
}

# AC-6: the subnets, the internet gateway and both route tables are in the lab VPC
run "ac6_everything_is_in_the_lab_vpc" {
  command = plan

  assert {
    condition     = alltrue([for s in concat(aws_subnet.public, aws_subnet.private) : s.vpc_id == "vpc-0123456789abcdef0"])
    error_message = "a subnet is not in the lab VPC"
  }

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

# AC-7: the public table has the default route to the internet gateway
run "ac7_public_internet_route" {
  command = plan

  assert {
    condition     = aws_route.public_internet.route_table_id == "rtb-0123456789abcdef1"
    error_message = "the internet route is not in the public route table"
  }

  assert {
    condition     = aws_route.public_internet.destination_cidr_block == "0.0.0.0/0"
    error_message = "the internet route is not 0.0.0.0/0"
  }

  assert {
    condition     = aws_route.public_internet.gateway_id == "igw-0123456789abcdef0"
    error_message = "the internet route does not go to the internet gateway"
  }
}

# AC-7: each public subnet is associated with the public table
run "ac7_public_associations" {
  command = plan

  assert {
    condition     = length(aws_route_table_association.public) == 2
    error_message = "there must be exactly two public associations"
  }

  assert {
    condition     = aws_route_table_association.public[0].subnet_id == "subnet-0123456789abcdef0" && aws_route_table_association.public[0].route_table_id == "rtb-0123456789abcdef1"
    error_message = "the first public subnet is not associated with the public route table"
  }

  assert {
    condition     = aws_route_table_association.public[1].subnet_id == "subnet-0123456789abcdef1" && aws_route_table_association.public[1].route_table_id == "rtb-0123456789abcdef1"
    error_message = "the second public subnet is not associated with the public route table"
  }
}

# AC-7: each private subnet is associated with the private table
run "ac7_private_associations" {
  command = plan

  assert {
    condition     = length(aws_route_table_association.private) == 2
    error_message = "there must be exactly two private associations"
  }

  assert {
    condition     = aws_route_table_association.private[0].subnet_id == "subnet-0123456789abcdef2" && aws_route_table_association.private[0].route_table_id == "rtb-0123456789abcdef2"
    error_message = "the first private subnet is not associated with the private route table"
  }

  assert {
    condition     = aws_route_table_association.private[1].subnet_id == "subnet-0123456789abcdef3" && aws_route_table_association.private[1].route_table_id == "rtb-0123456789abcdef2"
    error_message = "the second private subnet is not associated with the private route table"
  }
}
