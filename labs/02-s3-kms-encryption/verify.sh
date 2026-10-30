#!/usr/bin/env bash
# Check of an applied lab 02 stack (S3 default encryption with a customer managed KMS key, a bucket
# policy that enforces it, server access logs and a client role), read-only unless asked otherwise.
#
# It prints one line per check (ok / FAIL / skip), in this order:
#   - the client role: path /lab/, the fg-workload-boundary permissions boundary, and a trust policy
#     for the account root with no condition;
#   - the KMS key: enabled, customer managed, symmetric, single-Region, rotating, with its alias;
#   - the data bucket: default encryption with the lab key and a Bucket Key, SSE-C blocked, Block
#     Public Access on, the four denies and the TLS condition in the bucket policy, and server
#     access logging to the log bucket;
#   - the log bucket: Block Public Access on, SSE-S3, a policy that lets S3 deliver the logs for the
#     data bucket, and logs that expire after 7 days;
#   - the IAM policy simulator (SimulatePrincipalPolicy): the client may upload to the bucket, may use
#     the key when S3 calls KMS for it, and may not use the key in any other way;
#   - live checks, only with VERIFY_ASSUME=1: really assume the client role and upload, download and
#     get refused (see "Why the live checks are opt-in" below).
#
# The simulator cannot read the bucket policy for a role ("simulation of resource-based policies isn't
# supported for IAM roles"), which is why the bucket policy is read statically (checks 9 and 13) and
# its denies are only tested for real, by the live checks.
#
# Without VERIFY_ASSUME=1 it only reads: `aws ... get-...`, `describe-key`, `list-aliases`,
# `simulate-principal-policy`, `sts get-caller-identity` and `terraform output -raw`. It never prints
# a bucket name, a key ID, an ARN or an account ID, so its output is safe in a public CI log.
#
# Run it from the stack directory, after `terraform init` (CI) or after a local apply:
#   bash verify.sh
#   VERIFY_ASSUME=1 bash verify.sh
#   - CI: infra.yml runs it after every apply of this lab, with the read-only fg-tf-plan role and
#     without VERIFY_ASSUME (that role has no sts:AssumeRole and may not read objects).
#   - Reader: sign in with `aws sso login --profile <profile>`, set AWS_PROFILE, then run it.
# It needs bash 4 or newer, terraform and aws (CLI v2, recent enough to show BlockedEncryptionTypes).
# It learns everything from the `terraform output` values of the stack, so no TF_VAR_* variable is
# needed.
#
# Exit codes: 0 every check passed (skipped ones do not count), 1 a check failed, 2 it could not run.
#
# Why the live checks are opt-in: they call sts:AssumeRole, which the read-only CI role is denied,
# and they write one small object (verify-probe.txt) to the data bucket. With VERIFY_ASSUME=1 the
# script assumes the client role with your current identity, then calls AWS "as" the client by
# putting its temporary keys in the environment of that one command (never in an argument, never
# printed) and unsetting AWS_PROFILE, so the CLI cannot fall back to your own profile. The probe
# object stays after the run (it is overwritten on the next one, and `terraform destroy` empties the
# bucket); the script never deletes an object.
#
# Until the usage and tool checks are done, only shell builtins run (nothing to find on PATH).
# set +x follows at once: xtrace (bash -x, or SHELLOPTS=xtrace in the environment) would print
# account IDs, ARNs and the temporary keys of the live checks.
set -euo pipefail
set +x

if [ "$#" -gt 0 ]; then
  printf '%s\n' 'usage: bash verify.sh (no arguments; run it from the stack directory)' >&2
  exit 2
fi

for tool in terraform aws; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'verify: %s is not installed\n' "$tool" >&2
    exit 2
  fi
done

# The lab lives in eu-west-1. LC_ALL=C keeps [0-9] to ASCII digits.
export AWS_REGION=eu-west-1
export AWS_DEFAULT_REGION=eu-west-1
export AWS_PAGER=
export LC_ALL=C

readonly CR=$'\r'
readonly TAB=$'\t'

