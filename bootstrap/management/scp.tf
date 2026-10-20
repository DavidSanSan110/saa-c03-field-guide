locals {
  allowed_regions = ["eu-west-1", "us-east-1"]

  # Global services, which have no Region of their own (or live in us-east-1), are exempt from the
  # Region guard. The list follows AWS's documented Region-deny example, keeping the global services
  # only: regional services (kms, acm, config, ...) stay inside the allowed Regions.
  global_service_actions = [
    "account:*",
    "aws-marketplace-management:*",
    "aws-marketplace:*",
    "aws-portal:*",
    "budgets:*",
    "ce:*",
    "cloudfront:*",
    "cur:*",
    "ec2:DescribeRegions",
    "globalaccelerator:*",
    "health:*",
    "iam:*",
    "importexport:*",
    "networkmanager:*",
    "organizations:*",
    "pricing:*",
    "route53-recovery-cluster:*",
    "route53-recovery-control-config:*",
    "route53-recovery-readiness:*",
    "route53:*",
    "route53domains:*",
    "s3:GetAccountPublic*",
    "s3:ListAllMyBuckets",
    "s3:PutAccountPublic*",
    "shield:*",
    "sts:*",
    "support:*",
    "trustedadvisor:*",
    "waf:*",
    "wafv2:*",
  ]

  # Deny statements only: FullAWSAccess stays attached, so everything else is still allowed.
  guardrails_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyOutsideAllowedRegions"
        Effect    = "Deny"
        NotAction = local.global_service_actions
        Resource  = "*"
        Condition = {
          StringNotEquals = { "aws:RequestedRegion" = local.allowed_regions }
        }
      },
      {
        Sid    = "DenyIamUsersAndKeys"
        Effect = "Deny"
        Action = [
          "iam:CreateUser",
          "iam:CreateAccessKey",
          "iam:CreateLoginProfile",
          "iam:UpdateLoginProfile",
        ]
        Resource = "*"
      },
      {
        Sid    = "DenyCloudTrailChanges"
        Effect = "Deny"
        Action = [
          "cloudtrail:StopLogging",
          "cloudtrail:DeleteTrail",
          "cloudtrail:UpdateTrail",
          "cloudtrail:PutEventSelectors",
          "cloudtrail:PutInsightSelectors",
        ]
        Resource = "*"
      },
      {
        Sid      = "DenyLeavingOrganization"
        Effect   = "Deny"
        Action   = "organizations:LeaveOrganization"
        Resource = "*"
      },
    ]
  }

  # The account to attach the SCP to, found by name among the member accounts.
  workload_accounts = [
    for account in aws_organizations_organization.this.non_master_accounts :
    account if account.name == var.workload_account_name
  ]
}

resource "aws_organizations_policy" "guardrails" {
  name        = "field-guide-guardrails"
  description = "Guardrails for the field-guide workload account: allowed Regions, no IAM users or keys, no CloudTrail changes, no leaving the Organization."
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode(local.guardrails_policy)

  # The SCP policy type must be enabled on the root first.
  depends_on = [aws_organizations_organization.this]
}

resource "aws_organizations_policy_attachment" "guardrails_workload" {
  policy_id = aws_organizations_policy.guardrails.id
  target_id = local.workload_accounts[0].id

  lifecycle {
    # Terraform checks preconditions before it evaluates the arguments above.
    precondition {
      condition     = length(local.workload_accounts) == 1
      error_message = "Expected exactly one member account named '${var.workload_account_name}' in the Organization, found ${length(local.workload_accounts)}. Fix workload_account_name or the account names."
    }
  }
}
