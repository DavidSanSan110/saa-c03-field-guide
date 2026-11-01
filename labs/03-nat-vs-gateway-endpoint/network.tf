# The network of the vpc-nat-vs-gateway-endpoint diagram: one VPC with a public and a private subnet
# in one Availability Zone. The public table sends internet traffic to the internet gateway. The
# private table sends it to the NAT gateway, and S3 traffic to the gateway endpoint (endpoint.tf) by a
# more specific route that the endpoint adds.

resource "aws_vpc" "lab" {
  #checkov:skip=CKV2_AWS_11:VPC flow logs cost money, and the lab proves the path another way (the NAT gateway's bytes and aws:SourceVpce).
  cidr_block = local.vpc_cidr

  # Both are needed for Amazon's DNS: the S3 and Systems Manager names resolve through it.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "fg-lab03"
  }
}

# The default security group of the VPC has no rule at all, so nothing can use it by accident.
resource "aws_default_security_group" "lab" {
  vpc_id = aws_vpc.lab.id
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = local.public_cidr
  availability_zone       = local.availability_zone
  map_public_ip_on_launch = false

  tags = {
    Name = "fg-lab03-public"
  }
}

resource "aws_subnet" "private" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = local.private_cidr
  availability_zone       = local.availability_zone
  map_public_ip_on_launch = false

  tags = {
    Name = "fg-lab03-private"
  }
}

# The tables have no inline route block: every route is its own resource, and the endpoint adds its
# own route to the private table. An inline block would make Terraform delete that route.
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id

  tags = {
    Name = "fg-lab03-public"
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.lab.id

  tags = {
    Name = "fg-lab03-private"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.lab.id
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.lab.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

# The public address of the NAT gateway. An address that is in use costs money by the hour too.
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name = "fg-lab03-nat"
  }

  # The address can be used only once the VPC has an internet gateway.
  depends_on = [aws_internet_gateway.lab]
}

# Bills by the hour from here until destroyed, plus a charge for every GB it processes. It sits in the
# public subnet, because it needs a route to the internet gateway of its own.
resource "aws_nat_gateway" "lab" {
  allocation_id     = aws_eip.nat.id
  subnet_id         = aws_subnet.public.id
  connectivity_type = "public"

  tags = {
    Name = "fg-lab03"
  }

  # AWS needs the internet gateway first. On destroy the NAT gateway has to go first: the internet
  # gateway cannot be detached while the VPC still has public IP addresses mapped.
  depends_on = [aws_internet_gateway.lab]
}