# The two temporary files of the live checks. They are removed whatever way the script ends.
BODY_FILE=''
OUT_FILE=''
cleanup() {
  if [ -n "$BODY_FILE" ]; then rm -f "$BODY_FILE"; fi
  if [ -n "$OUT_FILE" ]; then rm -f "$OUT_FILE"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# run <command...>: sets OUT (stdout without carriage returns) and RC (exit code). The stderr of
# every call is discarded: AWS errors carry ARNs and account IDs.
OUT=''
RC=0
run() {
  RC=0
  OUT=$("$@" 2>/dev/null) || RC=$?
  OUT=${OUT//$CR/}
}

# ---- Outputs of the stack ------------------------------------------------------------------------

# output_of <name>: sets OUT to the terraform output, or stops the script.
output_of() {
  run terraform output -raw "$1"
  if [ "$RC" -ne 0 ] || [ -z "$OUT" ]; then
    printf 'verify: terraform output %s is empty; apply the stack first\n' "$1" >&2
    exit 2
  fi
}

output_of client_role_arn
CLIENT=$OUT
output_of data_bucket_name
DATA=$OUT
output_of log_bucket_name
LOGS=$OUT
output_of log_prefix
PREFIX=$OUT
output_of kms_key_arn
KEY=$OUT
# The alias is a fixed name in the stack and in the check below; the output only has to exist.
output_of kms_key_alias

# The account ID needs no permission. It is never printed.
run aws sts get-caller-identity --query Account --output text
if [ "$RC" -ne 0 ] || [[ ! $OUT =~ ^[0-9]{12}$ ]]; then
  echo 'verify: could not read the account ID (is there an AWS session?)' >&2
  exit 2
fi
ACCOUNT=$OUT

ROOT_ARN="arn:aws:iam::$ACCOUNT:root"
BOUNDARY_ARN="arn:aws:iam::$ACCOUNT:policy/fg-workload-boundary"
DATA_ARN="arn:aws:s3:::$DATA"
OBJECT_KEY=verify-probe.txt
PROBE_ARN="$DATA_ARN/$OBJECT_KEY"
# A well-formed key ARN that names no key: the bucket policy compares text, it never looks the key up.
ZERO_KEY="arn:aws:kms:eu-west-1:$ACCOUNT:key/00000000-0000-0000-0000-000000000000"
VIA_S3_CONTEXT='ContextKeyName=kms:ViaService,ContextKeyValues=s3.eu-west-1.amazonaws.com,ContextKeyType=string'

# ---- Results ----------------------------------------------------------------------------------------

PASSED=0
SKIPPED=0
FAILED=0

pass() {
  echo "ok: $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo "FAIL: $1: $2"
  FAILED=$((FAILED + 1))
}

skip() {
  echo "skip: $1: $2"
  SKIPPED=$((SKIPPED + 1))
}

# ask <id> <aws arguments...>: sets OUT, or reports a FAIL and returns 1.
ask() {
  local id=$1
  shift
  run aws "$@"
  if [ "$RC" -ne 0 ]; then
    fail "$id" 'could not ask AWS'
    return 1
  fi
}

# decision_word <text>: the text if it is a simulator decision, else a neutral phrase (a decision
# is safe to print; anything else might not be).
decision_word() {
  case $1 in
    allowed | implicitDeny | explicitDeny) printf '%s' "$1" ;;
    *) printf '%s' 'an unexpected answer' ;;
  esac
}

# ---- AWS checks -------------------------------------------------------------------------------------

ROLE_QUERY='Role.[Path,PermissionsBoundary.PermissionsBoundaryArn]'
TRUST_QUERY='Role.AssumeRolePolicyDocument.Statement[].[Effect,Action,Principal.AWS,Condition]'
KEY_QUERY='KeyMetadata.[KeyState,KeyManager,KeySpec,KeyUsage,MultiRegion]'
DEFAULT_ENCRYPTION_QUERY='ServerSideEncryptionConfiguration.Rules[0].[ApplyServerSideEncryptionByDefault.SSEAlgorithm,ApplyServerSideEncryptionByDefault.KMSMasterKeyID,BucketKeyEnabled]'
BLOCKED_QUERY='ServerSideEncryptionConfiguration.Rules[0].BlockedEncryptionTypes.EncryptionType'
ALGORITHM_QUERY='ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm'
BPA_QUERY='PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]'
LOGGING_QUERY='LoggingEnabled.[TargetBucket,TargetPrefix]'
EXPIRY_QUERY="Rules[?ID=='expire-access-logs'].[Status,Expiration.Days]"
DECISION_QUERY='EvaluationResults[0].EvalDecision'
CREDENTIALS_QUERY='Credentials.[AccessKeyId,SecretAccessKey,SessionToken]'
PUT_QUERY='[ServerSideEncryption,SSEKMSKeyId,BucketKeyEnabled]'

# check_equal <id> <expected> <failure reason> <aws arguments...>: ok when the answer is exactly the
# expected text. The reason only describes the expectation: it never holds a value.
check_equal() {
  local id=$1 expected=$2 reason=$3
  shift 3
  ask "$id" "$@" || return 0
  if [ "$OUT" = "$expected" ]; then
    pass "$id"
  else
    fail "$id" "$reason"
  fi
}

