# Tests for labs/04-alb-asg-self-healing (spec 048): the two security groups and their rules, the
# default security group, the load balancer, the target group and the listener (AC-8, AC-9, AC-10).
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# The two data sources are overridden (the AMI and the zones that offer t4g.nano). The IDs that AWS
# would assign are overridden during plan, so that references between resources are known and the
# assertions can compare them. A count resource gets one override per index with its own ID.
#
# What a mock plan cannot show: the missing rule blocks of the groups (and the web group's missing
# egress rule). The text of the .tf files is checked by lab-04-alb-asg-self-healing.test.ts (AC-3) and
# the real group by verify.sh (check 11).

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

# AC-8: the two groups are named, described and in the lab VPC
run "ac8_security_groups" {
  command = plan

  assert {
    condition     = aws_security_group.alb.name == "fg-lab04-alb"
    error_message = "the load balancer group is not named fg-lab04-alb"
  }

  assert {
    condition     = aws_security_group.alb.description != "" && aws_security_group.alb.vpc_id == "vpc-0123456789abcdef0"
    error_message = "the load balancer group needs a description and the lab VPC"
  }

  assert {
    condition     = aws_security_group.web.name == "fg-lab04-web"
    error_message = "the web group is not named fg-lab04-web"
  }

  assert {
    condition     = aws_security_group.web.description != "" && aws_security_group.web.vpc_id == "vpc-0123456789abcdef0"
    error_message = "the web group needs a description and the lab VPC"
  }
}

# AC-8: the load balancer group takes TCP 80 from anywhere
run "ac8_alb_ingress_rule" {
  command = plan

  assert {
    condition     = aws_vpc_security_group_ingress_rule.alb_http.security_group_id == "sg-0123456789abcdef1"
    error_message = "alb_http is not on the load balancer group"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.alb_http.ip_protocol == "tcp"
    error_message = "alb_http is not TCP"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.alb_http.from_port == 80 && aws_vpc_security_group_ingress_rule.alb_http.to_port == 80
    error_message = "alb_http is not port 80 to 80"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.alb_http.cidr_ipv4 == "0.0.0.0/0"
    error_message = "alb_http is not from 0.0.0.0/0"
  }
}

# AC-8: the load balancer group sends TCP 80 to the web group only
run "ac8_alb_egress_rule" {
  command = plan

  assert {
    condition     = aws_vpc_security_group_egress_rule.alb_to_web.security_group_id == "sg-0123456789abcdef1"
    error_message = "alb_to_web is not on the load balancer group"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.alb_to_web.ip_protocol == "tcp"
    error_message = "alb_to_web is not TCP"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.alb_to_web.from_port == 80 && aws_vpc_security_group_egress_rule.alb_to_web.to_port == 80
    error_message = "alb_to_web is not port 80 to 80"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.alb_to_web.referenced_security_group_id == "sg-0123456789abcdef2"
    error_message = "alb_to_web does not point at the web group"
  }
}

# AC-8: the web group takes TCP 80 from the load balancer group only
run "ac8_web_ingress_rule" {
  command = plan

  assert {
    condition     = aws_vpc_security_group_ingress_rule.web_from_alb.security_group_id == "sg-0123456789abcdef2"
    error_message = "web_from_alb is not on the web group"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.web_from_alb.ip_protocol == "tcp"
    error_message = "web_from_alb is not TCP"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.web_from_alb.from_port == 80 && aws_vpc_security_group_ingress_rule.web_from_alb.to_port == 80
    error_message = "web_from_alb is not port 80 to 80"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.web_from_alb.referenced_security_group_id == "sg-0123456789abcdef1"
    error_message = "web_from_alb does not come from the load balancer group"
  }
}

# AC-8: the default security group of the VPC is adopted (no rules)
run "ac8_default_security_group" {
  command = plan

  assert {
    condition     = aws_default_security_group.lab.vpc_id == "vpc-0123456789abcdef0"
    error_message = "the default security group is not the one of the lab VPC"
  }
}

# AC-9: the load balancer is an internet-facing IPv4 application load balancer
run "ac9_load_balancer_kind" {
  command = plan

  assert {
    condition     = aws_lb.web.name == "fg-lab04-web"
    error_message = "the load balancer is not named fg-lab04-web"
  }

  assert {
    condition     = aws_lb.web.load_balancer_type == "application"
    error_message = "the load balancer is not an application load balancer"
  }

  assert {
    condition     = aws_lb.web.internal == false
    error_message = "the load balancer is internal"
  }

  assert {
    condition     = aws_lb.web.ip_address_type == "ipv4"
    error_message = "the load balancer is not IPv4 only"
  }
}

