output "vpc_id" {
  description = "ID of the lab VPC."
  value       = aws_vpc.lab.id
}

output "availability_zones" {
  description = "The two AZs the lab uses, separated by a space."
  value       = join(" ", local.availability_zones)
}

output "alb_arn" {
  description = "ARN of the Application Load Balancer. It bills by the hour until the lab is destroyed."
  value       = aws_lb.web.arn
}

output "alb_dns_name" {
  description = "DNS name of the load balancer: curl it over plain HTTP."
  value       = aws_lb.web.dns_name
}

output "target_group_arn" {
  description = "ARN of the target group the instances register in."
  value       = aws_lb_target_group.web.arn
}

output "asg_name" {
  description = "Name of the Auto Scaling group: two to four instances in the private subnets."
  value       = aws_autoscaling_group.web.name
}

output "alb_security_group_id" {
  description = "ID of the load balancer's security group: HTTP in from anywhere, HTTP out to the instances only."
  value       = aws_security_group.alb.id
}

output "web_security_group_id" {
  description = "ID of the instances' security group: HTTP in from the load balancer, no egress rule."
  value       = aws_security_group.web.id
}

output "private_subnet_ids" {
  description = "IDs of the two private subnets, separated by a space."
  value       = join(" ", aws_subnet.private[*].id)
}

output "private_route_table_id" {
  description = "ID of the private route table: it holds only the local route, so nothing leaves the VPC."
  value       = aws_route_table.private.id
}
