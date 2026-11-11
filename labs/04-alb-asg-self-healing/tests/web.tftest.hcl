# Tests for labs/04-alb-asg-self-healing (spec 048): the launch template, the Auto Scaling group and
# the outputs (AC-11, AC-12, AC-13).
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# The two data sources are overridden (the AMI and the zones that offer t4g.nano). The IDs that AWS
# would assign are overridden during plan, so that references between resources are known and the
# assertions can compare them. A count resource gets one override per index with its own ID: one
# override for the whole resource would give both subnets the same ID, and the set
# vpc_zone_identifier would collapse to one element.
#
# Block lists of the launch template (metadata_options, monitoring, credit_specification,
# block_device_mappings and its ebs) are read with one(...); the tag_specifications are filtered by
# resource type, and the group's tag set is turned into a map.

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

# AC-11: the launch template is named, uses the mock AMI, t4g.nano and only the web security group
run "ac11_launch_template_basics" {
  command = plan

  assert {
    condition     = aws_launch_template.web.name == "fg-lab04-web"
    error_message = "the launch template is not named fg-lab04-web"
  }

  assert {
    condition     = aws_launch_template.web.image_id == "ami-0123456789abcdef0"
    error_message = "the launch template does not use the AMI of the data source"
  }

  assert {
    condition     = aws_launch_template.web.instance_type == "t4g.nano"
    error_message = "the launch template instance type is not t4g.nano"
  }

  assert {
    condition     = toset(aws_launch_template.web.vpc_security_group_ids) == toset(["sg-0123456789abcdef2"])
    error_message = "the launch template must have only the web security group"
  }

  assert {
    condition     = aws_launch_template.web.update_default_version == true
    error_message = "update_default_version is not true"
  }
}

# AC-11: the user data is exactly the content of user-data.sh, base64 encoded
run "ac11_user_data" {
  command = plan

  assert {
    condition     = base64decode(aws_launch_template.web.user_data) == file("${path.module}/user-data.sh")
    error_message = "the user data does not decode to the content of user-data.sh"
  }
}

# AC-11: IMDSv2 is required with hop limit 1, monitoring is basic, credits are unlimited, EBS optimised
run "ac11_instance_settings" {
  command = plan

  assert {
    condition     = one(aws_launch_template.web.metadata_options).http_endpoint == "enabled"
    error_message = "the metadata endpoint is not enabled"
  }

  assert {
    condition     = one(aws_launch_template.web.metadata_options).http_tokens == "required"
    error_message = "IMDSv2 is not required"
  }

  assert {
    condition     = one(aws_launch_template.web.metadata_options).http_put_response_hop_limit == 1
    error_message = "the metadata hop limit is not 1"
  }

  assert {
    condition     = one(aws_launch_template.web.monitoring).enabled == false
    error_message = "detailed monitoring is on"
  }

  assert {
    condition     = one(aws_launch_template.web.credit_specification).cpu_credits == "unlimited"
    error_message = "cpu_credits is not unlimited"
  }

  assert {
    condition     = aws_launch_template.web.ebs_optimized == "true"
    error_message = "ebs_optimized is not true"
  }
}

# AC-11: one root device (the AMI's device name): encrypted gp3, 8 GB, deleted with the instance
run "ac11_root_volume" {
  command = plan

  assert {
    condition     = length(aws_launch_template.web.block_device_mappings) == 1
    error_message = "the launch template must have exactly one block device mapping"
  }

  assert {
    condition     = one(aws_launch_template.web.block_device_mappings).device_name == "/dev/xvda"
    error_message = "the block device is not the root device name of the AMI"
  }

  assert {
    condition     = one(one(aws_launch_template.web.block_device_mappings).ebs).encrypted == "true"
    error_message = "the root volume is not encrypted"
  }

  assert {
    condition     = one(one(aws_launch_template.web.block_device_mappings).ebs).volume_type == "gp3"
    error_message = "the root volume is not gp3"
  }

  assert {
    condition     = one(one(aws_launch_template.web.block_device_mappings).ebs).volume_size == 8
    error_message = "the root volume is not 8 GB"
  }

  assert {
    condition     = one(one(aws_launch_template.web.block_device_mappings).ebs).delete_on_termination == "true"
    error_message = "the root volume is not deleted on termination"
  }
}

# AC-11: exactly three tag_specifications: instance, volume and network-interface
run "ac11_tag_specification_types" {
  command = plan

  assert {
    condition     = length(aws_launch_template.web.tag_specifications) == 3
    error_message = "the launch template must have exactly three tag_specifications blocks"
  }

  assert {
    condition     = toset([for t in aws_launch_template.web.tag_specifications : t.resource_type]) == toset(["instance", "volume", "network-interface"])
    error_message = "the resource types are not instance, volume and network-interface"
  }
}

# AC-11: what the group launches is tagged with project, lab and Name (the janitor sees it)
run "ac11_tag_specification_tags" {
  command = plan

  assert {
    condition = alltrue([
      for type in ["instance", "volume", "network-interface"] :
      one([for t in aws_launch_template.web.tag_specifications : t.tags["project"] if t.resource_type == type]) == "saa-c03-field-guide"
    ])
    error_message = "a tag specification lacks project = saa-c03-field-guide"
  }

  assert {
    condition = alltrue([
      for type in ["instance", "volume", "network-interface"] :
      one([for t in aws_launch_template.web.tag_specifications : t.tags["lab"] if t.resource_type == type]) == "04-alb-asg-self-healing"
    ])
    error_message = "a tag specification lacks lab = 04-alb-asg-self-healing"
  }

  assert {
    condition = alltrue([
      for type in ["instance", "volume", "network-interface"] :
      one([for t in aws_launch_template.web.tag_specifications : t.tags["Name"] if t.resource_type == type]) == "fg-lab04-web"
    ])
    error_message = "a tag specification lacks Name = fg-lab04-web"
  }
}

