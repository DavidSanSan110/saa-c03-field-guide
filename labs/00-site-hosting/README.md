# labs/00-site-hosting

The site's own hosting, and the first lab a reader can deploy: a **private S3 bucket behind
CloudFront**, reached through an origin access control (OAC).

## What it creates

- the site bucket (private, versioned, encrypted, no ACLs, Block Public Access on) whose policy lets
  only this distribution read objects;
- a CloudFront distribution with a viewer-request CloudFront Function (directory index rewrite,
  trailing slash redirect, redirect from the `cloudfront.net` name to the custom domain), a response
  headers policy built from [`apps/site/headers.json`](../../apps/site/headers.json), HTTPS only, and
  the site's 404 page for missing files;
- CloudFront standard logs (v2) delivered to the lab's own log bucket, which expires them after 30
  days;
- optionally, a custom domain: an ACM certificate in `us-east-1`, its DNS validation records and the
  `A` and `AAAA` alias records in a Route 53 hosted zone you already have;
- the `fg-site-deploy` IAM role that the deploy workflow assumes through GitHub OIDC, from the
  `production` environment only. It can list and write the site bucket and invalidate this
  distribution, and nothing else.

Both buckets have `force_destroy = true`: the site is rebuilt from the repository and the logs are
disposable, so a destroy empties them.

## Inputs

Set them in `terraform.tfvars` for a local run (copy [`terraform.tfvars.example`](terraform.tfvars.example),
the file is git-ignored) or as repository Actions variables for CI.

| tfvars name         | Repository variable        | Default                           | Meaning                                                                                     |
| ------------------- | -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `github_sub_prefix` | `TF_VAR_GITHUB_SUB_PREFIX` | none, required                    | OIDC subject prefix of your repository, for example `repo:your-user/saa-c03-field-guide`.   |
| `domain_name`       | `TF_VAR_DOMAIN_NAME`       | `null`: the `cloudfront.net` name | Custom domain, for example `site.example.com`. Lowercase, at least two labels, no wildcard. |
| `hosted_zone_id`    | `TF_VAR_HOSTED_ZONE_ID`    | `null`                            | Route 53 hosted zone that holds the domain. Set it if and only if `domain_name` is set.     |

`headers_json` also exists, for the tests only: leave it unset, the stack reads `apps/site/headers.json`.

Without a domain the site is served at the `https://<id>.cloudfront.net` name the `site_url` output
prints, with the default certificate (CloudFront then allows no newer minimum TLS version than
`TLSv1`). With a domain it uses an ACM certificate and `TLSv1.2_2021`.

## How CI applies it

`infra.yml` is the only way this lab changes. A pull request gets a read-only plan as a comment
and a cost estimate. After the merge, the plan is repeated, you approve it in the `infra`
environment, and only the approved change set is applied. You can also dispatch `plan`, `apply`
or `destroy` for the lab on demand.

The `Export lab variables` step of `infra.yml` turns every repository variable named `TF_VAR_<NAME>`
into the Terraform input `<name>`, so no value is committed. Set `TF_VAR_*` on the repository, not on
an environment: the apply job also sees the variables of the `infra` environment, a different value
there changes the plan, and the digest check then refuses to apply. Never put secrets in `TF_VAR_*`
variables: the domain, the zone ID and the subject prefix are printed in the run log, and they are
not secret.

A change to `apps/site/headers.json` plans and applies this lab, because the headers policy is built
from that file. The plan fails, with a message that names the file, when one of the five security
headers is missing or has a value CloudFront would reject.

To run it from your own machine with an IAM Identity Center session for the workload account:

```bash
terraform init -backend-config="bucket=field-guide-tfstate-<ACCOUNT_ID>" \
  -backend-config="key=labs/00-site-hosting.tfstate"
terraform plan -out=tfplan
```

## Cost

Estimated with `infracost breakdown --path .`: **$0.00 per month** of fixed cost. Nothing here costs
money while idle: there is no NAT gateway, load balancer, Elastic IP or database. CloudFront, the
function and the buckets only bill for use: the always-free allowance of CloudFront (1 TB and 10
million requests a month) and of CloudFront Functions (2 million invocations) covers a study site,
and S3 storage for a few megabytes is a fraction of a cent. The log delivery to S3 is billed by
CloudWatch per GB of logs, which is cents at this traffic. A hosted zone costs $0.50 a month, but it
belongs to the bootstrap stack, not to this lab.

## Destroy

Dispatch `infra.yml` from `main` with the action `destroy`, the stack `labs/00-site-hosting`, and
the confirmation `destroy labs/00-site-hosting`; you approve it in the `infra` environment.
The buckets are emptied by `force_destroy`. The custom domain's records and certificate go with the
stack. For a local run, `terraform destroy` does the same.
