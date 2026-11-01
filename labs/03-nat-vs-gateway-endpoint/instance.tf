# The private instance of the diagram: no public IP, no key pair, no inbound rule. You reach it with
# Systems Manager (Session Manager and Run Command). The SSM Agent on the instance opens the
# connection itself, outbound over HTTPS to the ssm, ssmmessages and ec2messages services, and it
# gets there through the NAT gateway.
#
# The role needs the path /lab/ and the fg-workload-boundary permissions boundary: the boundary denies
# every role write, PassRole and AssumeRole outside arn:aws:iam::<account>:role/lab/*, and refuses to
# create a role without itself. Neither the boundary nor the service control policy of the
# organization names an S3 action on these buckets, so the refusals the lab shows come from the
# endpoint policy (endpoint.tf) and the bucket policy (buckets.tf).
locals {
  instance_trust = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Ec2Service"
        Effect    = "Allow"
        Principal = { Service = "ec2.amazonaws.com" }
        Action    = "sts:AssumeRole"
      },
    ]
  }

  # The role allows BOTH buckets on purpose, so that a refusal of the other bucket cannot come from
  # IAM. Only the endpoint policy tells the two buckets apart.
  instance_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListBuckets"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = [local.data_bucket_arn, local.other_bucket_arn]
      },
      {
        Sid      = "ReadWriteObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = ["${local.data_bucket_arn}/*", "${local.other_bucket_arn}/*"]
      },
    ]
  }
}

resource "aws_iam_role" "instance" {
  name        = "fg-lab03-instance"
  path        = "/lab/"
  description = "Lab 03: the private instance. Systems Manager through the NAT gateway, S3 through the gateway endpoint."

  assume_role_policy   = jsonencode(local.instance_trust)
  permissions_boundary = local.boundary_arn

  # IAM's minimum.
  max_session_duration = 3600
}

# What the SSM Agent needs: UpdateInstanceInformation, the ssmmessages channels and the ec2messages
# calls of Run Command.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "instance" {
  name   = "use-lab-buckets"
  role   = aws_iam_role.instance.name
  policy = jsonencode(local.instance_policy)
}

resource "aws_iam_instance_profile" "instance" {
  name = "fg-lab03-instance"
  role = aws_iam_role.instance.name
}

# No inline rule and no inbound rule: nothing can start a connection to the instance.
resource "aws_security_group" "instance" {
  name        = "fg-lab03-instance"
  description = "Lab 03 private instance: outbound HTTPS only, no inbound rule."
  vpc_id      = aws_vpc.lab.id
}

# Port 443 to anywhere. It covers the Systems Manager names (through the NAT gateway) and the S3
# prefix list (through the endpoint) alike.
resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.instance.id
  description       = "HTTPS to the Systems Manager services and to S3."
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_instance" "private" {
  #checkov:skip=CKV_AWS_126:Detailed monitoring costs money and the lab reads no instance metric.
  ami                         = data.aws_ami.al2023_arm64.id
  instance_type               = local.instance_type
  subnet_id                   = aws_subnet.private.id
  vpc_security_group_ids      = [aws_security_group.instance.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  associate_public_ip_address = false
  ebs_optimized               = true
  monitoring                  = false

  # IMDSv2 only, and one hop: a container on the instance could not reach the metadata service.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # The account default encryption of bootstrap/workload covers eu-west-1 only, so the volume asks
  # for encryption itself.
  root_block_device {
    encrypted             = true
    volume_type           = "gp3"
    volume_size           = 8
    delete_on_termination = true
  }

  # A burstable instance that runs out of credits stays slow instead of charging for surplus credits.
  credit_specification {
    cpu_credits = "standard"
  }

  tags = {
    Name = "fg-lab03-private"
  }

  # The agent has a way out and its permission when it starts, so it registers at once.
  depends_on = [
    aws_route.private_nat,
    aws_vpc_endpoint_route_table_association.s3_private,
    aws_iam_role_policy_attachment.ssm_core,
  ]

  lifecycle {
    # A new image never replaces the instance on a later plan.
    ignore_changes = [ami]
  }
}
