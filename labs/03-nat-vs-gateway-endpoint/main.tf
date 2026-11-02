module "tags" {
  source = "../../modules/tags"

  lab = "03-nat-vs-gateway-endpoint"
}

# The account ID is read at plan time and never typed anywhere. Only account_id is used.
data "aws_caller_identity" "current" {}

# The newest standard Amazon Linux 2023 image for arm64. The SSM Agent and the AWS CLI are installed
# on it. The name pattern leaves out the minimal image (no agent) and the ECS one.
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

# The Availability Zones that offer the instance type. Not every zone does, so the lab never takes a
# zone from a list it typed by hand.
data "aws_ec2_instance_type_offerings" "nano" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [local.instance_type]
  }
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = "us-east-1"

  # Created by bootstrap/workload: the boundary every lab role must carry. The lab can only attach
  # it, never create or change it.
  boundary_arn = "arn:aws:iam::${local.account_id}:policy/fg-workload-boundary"

  # The cheapest type with an ARM CPU. Credits stay on standard (see instance.tf).
  instance_type = "t4g.nano"

  # The first zone, in sorted order, that offers the instance type. One zone is enough: the lab shows
  # a path, not high availability.
  availability_zone = sort(data.aws_ec2_instance_type_offerings.nano.locations)[0]

  vpc_cidr     = "10.30.0.0/16"
  public_cidr  = "10.30.0.0/24"
  private_cidr = "10.30.1.0/24"

  # Everything below is built from the account ID alone, so every name and ARN is known at plan time.
  data_bucket_name  = "field-guide-lab03-data-${local.account_id}"
  data_bucket_arn   = "arn:aws:s3:::${local.data_bucket_name}"
  other_bucket_name = "field-guide-lab03-other-${local.account_id}"
  other_bucket_arn  = "arn:aws:s3:::${local.other_bucket_name}"

  # Objects under this prefix of the data bucket can be read only through the gateway endpoint.
  endpoint_only_prefix = "endpoint-only/"
}
