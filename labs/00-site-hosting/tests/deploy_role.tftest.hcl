# Tests for labs/00-site-hosting (spec 035): the GitHub deploy role (AC-37, AC-38, AC-39, AC-40).
# All runs use command = plan with mock providers, so nothing touches AWS.
#
# Policies are jsonencode() of locals, so they are asserted on jsondecode(<resource>.policy). The
# distribution ARN only exists after creation, so it is overridden during plan.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

override_resource {
  target          = aws_cloudfront_distribution.site
  override_during = plan
  values = {
    arn            = "arn:aws:cloudfront::111111111111:distribution/E2EXAMPLE12345"
    domain_name    = "d111111abcdef8.cloudfront.net"
    hosted_zone_id = "Z0123456789EXAMPLE"
    id             = "E2EXAMPLE12345"
  }
}

override_resource {
  target          = aws_iam_role.deploy
  override_during = plan
  values = {
    arn = "arn:aws:iam::111111111111:role/lab/fg-site-deploy"
  }
}

variables {
  github_sub_prefix = "repo:your-user/saa-c03-field-guide"
}

# AC-37: name, path, permissions boundary and session length
run "ac37_role_basics" {
  command = plan

  assert {
    condition     = aws_iam_role.deploy.name == "fg-site-deploy"
    error_message = "the role name is not 'fg-site-deploy'"
  }

  assert {
    condition     = aws_iam_role.deploy.path == "/lab/"
    error_message = "the role path is not '/lab/'"
  }

  assert {
    condition     = aws_iam_role.deploy.permissions_boundary == "arn:aws:iam::111111111111:policy/fg-workload-boundary"
    error_message = "the permissions boundary is not arn:aws:iam::<account_id>:policy/fg-workload-boundary"
  }

  assert {
    condition     = aws_iam_role.deploy.max_session_duration == 3600
    error_message = "max_session_duration is not 3600"
  }

  assert {
    condition     = strcontains(aws_iam_role.deploy.description, "deploy.yml")
    error_message = "the role description must say it is for deploy.yml"
  }
}

# AC-38: one trust statement, for the GitHub OIDC provider, for the production environment only
run "ac38_trust_policy" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role.deploy.assume_role_policy).Statement) == 1
    error_message = "the trust policy must have exactly one statement"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.deploy.assume_role_policy).Statement : s.Effect == "Allow" && try(s.Principal, null) == { Federated = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com" } && flatten([s.Action]) == ["sts:AssumeRoleWithWebIdentity"] && !contains(keys(s), "NotAction") && !contains(keys(s), "NotPrincipal") && !contains(keys(s), "Resource")])
    error_message = "the trust statement must be an Allow for Principal exactly { Federated = <OIDC provider ARN> } with Action sts:AssumeRoleWithWebIdentity"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.deploy.assume_role_policy).Statement : keys(s.Condition) == ["StringEquals"] && toset(keys(s.Condition.StringEquals)) == toset(["token.actions.githubusercontent.com:aud", "token.actions.githubusercontent.com:sub"])])
    error_message = "the Condition must be exactly StringEquals with the aud and sub keys (no StringLike)"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.deploy.assume_role_policy).Statement : flatten([s.Condition.StringEquals["token.actions.githubusercontent.com:aud"]]) == ["sts.amazonaws.com"]])
    error_message = "the aud condition must be exactly 'sts.amazonaws.com'"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.deploy.assume_role_policy).Statement : s.Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:your-user/saa-c03-field-guide:environment:production"])
    error_message = "the sub condition must be the single string '<github_sub_prefix>:environment:production'"
  }

  assert {
    condition     = !strcontains(aws_iam_role.deploy.assume_role_policy, "*")
    error_message = "the trust policy must not contain a wildcard"
  }
}

# AC-38: a repository with immutable IDs keeps its prefix as it is
run "ac38_trust_policy_with_immutable_ids" {
  command = plan

  variables {
    github_sub_prefix = "repo:example-owner@1000/example-repo@2000"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role.deploy.assume_role_policy).Statement : s.Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example-owner@1000/example-repo@2000:environment:production"])
    error_message = "the sub condition must be '<github_sub_prefix>:environment:production' for an immutable-ID prefix too"
  }
}

# AC-39: the inline policy has exactly the three statements of the spec
run "ac39_inline_policy_statements" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.deploy.name == "deploy-site"
    error_message = "the inline policy name is not 'deploy-site'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.deploy.policy).Statement) == 3
    error_message = "the inline policy must have exactly three statements"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s.Effect == "Allow" && !contains(keys(s), "NotAction") && !contains(keys(s), "NotResource")])
    error_message = "every statement must be a plain Allow (no NotAction, no NotResource)"
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s if toset(flatten([s.Action])) == toset(["s3:ListBucket"]) && flatten([s.Resource]) == ["arn:aws:s3:::field-guide-site-111111111111"]]) == 1
    error_message = "there must be one statement that allows exactly s3:ListBucket on the site bucket ARN"
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s if toset(flatten([s.Action])) == toset(["s3:PutObject", "s3:DeleteObject"]) && flatten([s.Resource]) == ["arn:aws:s3:::field-guide-site-111111111111/*"]]) == 1
    error_message = "there must be one statement that allows exactly s3:PutObject and s3:DeleteObject on <site bucket ARN>/*"
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : s if toset(flatten([s.Action])) == toset(["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]) && flatten([s.Resource]) == [aws_cloudfront_distribution.site.arn]]) == 1
    error_message = "there must be one statement that allows exactly cloudfront:CreateInvalidation and cloudfront:GetInvalidation on the distribution ARN"
  }
}

# AC-39: no wildcard in any action, and none in a resource except the object suffix of the site bucket
run "ac39_inline_policy_has_no_wildcards" {
  command = plan

  assert {
    condition     = alltrue([for a in flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : flatten([s.Action])]) : !strcontains(a, "*")])
    error_message = "no action of the inline policy may contain '*'"
  }

  assert {
    condition     = [for r in flatten([for s in jsondecode(aws_iam_role_policy.deploy.policy).Statement : flatten([s.Resource])]) : r if strcontains(r, "*")] == ["arn:aws:s3:::field-guide-site-111111111111/*"]
    error_message = "the only resource with '*' must be <site bucket ARN>/*"
  }
}

# AC-40: the deploy_role_arn output is the role ARN
run "ac40_deploy_role_arn_output" {
  command = plan

  assert {
    condition     = output.deploy_role_arn == aws_iam_role.deploy.arn
    error_message = "output deploy_role_arn is not the role ARN"
  }

  assert {
    condition     = output.deploy_role_arn == "arn:aws:iam::111111111111:role/lab/fg-site-deploy"
    error_message = "output deploy_role_arn is not arn:aws:iam::<account_id>:role/lab/fg-site-deploy"
  }
}
