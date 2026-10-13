# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository.
You'll get a reply within a few days.

In scope: the website and its build/deploy pipeline, the Terraform labs and modules
(for example a lab that creates an overly permissive resource), and any secret that
appears in the repository or its history.

## Secrets policy

No credentials are stored in this repository: CI deploys to AWS through GitHub OIDC,
and local work uses short-lived AWS IAM Identity Center sessions. Every commit is
scanned with gitleaks, and GitHub push protection is enabled. If a secret is ever
committed, it is **rotated** immediately; rewriting history alone is not considered a fix.

## Labs

The Terraform labs deploy real resources to **your** AWS account. Read each lab's cost
estimate first, and run its destroy step when you're done.
