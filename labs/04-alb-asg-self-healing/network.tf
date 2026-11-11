resource "aws_vpc" "lab" {
  #checkov:skip=CKV2_AWS_11:flow logs cost money
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "fg-lab04"
  }
}

resource "aws_default_security_group" "lab" {
  vpc_id = aws_vpc.lab.id
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id

  tags = {
    Name = "fg-lab04"
  }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = local.availability_zones[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name = "fg-lab04-public-${local.availability_zones[count.index]}"
  }
}

resource "aws_subnet" "private" {
  count                   = 2
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = local.private_cidrs[count.index]
  availability_zone       = local.availability_zones[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name = "fg-lab04-private-${local.availability_zones[count.index]}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id

  tags = {
    Name = "fg-lab04-public"
  }
}

# The private table gets no route of its own: only AWS's local route, so nothing leaves the VPC.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.lab.id

  tags = {
    Name = "fg-lab04-private"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.lab.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
