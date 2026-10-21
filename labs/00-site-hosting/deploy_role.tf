# The role that deploy.yml (issue #82) assumes through GitHub OIDC to upload the built site and
# invalidate the cache. It can only be assumed by jobs of the `production` environment of the
# repository, and it can write nothing but the site bucket and this distribution's invalidations.
locals {
  # The condition keys are written out (not built from local.oidc_host) so that static analysers
  # can read them. The sub is one exact string: no StringLike, no wildcard.
  deploy_trust = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "GitHubActionsDeploy"
        Effect    = "Allow"
        Principal = { Federated = local.oidc_provider_arn }
        Action    = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:sub" = "${var.github_sub_prefix}:environment:production"
          }
        }
      },
    ]
  }

  deploy_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListSiteBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = local.site_bucket_arn
      },
      {
        Sid      = "WriteSiteObjects"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = "${local.site_bucket_arn}/*"
      },
      {
        Sid      = "InvalidateCache"
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
        Resource = aws_cloudfront_distribution.site.arn
      },
    ]
  }
}

resource "aws_iam_role" "deploy" {
  name        = "fg-site-deploy"
  path        = "/lab/"
  description = "GitHub Actions: deploy.yml uploads the built site to its bucket and invalidates the CloudFront cache."

  assume_role_policy   = jsonencode(local.deploy_trust)
  permissions_boundary = local.boundary_arn

  # IAM's minimum; deploy.yml asks for 900 seconds when it logs in.
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy-site"
  role   = aws_iam_role.deploy.name
  policy = jsonencode(local.deploy_policy)
}