check_sse_c_blocked() {
  local id=data-sse-c-blocked
  ask "$id" s3api get-bucket-encryption --bucket "$DATA" --query "$BLOCKED_QUERY" --output text || return 0
  if [ "$OUT" = SSE-C ]; then
    pass "$id"
  elif [ "$OUT" = None ]; then
    # An AWS CLI that does not know the field drops it, and the query finds nothing.
    fail "$id" 'SSE-C is not reported as blocked (an older AWS CLI drops this field: update the AWS CLI)'
  else
    fail "$id" 'SSE-C is not blocked'
  fi
}

# has_sid <sid>: success when the bucket policy text in OUT has "Sid": "<sid>", with any white space
# (spaces, tabs, line ends) around the colon. A pretty-printed policy passes too.
has_sid() {
  local pattern="\"Sid\"[[:space:]]*:[[:space:]]*\"$1\""
  [[ $OUT =~ $pattern ]]
}

check_data_policy() {
  local id=data-bucket-policy sid
  ask "$id" s3api get-bucket-policy --bucket "$DATA" --query Policy --output text || return 0
  for sid in DenyInsecureTransport DenyOtherEncryption DenyOtherKmsKey DenyKmsWithoutKeyId; do
    if ! has_sid "$sid"; then
      fail "$id" "the bucket policy lacks $sid"
      return 0
    fi
  done
  if [[ $OUT != *"$KEY"* ]]; then
    fail "$id" 'the bucket policy does not name the lab key'
  elif [[ $OUT != *aws:SecureTransport* ]]; then
    fail "$id" 'the bucket policy has no aws:SecureTransport condition'
  else
    pass "$id"
  fi
}

check_log_policy() {
  local id=log-bucket-policy
  ask "$id" s3api get-bucket-policy --bucket "$LOGS" --query Policy --output text || return 0
  if [[ $OUT != *logging.s3.amazonaws.com* ]]; then
    fail "$id" 'the log bucket policy does not allow S3 log delivery'
  elif [[ $OUT != *"arn:aws:s3:::$DATA"* ]]; then
    fail "$id" 'the log bucket policy does not name the data bucket'
  else
    pass "$id"
  fi
}

# check_simulation <id> <expected> <action> <resource> [extra options...]: the simulator's
# EvalDecision for the client role is the expected one.
check_simulation() {
  local id=$1 expected=$2 action=$3 resource=$4
  shift 4
  ask "$id" iam simulate-principal-policy --policy-source-arn "$CLIENT" --action-names "$action" \
    --resource-arns "$resource" "$@" --query "$DECISION_QUERY" --output text || return 0
  if [ "$OUT" = "$expected" ]; then
    pass "$id"
  else
    fail "$id" "expected $expected, got $(decision_word "$OUT")"
  fi
}

BPA_ALL_TRUE="True${TAB}True${TAB}True${TAB}True"
BPA_REASON='expected the four Block Public Access settings, all True'

# 1 and 2: the client role.
check_equal client-role "/lab/${TAB}${BOUNDARY_ARN}" \
  'expected the path /lab/ and the fg-workload-boundary permissions boundary' \
  iam get-role --role-name fg-lab02-client --query "$ROLE_QUERY" --output text
check_equal client-trust "Allow${TAB}sts:AssumeRole${TAB}${ROOT_ARN}${TAB}None" \
  'expected one Allow sts:AssumeRole statement for the account root, with no condition' \
  iam get-role --role-name fg-lab02-client --query "$TRUST_QUERY" --output text

# 3 to 5: the key.
check_equal kms-key "Enabled${TAB}CUSTOMER${TAB}SYMMETRIC_DEFAULT${TAB}ENCRYPT_DECRYPT${TAB}False" \
  'expected an enabled, customer managed, symmetric, single-Region encryption key' \
  kms describe-key --key-id "$KEY" --query "$KEY_QUERY" --output text
check_equal kms-key-rotation True 'expected key rotation to be on' \
  kms get-key-rotation-status --key-id "$KEY" --query KeyRotationEnabled --output text
check_equal kms-key-alias alias/fg-lab02-data 'expected the key to have exactly the alias alias/fg-lab02-data' \
  kms list-aliases --key-id "$KEY" --query 'Aliases[].AliasName' --output text

