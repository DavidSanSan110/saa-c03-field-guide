#!/usr/bin/env bash
# Read-only check of an applied lab 00 stack (private S3 bucket behind CloudFront).
#
# It checks, in this order, and prints one line per check (ok / FAIL / skip):
#   - the site bucket: Block Public Access, not public, policy for this distribution only (OAC),
#     versioning, encryption; the log bucket: Block Public Access;
#   - the distribution: deployed, enabled, HTTPS redirect, private origin with an OAC, the
#     viewer-request function, TLS settings;
#   - the deploy role: path and permissions boundary;
#   - live requests: the bucket cannot be read directly, HTTP redirects to HTTPS, and the redirects
#     of the viewer-request function (see "Why the probes" below).
#
# Read-only: it calls only `aws ... get-...`, `terraform output -raw` and `curl` GET requests. It
# never prints a bucket name, an ARN or an account ID, so its output is safe in a public CI log.
#
# Run it from the stack directory, after `terraform init` (CI) or after a local apply:
#   bash verify.sh
#   - CI: infra.yml runs it after every apply of this lab, with the read-only fg-tf-plan role.
#   - Reader: sign in with `aws sso login --profile <profile>`, set AWS_PROFILE, then run it.
# It needs bash 4 or newer, terraform, aws (CLI v2) and curl. It learns everything from the
# `terraform output` values of the stack, so no TF_VAR_* variable is needed.
#
# Exit codes: 0 every check passed (skipped ones do not count), 1 a check failed, 2 it could not run.
#
# Why the probes: a redirect built from the request must never become an open redirect, and it must
# not decode a query value, because that changes what the link means:
#   - `//evil%E3%80%82com` and `/%5Cevil` must redirect to a path on this site, never to another host
#     (spec 035 AC-51 and AC-53);
#   - `?a=b%26c` must stay `?a=b%26c`: CloudFront hands query values to the function still encoded
#     and the function copies them, so `%26` must not become `&`.
# The URLs are sent with --path-as-is so that curl does not tidy them up before CloudFront sees them.
#
# Until the usage and tool checks are done, only shell builtins run (nothing to find on PATH).
set -euo pipefail

if [ "$#" -gt 0 ]; then
  printf '%s\n' 'usage: bash verify.sh (no arguments; run it from the stack directory)' >&2
  exit 2
fi

for tool in terraform aws curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'verify: %s is not installed\n' "$tool" >&2
    exit 2
  fi
done

# The lab lives in eu-west-1 (CloudFront and IAM are global). LC_ALL=C keeps [a-z] to lower case.
export AWS_REGION=eu-west-1
export AWS_DEFAULT_REGION=eu-west-1
export AWS_PAGER=
export LC_ALL=C

readonly CR=$'\r'
readonly TAB=$'\t'
readonly WAIT_ASKS=30

# run <command...>: sets OUT (stdout without carriage returns) and RC (exit code). The stderr of
# every call is discarded: AWS errors carry ARNs and curl errors name the host.
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

output_of site_bucket_name
SITE=$OUT
output_of log_bucket_name
LOGS=$OUT
output_of distribution_id
DIST=$OUT
output_of distribution_domain_name
DIST_DOMAIN=$OUT
output_of site_url
SITE_URL=$OUT

