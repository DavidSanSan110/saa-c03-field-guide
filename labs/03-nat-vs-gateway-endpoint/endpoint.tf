# The S3 gateway endpoint: free, and in the route table of the private subnet. It adds a route whose
# destination is the managed prefix list of S3 in this Region and whose target is the endpoint. That
# route is more specific than 0.0.0.0/0, so S3 traffic of the private subnet takes it and does not use
# the NAT gateway.
#
# An endpoint policy never grants anything: it narrows what can pass through the endpoint. It applies
# only to traffic that uses the endpoint, so a request over another path (the NAT gateway, for
# example) is not limited by it. Here it lets the data bucket through and nothing else. The role of
# the instance may read the other bucket, so the refusal for that bucket comes from this policy.
locals {
  endpoint_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "OnlyTheLabDataBucket"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["s3:GetObject", "s3:ListBucket", "s3:PutObject"]
        Resource  = [local.data_bucket_arn, "${local.data_bucket_arn}/*"]
      },
    ]
  }
}

# No route table is given here: the association below adds the private table and only that one.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.lab.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  policy            = jsonencode(local.endpoint_policy)

  tags = {
    Name = "fg-lab03-s3"
  }
}

# The public table is not associated, so the NAT gateway (in the public subnet) keeps using the
# internet gateway for S3.
resource "aws_vpc_endpoint_route_table_association" "s3_private" {
  vpc_endpoint_id = aws_vpc_endpoint.s3.id
  route_table_id  = aws_route_table.private.id
}