# AC-9: the load balancer sits in the two public subnets and uses only its own group
run "ac9_load_balancer_network" {
  command = plan

  assert {
    condition     = toset(aws_lb.web.subnets) == toset(["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"])
    error_message = "the load balancer is not in exactly the two public subnets"
  }

  assert {
    condition     = toset(aws_lb.web.security_groups) == toset(["sg-0123456789abcdef1"])
    error_message = "the load balancer must have only the load balancer security group"
  }
}

# AC-9: invalid headers are dropped, deletion protection is off, zonal shift is on
run "ac9_load_balancer_settings" {
  command = plan

  assert {
    condition     = aws_lb.web.drop_invalid_header_fields == true
    error_message = "drop_invalid_header_fields is not true"
  }

  assert {
    condition     = aws_lb.web.enable_deletion_protection == false
    error_message = "deletion protection is on: it would block the destroy"
  }

  assert {
    condition     = aws_lb.web.enable_zonal_shift == true
    error_message = "enable_zonal_shift is not true"
  }
}

# AC-10: the target group is an HTTP instance target group on port 80 in the lab VPC
run "ac10_target_group" {
  command = plan

  assert {
    condition     = aws_lb_target_group.web.name == "fg-lab04-web"
    error_message = "the target group is not named fg-lab04-web"
  }

  assert {
    condition     = aws_lb_target_group.web.port == 80
    error_message = "the target group port is not 80"
  }

  assert {
    condition     = aws_lb_target_group.web.protocol == "HTTP"
    error_message = "the target group protocol is not HTTP"
  }

  assert {
    condition     = aws_lb_target_group.web.target_type == "instance"
    error_message = "the target group type is not instance"
  }

  assert {
    condition     = aws_lb_target_group.web.vpc_id == "vpc-0123456789abcdef0"
    error_message = "the target group is not in the lab VPC"
  }

  assert {
    condition     = aws_lb_target_group.web.deregistration_delay == "30"
    error_message = "the deregistration delay is not 30 (a string in the schema)"
  }
}

# AC-10: the health check is set explicitly: HTTP, /, traffic port, every 10 s, 5 s timeout, 2 and 2, 200
run "ac10_health_check" {
  command = plan

  assert {
    condition     = length(aws_lb_target_group.web.health_check) == 1
    error_message = "the target group must have exactly one health_check block"
  }

  assert {
    condition     = one(aws_lb_target_group.web.health_check).enabled == true
    error_message = "the health check is not enabled"
  }

  assert {
    condition     = one(aws_lb_target_group.web.health_check).protocol == "HTTP"
    error_message = "the health check protocol is not HTTP"
  }

  assert {
    condition     = one(aws_lb_target_group.web.health_check).path == "/"
    error_message = "the health check path is not /"
  }

  assert {
    condition     = one(aws_lb_target_group.web.health_check).port == "traffic-port"
    error_message = "the health check port is not traffic-port"
  }

  assert {
    condition     = one(aws_lb_target_group.web.health_check).interval == 10
    error_message = "the health check interval is not 10 seconds"
  }

  assert {
    condition     = one(aws_lb_target_group.web.health_check).timeout == 5
    error_message = "the health check timeout is not 5 seconds"
  }

  assert {
    condition     = one(aws_lb_target_group.web.health_check).healthy_threshold == 2
    error_message = "the healthy threshold is not 2"
  }

  assert {
    condition     = one(aws_lb_target_group.web.health_check).unhealthy_threshold == 2
    error_message = "the unhealthy threshold is not 2"
  }

  assert {
    condition     = one(aws_lb_target_group.web.health_check).matcher == "200"
    error_message = "the health check matcher is not 200"
  }
}

# AC-10: the listener is HTTP on port 80 of the load balancer and forwards everything to the target group
run "ac10_listener" {
  command = plan

  assert {
    condition     = aws_lb_listener.http.load_balancer_arn == "arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/app/fg-lab04-web/0123456789abcdef"
    error_message = "the listener does not belong to the load balancer"
  }

  assert {
    condition     = aws_lb_listener.http.port == 80
    error_message = "the listener port is not 80"
  }

  assert {
    condition     = aws_lb_listener.http.protocol == "HTTP"
    error_message = "the listener protocol is not HTTP"
  }

  assert {
    condition     = length(aws_lb_listener.http.default_action) == 1
    error_message = "the listener must have exactly one default action"
  }

  assert {
    condition     = one(aws_lb_listener.http.default_action).type == "forward"
    error_message = "the default action is not forward"
  }

  assert {
    condition     = one(aws_lb_listener.http.default_action).target_group_arn == "arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/fg-lab04-web/0123456789abcdef"
    error_message = "the default action does not forward to the target group"
  }
}
