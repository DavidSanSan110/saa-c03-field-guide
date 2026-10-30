# Break lab 02 on purpose

Three experiments, each one a way the `s3-sse-kms-upload` diagram fails or costs more. Each one
changes a single piece of the lab so you see why it is there. Run them only in **your own stack**
(see the [quick start](README.md#quick-start-in-your-own-account)), never on a shared one. Use
Git Bash on Windows, from `labs/02-s3-kms-encryption/`.

They use the shell variables and the `as_client` helper of [Observe](README.md#observe), steps 1 and
2, and the `probe.txt` file of step 1. Set them up first. A client session lasts 1 hour: run step 2
again if it expires.

**Never remove or change the permissions boundary of the lab role.** `fg-workload-boundary` is the
guardrail that keeps lab roles inside the path `/lab/` and away from IAM users and access keys.
Nothing in this lab needs it changed.

The second break is drift: `terraform plan` shows it and `terraform apply` undoes it. The third is
an edit to the code: undo the edit, then apply.

## Upload with SSE-S3

### What to do

Change nothing. Upload with the header that asks for S3-managed keys (`AES256`):

```bash
as_client aws s3 cp probe.txt "s3://$DATA/sse-s3.txt" --sse AES256
```

### What you see

`AccessDenied`: the client "is not authorized to perform: s3:PutObject" on the object "with an explicit
deny in a resource-based policy". The client's own policy allows `s3:PutObject`, so the deny comes from
the bucket policy: its `DenyOtherEncryption` statement matches because the header is not `aws:kms`.

### Why

Default encryption only fills a gap: it applies when the upload sends **no** encryption header. A
header that asks for something else is a choice, S3 honors it, and the bucket default does not
override it. So default encryption does not force SSE-KMS, and the bucket policy does. This is the
exam angle: **bucket policy versus default encryption**. To require a particular kind of encryption,
deny the other kinds in the bucket policy, with a condition on `s3:x-amz-server-side-encryption`.
The deny is `StringNotEqualsIfExists`, so an upload with no header still passes and gets the
default. The classic form that also denies a missing header is redundant next to default encryption
([Observe](README.md#observe), step 9).

### Put it back

Nothing to put back: you changed nothing.

## Remove the key permission

### What to do

Delete the `UseDataKeyThroughS3` statement from the client's inline policy, so only the two S3
statements stay. Save this as `client-without-key.json` in the lab directory (delete it afterwards and
never commit it):

```bash
cat > client-without-key.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListDataBucket",
      "Effect": "Allow",
      "Resource": "arn:aws:s3:::$DATA",
      "Action": "s3:ListBucket"
    },
    {
      "Sid": "ReadWriteObjects",
      "Effect": "Allow",
      "Resource": "arn:aws:s3:::$DATA/*",
      "Action": ["s3:GetObject", "s3:PutObject"]
    }
  ]
}
EOF
```

Apply it with your admin session, wait a few minutes for IAM to settle, then use the client again.
Assume the role again first (step 2 of Observe): with a Bucket Key, S3 can keep reusing a
bucket-level key it already fetched for you, so an old session may still work for a while.

```bash
aws iam put-role-policy --role-name fg-lab02-client --policy-name use-data-bucket --policy-document file://client-without-key.json
as_client aws s3 cp probe.txt "s3://$DATA/no-key-permission.txt"
as_client aws s3 cp "s3://$DATA/probe.txt" -
as_client aws s3 ls "s3://$DATA"
```

### What you see

The upload and the download fail with `AccessDenied`. The upload names `kms:GenerateDataKey` and the
download names `kms:Decrypt`, each on the lab key ("because no identity-based policy allows" it). The
listing still works: `s3:ListBucket` is untouched. This is the diagram's **Missing KMS permission**
scenario.

### Why

With SSE-KMS, S3 permissions alone are not enough. S3 calls KMS with the caller's permissions: to
upload it asks for a data key (`kms:GenerateDataKey`), and to download it asks KMS to decrypt the
stored data key (`kms:Decrypt`). Both need an allow, on the key and with the key policy delegating to
IAM (the account root statement). Nothing in the bucket policy is involved: this failure comes from
KMS, which is why the error names a `kms:` action and not a resource-based policy. Listing needs no
KMS call, because object names are not encrypted.

### Put it back

```bash
rm client-without-key.json
terraform apply
```

## Turn off the Bucket Key

### What to do

In `data_bucket.tf`, set `bucket_key_enabled = false` in the data bucket's encryption rule, then run
`terraform apply`. Upload a few objects as the client (assume the role again if the session expired):

```bash
for n in 1 2 3; do as_client aws s3 cp probe.txt "s3://$DATA/no-bucket-key-$n.txt"; done
```

Wait a few minutes, then read the key use in CloudTrail, as in step 10 of Observe:

```bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GenerateDataKey \
  --max-items 20 --query 'Events[].CloudTrailEvent' --output text | tr -d '\r' | grep -o '"aws:s3:arn":"[^"]*"'
```

### What you see

The uploads still work. In CloudTrail, each object has its own `GenerateDataKey` event, and the
encryption context is the **object** ARN (`.../no-bucket-key-1.txt`, `.../no-bucket-key-2.txt`, and so
on). With the Bucket Key on, the context is the bucket ARN, and several uploads share one bucket-level
key. The setting applies to new objects only; objects you uploaded before keep how they were
encrypted.

### Why

Without a Bucket Key, S3 asks KMS for a data key for every object, and every one of those calls is a
KMS request. With a Bucket Key, S3 asks KMS for a short-lived bucket-level key and makes the data keys
of the objects from it, so the requests drop by up to 99%. That is a **cost angle**: KMS requests are
billed after the first 20,000 a month ($0.03 per 10,000), and an SSE-KMS bucket with many small
objects can spend more on KMS requests than on storage. It is also a quota angle, because KMS limits
the requests per second. The cost of the trade is in CloudTrail: with a Bucket Key you see the bucket
in the encryption context, not each object.

### Put it back

Set `bucket_key_enabled = true` again in `data_bucket.tf` and run:

```bash
terraform apply
```
