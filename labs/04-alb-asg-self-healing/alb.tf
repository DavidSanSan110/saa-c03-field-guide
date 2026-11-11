resource "aws_security_group" "alb" {
  name        = "fg-lab04-alb"
  description = "Load balancer of lab 04"
  vpc_id      = aws_vpc.lab.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  #checkov:skip=CKV_AWS_260:Public HTTP on purpose; no certificate or domain in this lab.
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from anywhere."
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  description                  = "HTTP to the instances."
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.web.id
}

resource "aws_lb" "web" {
  #checkov:skip=CKV_AWS_91:Access logs need a bucket and cost money; the lab reads no log.
  #checkov:skip=CKV_AWS_150:Deletion protection would block the destroy this lab ends with.
  #checkov:skip=CKV2_AWS_20:No certificate, so the listener cannot redirect to HTTPS.
  #checkov:skip=CKV2_AWS_28:A web ACL bills by the month; the page holds an instance ID and an AZ.
  name                       = "fg-lab04-web"
  load_balancer_type         = "application"
  internal                   = false
  ip_address_type            = "ipv4"
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = false
  enable_zonal_shift         = true

  depends_on = [aws_route.public_internet]
}

resource "aws_lb_target_group" "web" {
  #checkov:skip=CKV_AWS_378:The ALB reaches the instances over HTTP inside the VPC; no certificate on them.
  name                 = "fg-lab04-web"
  port                 = 80
  protocol             = "HTTP"
  target_type          = "instance"
  vpc_id               = aws_vpc.lab.id
  deregistration_delay = 30

  health_check {
    enabled             = true
    protocol            = "HTTP"
    path                = "/"
    port                = "traffic-port"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200"
  }
}

resource "aws_lb_listener" "http" {
  #checkov:skip=CKV_AWS_2:No domain or certificate, so the listener is plain HTTP.
  #checkov:skip=CKV_AWS_103:An HTTP listener has no TLS policy.
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}