# AC-12: the group is named and sized 2 / 4 / 2 with ELB health checks and a 120 s grace period
run "ac12_group_size_and_health" {
  command = plan

  assert {
    condition     = aws_autoscaling_group.web.name == "fg-lab04-web"
    error_message = "the group is not named fg-lab04-web"
  }

  assert {
    condition     = aws_autoscaling_group.web.min_size == 2
    error_message = "min_size is not 2"
  }

  assert {
    condition     = aws_autoscaling_group.web.max_size == 4
    error_message = "max_size is not 4"
  }

  assert {
    condition     = aws_autoscaling_group.web.desired_capacity == 2
    error_message = "desired_capacity is not 2"
  }

  assert {
    condition     = aws_autoscaling_group.web.health_check_type == "ELB"
    error_message = "health_check_type is not ELB"
  }

  assert {
    condition     = aws_autoscaling_group.web.health_check_grace_period == 120
    error_message = "health_check_grace_period is not 120"
  }
}

# AC-12: the group lives in the two private subnets, registers with the target group and uses the template
run "ac12_group_wiring" {
  command = plan

  assert {
    condition     = length(aws_autoscaling_group.web.vpc_zone_identifier) == 2
    error_message = "the group must be in exactly two subnets"
  }

  assert {
    condition     = aws_autoscaling_group.web.vpc_zone_identifier == toset(["subnet-0123456789abcdef2", "subnet-0123456789abcdef3"])
    error_message = "the group is not in exactly the two private subnets"
  }

  assert {
    condition     = aws_autoscaling_group.web.target_group_arns == toset(["arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/fg-lab04-web/0123456789abcdef"])
    error_message = "the group must register with the target group only"
  }

  assert {
    condition     = length(aws_autoscaling_group.web.launch_template) == 1
    error_message = "the group must have exactly one launch_template block"
  }

  assert {
    condition     = one(aws_autoscaling_group.web.launch_template).id == "lt-0123456789abcdef0"
    error_message = "the group does not use the launch template"
  }
}

# AC-12: the group's own tags are project, lab and Name, none of them propagated at launch
run "ac12_group_tags" {
  command = plan

  assert {
    condition     = length(aws_autoscaling_group.web.tag) == 3
    error_message = "the group must have exactly three tags"
  }

  assert {
    condition = { for t in aws_autoscaling_group.web.tag : t.key => t.value } == {
      project = "saa-c03-field-guide"
      lab     = "04-alb-asg-self-healing"
      Name    = "fg-lab04-web"
    }
    error_message = "the group tags are not project, lab and Name with the expected values"
  }

  assert {
    condition     = alltrue([for t in aws_autoscaling_group.web.tag : t.propagate_at_launch == false])
    error_message = "a group tag is propagated at launch (the launch template tags what the group launches)"
  }
}

# AC-13: the ten outputs equal the overridden or computed values
run "ac13_outputs" {
  command = plan

  assert {
    condition     = output.vpc_id == "vpc-0123456789abcdef0"
    error_message = "output vpc_id is not the VPC ID"
  }

  assert {
    condition     = output.availability_zones == "eu-west-1a eu-west-1b"
    error_message = "output availability_zones is not 'eu-west-1a eu-west-1b'"
  }

  assert {
    condition     = output.alb_arn == "arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/app/fg-lab04-web/0123456789abcdef"
    error_message = "output alb_arn is not the load balancer ARN"
  }

  assert {
    condition     = output.alb_dns_name == "fg-lab04-web-1234567890.eu-west-1.elb.amazonaws.com"
    error_message = "output alb_dns_name is not the load balancer DNS name"
  }

  assert {
    condition     = output.target_group_arn == "arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/fg-lab04-web/0123456789abcdef"
    error_message = "output target_group_arn is not the target group ARN"
  }

  assert {
    condition     = output.asg_name == "fg-lab04-web"
    error_message = "output asg_name is not the group name"
  }

  assert {
    condition     = output.alb_security_group_id == "sg-0123456789abcdef1"
    error_message = "output alb_security_group_id is not the load balancer group ID"
  }

  assert {
    condition     = output.web_security_group_id == "sg-0123456789abcdef2"
    error_message = "output web_security_group_id is not the web group ID"
  }

  assert {
    condition     = output.private_subnet_ids == "subnet-0123456789abcdef2 subnet-0123456789abcdef3"
    error_message = "output private_subnet_ids is not the two private subnet IDs joined by a space"
  }

  assert {
    condition     = output.private_route_table_id == "rtb-0123456789abcdef2"
    error_message = "output private_route_table_id is not the private route table ID"
  }
}

# AC-32: the group uses the launch template version AWS reports as the latest one (a run-level override
# gives the template latest_version 7, so "1" or "$Default" in the group would fail)
run "ac32_group_uses_the_latest_template_version" {
  command = plan

  override_resource {
    target          = aws_launch_template.web
    override_during = plan
    values = {
      id             = "lt-0123456789abcdef0"
      latest_version = 7
    }
  }

  assert {
    condition     = one(aws_autoscaling_group.web.launch_template).id == "lt-0123456789abcdef0"
    error_message = "the group does not use the launch template"
  }

  assert {
    condition     = one(aws_autoscaling_group.web.launch_template).version == "7"
    error_message = "the group's launch template version is not the template's latest_version (7)"
  }
}