if [[ ! $SITE_URL =~ ^https://[a-z0-9.-]+$ ]]; then
  echo 'verify: site_url is not an https origin' >&2
  exit 2
fi
HOST=${SITE_URL#https://}
DOMAIN=''
if [ "$SITE_URL" != "https://$DIST_DOMAIN" ]; then
  DOMAIN=$HOST
fi

# ---- Wait for the distribution ----------------------------------------------------------------------

# A change to only the function or the headers policy can leave the distribution InProgress for
# minutes after Terraform returns.
asks=0
while [ "$asks" -lt "$WAIT_ASKS" ]; do
  run aws cloudfront get-distribution --id "$DIST" --query 'Distribution.Status' --output text
  asks=$((asks + 1))
  if [ "$RC" -ne 0 ] || [ "$OUT" != InProgress ] || [ "$asks" -ge "$WAIT_ASKS" ]; then
    break
  fi
  echo 'verify: waiting for the distribution to deploy'
  sleep "${VERIFY_POLL_SECONDS:-20}"
done

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

# aws_get <id> <service> <operation> <query> [options...]: sets OUT, or reports a FAIL and returns 1.
aws_get() {
  local id=$1 service=$2 operation=$3 query=$4
  shift 4
  run aws "$service" "$operation" "$@" --query "$query" --output text
  if [ "$RC" -ne 0 ]; then
    fail "$id" "aws $service $operation failed (exit $RC)"
    return 1
  fi
}

# split_tabs <text>: sets FIELDS, split on tabs (an empty field stays empty), each field trimmed.
FIELDS=()
split_tabs() {
  local rest=$1 field i
  FIELDS=()
  while :; do
    case $rest in
      *"$TAB"*)
        FIELDS+=("${rest%%"$TAB"*}")
        rest=${rest#*"$TAB"}
        ;;
      *)
        FIELDS+=("$rest")
        break
        ;;
    esac
  done
  for i in "${!FIELDS[@]}"; do
    field=${FIELDS[$i]}
    field=${field#"${field%%[![:space:]]*}"}
    field=${field%"${field##*[![:space:]]}"}
    FIELDS[i]=$field
  done
}

# ---- AWS checks -------------------------------------------------------------------------------------

BPA_QUERY='PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]'

# check_bpa <id> <bucket>: all four Block Public Access settings are True.
check_bpa() {
  aws_get "$1" s3api get-public-access-block "$BPA_QUERY" --bucket "$2" || return 0
  split_tabs "$OUT"
  if [ "${#FIELDS[@]}" -eq 4 ] && [ "${FIELDS[0]}" = True ] && [ "${FIELDS[1]}" = True ] &&
    [ "${FIELDS[2]}" = True ] && [ "${FIELDS[3]}" = True ]; then
    pass "$1"
  else
    fail "$1" "expected four settings, all True, got ${OUT//$TAB/ }"
  fi
}

check_policy_status() {
  local id=site-policy-not-public
  aws_get "$id" s3api get-bucket-policy-status 'PolicyStatus.IsPublic' --bucket "$SITE" || return 0
  if [ "$OUT" = False ]; then pass "$id"; else fail "$id" "expected False, got $OUT"; fi
}

check_policy_oac() {
  local id=site-policy-oac
  aws_get "$id" s3api get-bucket-policy 'Policy' --bucket "$SITE" || return 0
  # The policy text holds ARNs, so the reasons only describe it.
  if [[ $OUT != *cloudfront.amazonaws.com* ]]; then
    fail "$id" 'the bucket policy has no cloudfront.amazonaws.com principal'
  elif [[ $OUT != *":distribution/$DIST\""* ]]; then
    fail "$id" 'the bucket policy does not name this distribution'
  else
    pass "$id"
  fi
}

check_versioning() {
  local id=site-versioning
  aws_get "$id" s3api get-bucket-versioning 'Status' --bucket "$SITE" || return 0
  if [ "$OUT" = Enabled ]; then pass "$id"; else fail "$id" "expected Enabled, got $OUT"; fi
}

check_encryption() {
  local id=site-encryption
  aws_get "$id" s3api get-bucket-encryption \
    'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' \
    --bucket "$SITE" || return 0
  if [ "$OUT" = AES256 ]; then pass "$id"; else fail "$id" "expected AES256, got $OUT"; fi
}

check_distribution() {
  local id=distribution
  aws_get "$id" cloudfront get-distribution \
    'Distribution.[Status,DistributionConfig.Enabled,DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy]' \
    --id "$DIST" || return 0
  split_tabs "$OUT"
  if [ "${#FIELDS[@]}" -eq 3 ] && [ "${FIELDS[0]}" = Deployed ] && [ "${FIELDS[1]}" = True ] &&
    [ "${FIELDS[2]}" = redirect-to-https ]; then
    pass "$id"
  else
    fail "$id" "expected Deployed, True, redirect-to-https, got ${OUT//$TAB/, }"
  fi
}

check_origin() {
  local id=distribution-origin
  aws_get "$id" cloudfront get-distribution \
    'Distribution.DistributionConfig.Origins.Items[0].[OriginAccessControlId,DomainName]' \
    --id "$DIST" || return 0
  split_tabs "$OUT"
  # The origin domain holds the bucket name, so the reasons only describe it.
  if [ -z "${FIELDS[0]}" ] || [ "${FIELDS[0]}" = None ]; then
    fail "$id" 'the origin has no origin access control'
  elif [ "${#FIELDS[@]}" -ne 2 ] || [ "${FIELDS[1]}" != "$SITE.s3.eu-west-1.amazonaws.com" ]; then
    fail "$id" 'the origin is not the regional S3 endpoint of the site bucket'
  else
    pass "$id"
  fi
}

check_function() {
  local id=distribution-function
  aws_get "$id" cloudfront get-distribution \
    "Distribution.DistributionConfig.DefaultCacheBehavior.FunctionAssociations.Items[?EventType=='viewer-request'].FunctionARN" \
    --id "$DIST" || return 0
  split_tabs "$OUT"
  # The function ARN holds the account ID, so the reasons only describe it.
  if [ "${#FIELDS[@]}" -ne 1 ] || [ -z "${FIELDS[0]}" ] || [ "${FIELDS[0]}" = None ]; then
    fail "$id" "expected one viewer-request function, got ${#FIELDS[@]}"
  elif [[ ${FIELDS[0]} != *:function/fg-site-viewer-request ]]; then
    fail "$id" 'the viewer-request function is not fg-site-viewer-request'
  else
    pass "$id"
  fi
}

check_tls() {
  local id=distribution-tls
  if [ -n "$DOMAIN" ]; then
    aws_get "$id" cloudfront get-distribution \
      'Distribution.DistributionConfig.ViewerCertificate.[MinimumProtocolVersion,SSLSupportMethod]' \
      --id "$DIST" || return 0
    split_tabs "$OUT"
    if [ "${#FIELDS[@]}" -eq 2 ] && [ "${FIELDS[0]}" = TLSv1.2_2021 ] && [ "${FIELDS[1]}" = sni-only ]; then
      pass "$id"
    else
      fail "$id" "expected TLSv1.2_2021, sni-only, got ${OUT//$TAB/, }"
    fi
  else
    aws_get "$id" cloudfront get-distribution \
      'Distribution.DistributionConfig.ViewerCertificate.CloudFrontDefaultCertificate' \
      --id "$DIST" || return 0
    if [ "$OUT" = True ]; then pass "$id"; else fail "$id" "expected True, got $OUT"; fi
  fi
}

check_deploy_role() {
  local id=deploy-role
  aws_get "$id" iam get-role 'Role.[Path,PermissionsBoundary.PermissionsBoundaryArn]' \
    --role-name fg-site-deploy || return 0
  split_tabs "$OUT"
  # The boundary is an ARN with the account ID, so the reasons only describe it.
  if [ "${FIELDS[0]}" != /lab/ ]; then
    fail "$id" "expected path /lab/, got ${FIELDS[0]}"
  elif [ "${#FIELDS[@]}" -ne 2 ] || [[ ${FIELDS[1]} != *:policy/fg-workload-boundary ]]; then
    fail "$id" 'the permissions boundary is not fg-workload-boundary'
  else
    pass "$id"
  fi
}

check_bpa site-public-access-block "$SITE"
check_policy_status
check_policy_oac
check_versioning
check_encryption
check_bpa logs-public-access-block "$LOGS"
check_distribution
check_origin
check_function
check_tls
check_deploy_role

# ---- HTTP checks ------------------------------------------------------------------------------------

STATUS=''
LOCATION=''

# probe <id> <url>: one GET without following redirects. Sets STATUS and LOCATION, or reports a
# FAIL and returns 1. No --show-error: a curl error would name the host.
probe() {
  local line lower first
  run curl --silent --path-as-is --max-time 20 --output /dev/null --dump-header - "$2"
  if [ "$RC" -ne 0 ]; then
    fail "$1" "request failed (curl exit $RC)"
    return 1
  fi
  first=${OUT%%$'\n'*}
  STATUS=''
  read -r _ STATUS _ <<<"$first" || true
  LOCATION=''
  while IFS= read -r line || [ -n "$line" ]; do
    lower=${line,,}
    if [[ $lower == location:* ]]; then
      LOCATION=${line#*:}
      LOCATION=${LOCATION#"${LOCATION%%[![:space:]]*}"}
      LOCATION=${LOCATION%"${LOCATION##*[![:space:]]}"}
      break
    fi
  done <<<"$OUT"
}

# check_redirect <id> <url> <location>: status 301 and exactly that Location.
check_redirect() {
  probe "$1" "$2" || return 0
  if [ "$STATUS" = 301 ] && [ "$LOCATION" = "$3" ]; then
    pass "$1"
  else
    fail "$1" "expected $3 with status 301, got ${LOCATION:-no Location} with status ${STATUS:-none}"
  fi
}

# The reason must not print the URL: it holds the bucket name.
if probe bucket-direct "https://$SITE.s3.eu-west-1.amazonaws.com/index.html"; then
  if [ "$STATUS" = 403 ]; then
    pass bucket-direct
  else
    fail bucket-direct "expected status 403, got ${STATUS:-none}"
  fi
fi

check_redirect http-to-https "http://$HOST/verify-probe/" "https://$HOST/verify-probe/"
check_redirect redirect-protocol-relative "${SITE_URL}//evil%E3%80%82com" '/evil%E3%80%82com/'
check_redirect redirect-backslash "$SITE_URL/%5Cevil" '/%5Cevil/'
check_redirect redirect-query-encoded "$SITE_URL/verify-probe?a=b%26c" '/verify-probe/?a=b%26c'

if [ -n "$DOMAIN" ]; then
  check_redirect redirect-to-domain "https://$DIST_DOMAIN/verify-probe?a=b%26c" \
    "https://$DOMAIN/verify-probe/?a=b%26c"
else
  skip redirect-to-domain 'no custom domain'
fi

# ---- End --------------------------------------------------------------------------------------------

if [ "$FAILED" -eq 0 ]; then
  echo "verify: ok ($PASSED passed, $SKIPPED skipped)"
  exit 0
fi
echo "verify: $FAILED of $((PASSED + FAILED)) checks failed"
exit 1
