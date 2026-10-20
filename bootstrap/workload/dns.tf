# The public hosted zone of the site, created only when hosted_zone_name is set. Lab 00 adds its
# records (certificate validation, the site alias) to this zone.
# Its four name server values are typed into the parent DNS zone by hand (see the README), so the zone
# must never be recreated: a new zone gets new name servers.
resource "aws_route53_zone" "site" {
  #checkov:skip=CKV2_AWS_38:DNSSEC signing needs a KMS key (monthly fee) and a DS record at the parent; not needed for a study site.
  #checkov:skip=CKV2_AWS_39:Query logging needs a CloudWatch log group in us-east-1 with a resource policy; cost and scope for a study site.
  count = var.hosted_zone_name == null ? 0 : 1

  name = var.hosted_zone_name

  lifecycle {
    prevent_destroy = true
  }
}
