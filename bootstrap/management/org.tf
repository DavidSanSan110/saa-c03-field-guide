# The AWS Organization already exists: import it before the first apply (see the README).
# Trusted access is kept for the two services already in use (iam, sso) and added for cloudtrail,
# which the organization trail needs.
resource "aws_organizations_organization" "this" {
  feature_set          = "ALL"
  enabled_policy_types = ["SERVICE_CONTROL_POLICY"]

  aws_service_access_principals = [
    "cloudtrail.amazonaws.com",
    "iam.amazonaws.com",
    "sso.amazonaws.com",
  ]

  lifecycle {
    prevent_destroy = true
  }
}
