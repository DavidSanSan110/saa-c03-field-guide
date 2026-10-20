# The deny statements that stop CI (and any role a lab creates) from escalating privileges or turning
# off the account guardrails. The same statements are used twice, from the same locals:
#   - in the fg-workload-boundary permissions boundary, which every role created by a lab must carry;
#   - in the inline policy of the tf-apply role (ci_roles.tf), which cannot carry the boundary itself
#     because the boundary denies all state bucket access and tf-apply needs the labs/* keys.
locals {
  # A role may only be created or changed together with the boundary, so the boundary spreads.
  deny_role_changes_without_boundary = {
    Sid    = "DenyRoleChangesWithoutBoundary"
    Effect = "Deny"
    Action = [
      "iam:CreateRole",
      "iam:PutRolePermissionsBoundary",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    Resource = "*"
    Condition = {
      StringNotEquals = { "iam:PermissionsBoundary" = local.boundary_arn }
    }
  }

  deny_boundary_removal = {
    Sid      = "DenyBoundaryRemoval"
    Effect   = "Deny"
    Action   = "iam:DeleteRolePermissionsBoundary"
    Resource = "*"
  }

  # Everything except reading is denied on the CI roles, the organization access role, the boundary
  # policy and the OIDC provider: CI cannot widen its own access or open a new way in.
  deny_protected_iam_changes = {
    Sid       = "DenyProtectedIamChanges"
    Effect    = "Deny"
    NotAction = ["iam:Get*", "iam:List*"]
    Resource = [
      local.tf_plan_role_arn,
      local.tf_apply_role_arn,
      local.org_access_role_arn,
      local.boundary_arn,
      local.oidc_provider_arn,
    ]
  }

  # Long-lived credentials are never created: roles and SSO are the only ways in.
  deny_iam_users_and_keys = {
    Sid      = "DenyIamUsersAndKeys"
    Effect   = "Deny"
    Action   = ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile"]
    Resource = "*"
  }

  # The account guardrails of guardrails.tf stay on.
  deny_guardrail_changes = [
    {
      Sid      = "DenyGuardrailChanges"
      Effect   = "Deny"
      Action   = ["s3:PutAccountPublicAccessBlock", "ec2:DisableEbsEncryptionByDefault"]
      Resource = "*"
    },
    {
      Sid      = "DenyAccessAnalyzerDeletion"
      Effect   = "Deny"
      Action   = "access-analyzer:DeleteAnalyzer"
      Resource = local.analyzer_arn
    },
  ]

  escalation_denies = concat(
    [
      local.deny_role_changes_without_boundary,
      local.deny_boundary_removal,
      local.deny_protected_iam_changes,
      local.deny_iam_users_and_keys,
    ],
    local.deny_guardrail_changes,
  )
}

# A boundary only caps what a role's own policies grant, so the first statement allows everything and
# the denies do the work. Roles created by labs get it through permissions_boundary.
resource "aws_iam_policy" "boundary" {
  #checkov:skip=CKV_AWS_49:The boundary allows every action on purpose; it only caps, and the denies below do the work.
  #checkov:skip=CKV_AWS_62:A permissions boundary grants nothing by itself; the role's own policies decide what is allowed.
  #checkov:skip=CKV_AWS_63:A permissions boundary grants nothing by itself; the role's own policies decide what is allowed.
  #checkov:skip=CKV_AWS_286:A permissions boundary grants nothing by itself; privilege escalation is blocked by the deny statements.
  #checkov:skip=CKV_AWS_287:A permissions boundary grants nothing by itself; credential exposure is the role's own policy to grant.
  #checkov:skip=CKV_AWS_288:A permissions boundary grants nothing by itself; data exfiltration is the role's own policy to grant.
  #checkov:skip=CKV_AWS_289:A permissions boundary grants nothing by itself; permissions management is capped by the deny statements.
  #checkov:skip=CKV_AWS_290:A permissions boundary grants nothing by itself; write access is the role's own policy to grant.
  #checkov:skip=CKV_AWS_355:A permissions boundary grants nothing by itself; the allow on every resource is deliberate.
  #checkov:skip=CKV2_AWS_40:A permissions boundary grants nothing by itself; full IAM privileges are capped by the deny statements.
  name        = local.boundary_name
  path        = "/"
  description = "Permissions boundary for roles created by labs: no privilege escalation, no IAM users or keys, no access to Terraform state, guardrails stay on."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "AllowAll"
          Effect   = "Allow"
          Action   = "*"
          Resource = "*"
        },
      ],
      local.escalation_denies,
      [
        {
          # Lab roles never touch Terraform state.
          Sid      = "DenyStateBucket"
          Effect   = "Deny"
          Action   = "s3:*"
          Resource = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]
        },
      ],
    )
  })
}
