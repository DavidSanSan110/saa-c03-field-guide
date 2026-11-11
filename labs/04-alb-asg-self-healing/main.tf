module "tags" {
  source = "../../modules/tags"

  lab = "04-alb-asg-self-healing"
}

data "aws_ami" "al2023_arm64" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-arm64"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}

data "aws_ec2_instance_type_offerings" "nano" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [local.instance_type]
  }
}

locals {
  instance_type      = "t4g.nano"
  availability_zones = slice(sort(data.aws_ec2_instance_type_offerings.nano.locations), 0, 2)
  vpc_cidr           = "10.40.0.0/16"
  public_cidrs       = ["10.40.0.0/24", "10.40.1.0/24"]
  private_cidrs      = ["10.40.10.0/24", "10.40.11.0/24"]
  name               = "fg-lab04-web"
}
