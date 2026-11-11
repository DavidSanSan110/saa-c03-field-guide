# The instances' group has no inline rules and no separate outbound rule, on purpose. Terraform
# removes the allow-all outbound rule AWS adds to a new group, and nothing replaces it. Security groups
# are stateful, so the replies to the load balancer's requests and health checks still leave on the same
# connection; the instance metadata service is link-local and needs no rule either.
resource "aws_security_group" "web" {
  name        = "fg-lab04-web"
  description = "Instances of lab 04"
  vpc_id      = aws_vpc.lab.id
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  #checkov:skip=CKV_AWS_260:False positive: the source is the load balancer group, not 0.0.0.0/0.
  security_group_id            = aws_security_group.web.id
  description                  = "HTTP from the load balancer."
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.alb.id
}

# No key pair and no instance role: nobody logs in, and the instances call no AWS API. The tags are set
# here because default tags are not copied to what an Auto Scaling group launches.
resource "aws_launch_template" "web" {
  name                   = "fg-lab04-web"
  image_id               = data.aws_ami.al2023_arm64.id
  instance_type          = local.instance_type
  vpc_security_group_ids = [aws_security_group.web.id]
  user_data              = base64encode(file("${path.module}/user-data.sh"))
  update_default_version = true
  ebs_optimized          = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  monitoring {
    enabled = false
  }

  credit_specification {
    cpu_credits = "unlimited"
  }

  block_device_mappings {
    device_name = data.aws_ami.al2023_arm64.root_device_name

    ebs {
      encrypted             = true
      volume_type           = "gp3"
      volume_size           = 8
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags          = merge(module.tags.tags, { Name = local.name })
  }

  tag_specifications {
    resource_type = "volume"
    tags          = merge(module.tags.tags, { Name = local.name })
  }

  tag_specifications {
    resource_type = "network-interface"
    tags          = merge(module.tags.tags, { Name = local.name })
  }

  lifecycle {
    ignore_changes = [image_id]
  }
}

# The group waits for the listener: a target group that no listener uses is never health-checked.
resource "aws_autoscaling_group" "web" {
  name                      = "fg-lab04-web"
  min_size                  = 2
  max_size                  = 4
  desired_capacity          = 2
  vpc_zone_identifier       = aws_subnet.private[*].id
  target_group_arns         = [aws_lb_target_group.web.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 120

  launch_template {
    id      = aws_launch_template.web.id
    version = aws_launch_template.web.latest_version
  }

  dynamic "tag" {
    for_each = merge(module.tags.tags, { Name = local.name })

    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = false
    }
  }

  depends_on = [aws_lb_listener.http]
}