# 6 to 10: the data bucket.
check_equal data-default-encryption "aws:kms${TAB}${KEY}${TAB}True" \
  'expected default encryption with aws:kms, the lab key and the Bucket Key on' \
  s3api get-bucket-encryption --bucket "$DATA" --query "$DEFAULT_ENCRYPTION_QUERY" --output text
check_sse_c_blocked
check_equal data-bucket-private "$BPA_ALL_TRUE" "$BPA_REASON" \
  s3api get-public-access-block --bucket "$DATA" --query "$BPA_QUERY" --output text
check_data_policy
check_equal access-logging "${LOGS}${TAB}${PREFIX}" \
  'expected server access logs to go to the log bucket under the log prefix' \
  s3api get-bucket-logging --bucket "$DATA" --query "$LOGGING_QUERY" --output text

# 11 to 14: the log bucket.
check_equal log-bucket-private "$BPA_ALL_TRUE" "$BPA_REASON" \
  s3api get-public-access-block --bucket "$LOGS" --query "$BPA_QUERY" --output text
check_equal log-bucket-encryption AES256 'expected SSE-S3 (AES256) on the log bucket' \
  s3api get-bucket-encryption --bucket "$LOGS" --query "$ALGORITHM_QUERY" --output text
check_log_policy
check_equal log-expiry "Enabled${TAB}7" 'expected an enabled rule that expires the logs after 7 days' \
  s3api get-bucket-lifecycle-configuration --bucket "$LOGS" --query "$EXPIRY_QUERY" --output text

# 15 to 17: the simulator. The key permission works only when S3 calls KMS for the client.
check_simulation client-may-put allowed s3:PutObject "$PROBE_ARN"
check_simulation client-key-via-s3 allowed kms:GenerateDataKey "$KEY" --context-entries "$VIA_S3_CONTEXT"
check_simulation client-key-only-via-s3 implicitDeny kms:Decrypt "$KEY"

# ---- Live checks (VERIFY_ASSUME=1) ------------------------------------------------------------------

ERR=''
SESSION_ID=''
SESSION_SECRET=''
SESSION_TOKEN=''

# read_session: sets SESSION_ID, SESSION_SECRET and SESSION_TOKEN from OUT; fails unless OUT is
# exactly three words. The keys are shell variables only: they are never an argument and never printed.
read_session() {
  local -a words=()
  set -f
  # shellcheck disable=SC2206
  words=($OUT)
  set +f
  if [ "${#words[@]}" -ne 3 ]; then
    return 1
  fi
  SESSION_ID=${words[0]}
  SESSION_SECRET=${words[1]}
  SESSION_TOKEN=${words[2]}
}

