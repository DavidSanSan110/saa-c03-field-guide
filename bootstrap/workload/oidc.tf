# GitHub Actions as an OpenID Connect identity provider. AWS validates the token against GitHub's
# certificate chain, so no thumbprint is set. Who may use it is decided by the trust policies of the
# CI roles (ci_roles.tf). One provider per account: creation fails if the account already has one.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}
