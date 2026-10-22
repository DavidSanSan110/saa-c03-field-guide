# Break lab 00 on purpose

Four experiments that break one piece of the lab each, so you see why it is there. Run them only in
**your own quick-start stack** (see the [quick start](README.md#quick-start-in-your-own-account)),
never on a shared or production stack.

Each break is console or CLI drift: `terraform plan` shows it and `terraform apply` undoes it. Run
the commands from `labs/00-site-hosting/`.

## 1. Remove the CloudFront statement from the bucket policy

### Break it

The bucket policy has two statements: one that lets CloudFront read objects and
`DenyInsecureTransport`. Replace the policy with one that keeps only the second statement.

Get the bucket name:

```bash
terraform output -raw site_bucket_name
```

Save this as `deny-only.json` in the lab directory, with `<bucket-name>` replaced by that name
(delete the file afterwards and never commit it):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::<bucket-name>", "arn:aws:s3:::<bucket-name>/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

Then apply it:

```bash
aws s3api put-bucket-policy --bucket "$(terraform output -raw site_bucket_name)" --policy file://deny-only.json
```

Now ask CloudFront to forget its copies. In Git Bash on Windows, start the line with
`MSYS_NO_PATHCONV=1 `, or use PowerShell, because Git Bash would rewrite `/*`:

```bash
aws cloudfront create-invalidation --distribution-id "$(terraform output -raw distribution_id)" --paths "/*"
```

### What happens

Before the invalidation, pages that CloudFront has cached keep working until they expire. After
`create-invalidation`, CloudFront has to ask S3 again, its signed requests are no longer allowed by
the policy, and viewers get an error instead of the page. S3 answers `403` to CloudFront. The site
maps a `403` from S3 to its `/404.html` page, but CloudFront cannot fetch that page either, so the
error page is not served.

### Why

The origin access control (OAC) makes CloudFront sign every request it sends to S3, but signing is
not permission. S3 only allows what the bucket policy grants. The removed statement granted
`s3:GetObject` to the `cloudfront.amazonaws.com` service principal, with a condition that
`AWS:SourceArn` is this distribution. Without it nothing allows CloudFront to read the objects, and
S3 denies by default. Block Public Access is not involved: the bucket stayed private all along.

### Put it back

Run `terraform plan`: it shows the bucket policy will be updated in place. Run `terraform apply` to
restore the statement, then delete `deny-only.json`. Pages come back within about a minute:
CloudFront caches the `403` and `404` error responses for 60 seconds (`error_caching_min_ttl = 60`
in `cdn.tf`), so the error can still be served until that time is up.

### Exam angle

A private S3 bucket behind CloudFront is read through an **OAC** and a bucket policy that allows the
CloudFront service principal for one distribution. The older origin access identity (OAI) is the
legacy way, and a public S3 website endpoint is not private at all.

## 2. Try to make the bucket public

### Break it

Try to store a policy that lets everyone read the objects. Save this as `public.json`, with
`<bucket-name>` replaced by the output of `terraform output -raw site_bucket_name`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicRead",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<bucket-name>/*"
    }
  ]
}
```

```bash
aws s3api put-bucket-policy --bucket "$(terraform output -raw site_bucket_name)" --policy file://public.json
```

### What happens

S3 refuses the call with `AccessDenied`, and the message says that public policies are blocked by
the `BlockPublicPolicy` setting. The bucket keeps the policy it had. This holds even with
administrator permissions, because the check is not about who you are.

### Why

Block Public Access is checked before a policy is stored, and it overrides policies and ACLs.
`BlockPublicPolicy` rejects a policy that would make the bucket public. The lab turns it on for the
bucket, and `bootstrap/workload` turns it on for the whole account. When both levels are set, S3
applies the most restrictive combination.

### Put it back

Nothing changed: `terraform plan` shows no drift. Delete `public.json`.

### Exam angle

Block Public Access exists at the account level and at the bucket level, and the stricter setting
wins. CloudFront with an OAC lets you serve a site to the world while the bucket stays private, so
you never need a public bucket for it.

## 3. Skip the invalidation

### Break it

Edit one page in the built site, for example add a visible word to `apps/site/dist/index.html`.
Upload only the pages, the way the quick start does, and do not create an invalidation:

```bash
aws s3 sync ../../apps/site/dist "s3://$(terraform output -raw site_bucket_name)" --exclude "_astro/*" --delete --cache-control "max-age=0, s-maxage=86400, must-revalidate"
```

Then request the page twice and read the headers:

```bash
curl --silent --dump-header - --output /dev/null "$(terraform output -raw site_url)/"
```

### What happens

CloudFront keeps serving the cached copy: the response has `x-cache: Hit from cloudfront` and an
`age` header, and your edit is missing. The pages carry `s-maxage=86400`, so CloudFront may keep its
copy for one day. If CloudFront had not cached the page yet, the first request shows your edit
(`x-cache: Miss from cloudfront`) and later ones keep it.

### Why

An edge cache does not watch the origin. It serves what it stored until the copy expires or you
invalidate it.

### Put it back

Create the invalidation. In Git Bash on Windows, start the line with `MSYS_NO_PATHCONV=1 `, or use
PowerShell:

```bash
aws cloudfront create-invalidation --distribution-id "$(terraform output -raw distribution_id)" --paths "/*"
```

Rebuild with `pnpm build` from the repository root and run the page sync again to drop your edit.

### Exam angle

There are two ways to update cached content: invalidate it, or use a new file name for each version
(versioned file names). The files in `_astro/` have hashed names and are uploaded with `immutable`,
so they never need an invalidation. The first 1,000 invalidation paths a month are free, and `/*`
counts as one path.

## 4. Detach the viewer-request function

### Break it

In the console, open CloudFront, then the distribution of this stack. Under Behaviors, edit the
default behavior, remove the function from "Viewer request" under function associations, and save.
The change takes a few minutes to deploy.

### What happens

The home page `/` still works, because the distribution has a `default_root_object`. Other folders
such as `/guide/` return the site's 404 page, and `/guide` is no longer redirected to `/guide/`.

### Why

The origin is the S3 REST endpoint, which has no index documents: a request for `guide/` looks for an
object with exactly that key. The `default_root_object` setting only covers the root of the site, not
subfolders. The viewer-request function is what rewrites `/guide/` to `/guide/index.html`.

### Put it back

Run `terraform plan`: it shows the function association will be restored. Run `terraform apply` and
wait for the distribution to deploy (`bash verify.sh` waits for it).

### Exam angle

CloudFront Functions run on viewer requests and viewer responses. They are lightweight and cheap,
and suit small jobs like URL rewrites and redirects. Lambda@Edge also runs on origin requests and
origin responses, can make network calls and runs longer, at a higher price.
