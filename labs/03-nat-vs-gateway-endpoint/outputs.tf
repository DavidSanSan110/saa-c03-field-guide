output "vpc_id" {
  description = "ID of the lab VPC."
  value       = aws_vpc.lab.id
}

output "public_route_table_id" {
  description = "ID of the public route table: 0.0.0.0/0 goes to the internet gateway."
  value       = aws_route_table.public.id
}

output "private_route_table_id" {
  description = "ID of the private route table: 0.0.0.0/0 goes to the NAT gateway, and the S3 prefix list goes to the gateway endpoint."
  value       = aws_route_table.private.id
}

output "nat_gateway_id" {
  description = "ID of the NAT gateway. It bills by the hour and by the GB until the lab is destroyed."
  value       = aws_nat_gateway.lab.id
}

output "nat_public_ip" {
  description = "Public IP address of the NAT gateway: the address the internet sees for the private instance."
  value       = aws_eip.nat.public_ip
}

output "s3_endpoint_id" {
  description = "ID of the S3 gateway endpoint. The bucket policy accepts reads under endpoint-only/ only from this endpoint."
  value       = aws_vpc_endpoint.s3.id
}

output "instance_id" {
  description = "ID of the private instance: reach it with Systems Manager, there is no SSH."
  value       = aws_instance.private.id
}

output "instance_security_group_id" {
  description = "ID of the security group of the private instance. It has no inbound rule."
  value       = aws_security_group.instance.id
}

output "instance_role_arn" {
  description = "ARN of the role of the private instance. It may read and write both buckets."
  value       = aws_iam_role.instance.arn
}

output "data_bucket_name" {
  description = "Name of the data bucket: the endpoint policy lets it through, and objects under endpoint-only/ can be read only through the endpoint."
  value       = local.data_bucket_name
}

output "other_bucket_name" {
  description = "Name of the other bucket: the role may read it, and the endpoint policy refuses it."
  value       = local.other_bucket_name
}