# as_client <command...>: runs the command with the client's keys in its environment and no profile,
# in a subshell so nothing leaks into this script. Sets OUT (stdout) and RC; the stderr is discarded.
as_client() {
  RC=0
  OUT=$(
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
    export AWS_ACCESS_KEY_ID=$SESSION_ID AWS_SECRET_ACCESS_KEY=$SESSION_SECRET AWS_SESSION_TOKEN=$SESSION_TOKEN
    exec "$@" 2>/dev/null
  ) || RC=$?
  OUT=${OUT//$CR/}
}

# as_client_denied <command...>: the same, but it keeps the stderr in ERR (never printed) and discards
# the stdout, to tell the kind of denial from other errors.
as_client_denied() {
  RC=0
  ERR=$(
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
    export AWS_ACCESS_KEY_ID=$SESSION_ID AWS_SECRET_ACCESS_KEY=$SESSION_SECRET AWS_SESSION_TOKEN=$SESSION_TOKEN
    exec "$@" 2>&1 >/dev/null
  ) || RC=$?
  ERR=${ERR//$CR/}
}

# expect_denied <id> <message when the call worked>: after as_client_denied, ok only when the call
# failed with AccessDenied from a resource-based policy. S3's same-account AccessDenied message names
# the kind of policy ("explicit deny in a resource-based policy"), so a KMS failure or a missing
# identity allow cannot pass for the bucket policy.
expect_denied() {
  if [ "$RC" -eq 0 ]; then
    fail "$1" "$2"
  elif [[ $ERR != *AccessDenied* ]]; then
    fail "$1" 'could not ask AWS'
  elif [[ $ERR == *'explicit deny in a resource-based policy'* ]]; then
    pass "$1"
  else
    fail "$1" 'denied, but not by the bucket policy'
  fi
}

# expect_upload <id>: after as_client, ok when the upload worked and S3 reports aws:kms, the lab key
# and the Bucket Key.
expect_upload() {
  if [ "$RC" -ne 0 ]; then
    fail "$1" 'the upload failed'
  elif [ "$OUT" = "aws:kms${TAB}${KEY}${TAB}True" ]; then
    pass "$1"
  else
    fail "$1" 'expected the object to be encrypted with aws:kms, the lab key and the Bucket Key'
  fi
}

LIVE_IDS=(assume-client default-upload named-key-upload sse-s3-upload-denied kms-without-key-denied
  other-key-denied http-denied download)

if [ "${VERIFY_ASSUME:-}" != 1 ]; then
  for id in "${LIVE_IDS[@]}"; do
    skip "$id" 'set VERIFY_ASSUME=1 to try it for real (needs sts:AssumeRole and s3:PutObject)'
  done
else
  if ! BODY_FILE=$(mktemp) || ! OUT_FILE=$(mktemp); then
    echo 'verify: could not create a temporary file' >&2
    exit 2
  fi
  printf '%s\n' 'lab 02 verify probe' >"$BODY_FILE"

  # 18: the current identity assumes the client role. The environment is left as it is.
  run aws sts assume-role --role-arn "$CLIENT" --role-session-name lab02-verify \
    --query "$CREDENTIALS_QUERY" --output text
  if [ "$RC" -eq 0 ] && read_session; then
    pass assume-client
    CLIENT_OK=1
  else
    fail assume-client 'could not assume the client role with the current identity'
    CLIENT_OK=0
  fi

  if [ "$CLIENT_OK" -ne 1 ]; then
    for id in "${LIVE_IDS[@]:1}"; do
      skip "$id" 'assume-client failed'
    done
  else
    # 19: no encryption header. The bucket default applies: the lab key and the Bucket Key.
    as_client aws s3api put-object --bucket "$DATA" --key "$OBJECT_KEY" --body "$BODY_FILE" \
      --query "$PUT_QUERY" --output text
    expect_upload default-upload

    # 20: the lab key by its ARN, the one form the bucket policy accepts.
    as_client aws s3api put-object --bucket "$DATA" --key "$OBJECT_KEY" --body "$BODY_FILE" \
      --server-side-encryption aws:kms --ssekms-key-id "$KEY" --query "$PUT_QUERY" --output text
    expect_upload named-key-upload

    # 21: SSE-S3 is refused by DenyOtherEncryption.
    as_client_denied aws s3api put-object --bucket "$DATA" --key "$OBJECT_KEY" --body "$BODY_FILE" \
      --server-side-encryption AES256
    expect_denied sse-s3-upload-denied 'an SSE-S3 upload was accepted'

    # 22: aws:kms with no key ID would use the AWS managed key; DenyKmsWithoutKeyId refuses it.
    as_client_denied aws s3api put-object --bucket "$DATA" --key "$OBJECT_KEY" --body "$BODY_FILE" \
      --server-side-encryption aws:kms
    expect_denied kms-without-key-denied 'an upload without a key ID was accepted'

    # 23: another key ARN is refused by DenyOtherKmsKey.
    as_client_denied aws s3api put-object --bucket "$DATA" --key "$OBJECT_KEY" --body "$BODY_FILE" \
      --server-side-encryption aws:kms --ssekms-key-id "$ZERO_KEY"
    expect_denied other-key-denied 'an upload with another KMS key was accepted'

    # 24: plain HTTP is refused by DenyInsecureTransport.
    as_client_denied aws s3api get-object --bucket "$DATA" --key "$OBJECT_KEY" \
      --endpoint-url http://s3.eu-west-1.amazonaws.com "$OUT_FILE"
    expect_denied http-denied 'a plain-HTTP request was accepted'

    # 25: the client downloads the object over TLS: S3 decrypts it, so the client needs kms:Decrypt.
    : >"$OUT_FILE"
    as_client aws s3api get-object --bucket "$DATA" --key "$OBJECT_KEY" "$OUT_FILE" \
      --query ServerSideEncryption --output text
    if [ "$RC" -ne 0 ]; then
      fail download 'the download failed'
    else
      CONTENT=$(<"$OUT_FILE")
      CONTENT=${CONTENT//$CR/}
      if [ "$OUT" = aws:kms ] && [ "$CONTENT" = 'lab 02 verify probe' ]; then
        pass download
      else
        fail download 'expected the probe text, encrypted with aws:kms'
      fi
    fi
  fi
fi

# ---- End --------------------------------------------------------------------------------------------

if [ "$FAILED" -eq 0 ]; then
  echo "verify: ok ($PASSED passed, $SKIPPED skipped)"
  exit 0
fi
echo "verify: FAIL ($FAILED failed, $PASSED passed, $SKIPPED skipped)"
exit 1
