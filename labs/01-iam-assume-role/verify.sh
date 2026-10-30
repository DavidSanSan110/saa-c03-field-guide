#!/usr/bin/env bash
# Check of an applied lab 01 stack (cross-account AssumeRole with an external ID, and a permissions
# boundary), mostly read-only.
#
# It prints one line per check (ok / FAIL / skip), in this order:
#   - the two roles: path /lab/ and the fg-workload-boundary permissions boundary;
#   - the trust policies, read from the roles: the caller trusts the account root with no condition;
#     the reports reader trusts the account root (and the optional trusted account) and requires
#     the external ID;
#   - the reports bucket: Block Public Access is on;
#   - the IAM policy simulator (SimulatePrincipalPolicy): the caller may assume the reports reader;
#     iam:CreateUser is an explicit deny because of the permissions boundary, and an allow once the
#     boundary is replaced by "allow everything" (so the deny comes from the boundary); the caller
#     cannot list the bucket and the reports reader can list and read it;
#   - when trusted_account_id is set: Access Analyzer reports the reports reader as externally
#     shared with that account;
#   - live checks, only with VERIFY_ASSUME=1: really assume the roles, with and without the external
#     ID, and really list the bucket (see "Why the live checks are opt-in" below).
#
# The simulator does not read trust policies or bucket policies, which is why the trust policies
# are read statically (checks 3 to 5) and the external ID only gets a live test.
#
# It never calls iam:CreateUser (a broken boundary would create a user): the simulator answers
# instead. Without VERIFY_ASSUME=1 it only reads: `aws ... get-...`, `simulate-principal-policy`,
# `accessanalyzer list-...`, `sts get-caller-identity` and `terraform output -raw`. It never prints
# a bucket name, an ARN or an account ID, so its output is safe in a public CI log.
#
# Run it from the stack directory, after `terraform init` (CI) or after a local apply:
#   bash verify.sh
#   VERIFY_ASSUME=1 bash verify.sh
#   - CI: infra.yml runs it after every apply of this lab, with the read-only fg-tf-plan role and
#     without VERIFY_ASSUME (that role has no sts:AssumeRole).
#   - Reader: sign in with `aws sso login --profile <profile>`, set AWS_PROFILE, then run it.
# It needs bash 4 or newer, terraform and aws (CLI v2). It learns everything from the
# `terraform output` values of the stack, so no TF_VAR_* variable is needed.
#
# Exit codes: 0 every check passed (skipped ones do not count), 1 a check failed, 2 it could not run.
#
# Why the live checks are opt-in: they call sts:AssumeRole, which the read-only CI role is denied,
# and they need a session that is allowed to assume the caller role. With VERIFY_ASSUME=1 the
# script assumes the caller with your current identity, then calls AWS "as" the caller and the
# reports reader by putting their temporary keys in the environment of that one command (never in
# an argument, never printed) and unsetting AWS_PROFILE, so the CLI cannot fall back to your own
# profile.
#
# Until the usage and tool checks are done, only shell builtins run (nothing to find on PATH).
set -euo pipefail

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

# The lab lives in eu-west-1 (IAM and STS are global). LC_ALL=C keeps [0-9] to ASCII digits.
export AWS_REGION=eu-west-1
export AWS_DEFAULT_REGION=eu-west-1
export AWS_PAGER=
export LC_ALL=C

readonly CR=$'\r'
readonly TAB=$'\t'

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

output_of caller_role_arn
CALLER=$OUT
output_of target_role_arn
TARGET=$OUT
output_of reports_bucket_name
BUCKET=$OUT
output_of external_id
EXTERNAL_ID=$OUT

# trusted_account_id is empty when the lab trusts only its own account, so empty is fine here; a
# failing command is not.
run terraform output -raw trusted_account_id
if [ "$RC" -ne 0 ]; then
  echo 'verify: terraform output trusted_account_id failed; apply the stack first' >&2
  exit 2
fi
TRUSTED=$OUT
if [ -n "$TRUSTED" ] && [[ ! $TRUSTED =~ ^[0-9]{12}$ ]]; then
  echo 'verify: terraform output trusted_account_id is not 12 digits' >&2
  exit 2
fi

# The account ID needs no permission. It is never printed.
run aws sts get-caller-identity --query Account --output text
if [ "$RC" -ne 0 ] || [[ ! $OUT =~ ^[0-9]{12}$ ]]; then
  echo 'verify: could not read the account ID (is there an AWS session?)' >&2
  exit 2
fi
ACCOUNT=$OUT

ROOT_ARN="arn:aws:iam::$ACCOUNT:root"
BOUNDARY_ARN="arn:aws:iam::$ACCOUNT:policy/fg-workload-boundary"
PROBE_ARN="arn:aws:iam::$ACCOUNT:user/lab01-verify-probe"
BUCKET_ARN="arn:aws:s3:::$BUCKET"

# A boundary that allows everything: with it the simulator shows what the identity policy alone says.
readonly NOBOUNDARY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}'

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

BOUNDARY_QUERY='Role.[Path,PermissionsBoundary.PermissionsBoundaryArn]'
CALLER_TRUST_QUERY='Role.AssumeRolePolicyDocument.Statement[].[Effect,Action,Principal.AWS,Condition]'
TARGET_TRUST_QUERY='Role.AssumeRolePolicyDocument.Statement[].[Effect,Action,Condition.StringEquals."sts:ExternalId"]'
PRINCIPALS_QUERY='Role.AssumeRolePolicyDocument.Statement[0].Principal.AWS'
BPA_QUERY='PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]'
DECISION_QUERY='EvaluationResults[0].EvalDecision'
ANALYZERS_QUERY="analyzers[?status=='ACTIVE'].arn"
FINDINGS_QUERY='findings[].principal.AWS'
CREDENTIALS_QUERY='Credentials.[AccessKeyId,SecretAccessKey,SessionToken]'

# check_role <id> <role name>: path /lab/ and the workload boundary.
check_role() {
  ask "$1" iam get-role --role-name "$2" --query "$BOUNDARY_QUERY" --output text || return 0
  # The boundary is an ARN with the account ID, so the reason only describes it.
  if [ "$OUT" = "/lab/${TAB}${BOUNDARY_ARN}" ]; then
    pass "$1"
  else
    fail "$1" 'expected the path /lab/ and the fg-workload-boundary permissions boundary'
  fi
}

check_caller_trust() {
  local id=caller-trust
  ask "$id" iam get-role --role-name fg-lab01-caller --query "$CALLER_TRUST_QUERY" --output text || return 0
  if [ "$OUT" = "Allow${TAB}sts:AssumeRole${TAB}${ROOT_ARN}${TAB}None" ]; then
    pass "$id"
  else
    fail "$id" 'expected one Allow sts:AssumeRole statement for the account root, with no condition'
  fi
}

check_target_trust() {
  local id=target-trust
  ask "$id" iam get-role --role-name fg-lab01-reports-reader --query "$TARGET_TRUST_QUERY" --output text || return 0
  if [ "$OUT" = "Allow${TAB}sts:AssumeRole${TAB}${EXTERNAL_ID}" ]; then
    pass "$id"
  else
    fail "$id" 'expected one Allow sts:AssumeRole statement that requires the external ID of the stack'
  fi
}

# in_list <word> <list...>: success when the word is one of the list.
in_list() {
  local word=$1 item
  shift
  for item in "$@"; do
    if [ "$item" = "$word" ]; then return 0; fi
  done
  return 1
}

check_target_principals() {
  local id=target-principals
  local -a wanted=("$ROOT_ARN") tokens=()
  local token
  if [ -n "$TRUSTED" ]; then
    wanted+=("arn:aws:iam::$TRUSTED:root")
  fi
  ask "$id" iam get-role --role-name fg-lab01-reports-reader --query "$PRINCIPALS_QUERY" --output text || return 0
  # Split on spaces, tabs and new lines, without expanding any pattern.
  set -f
  # shellcheck disable=SC2206
  tokens=($OUT)
  set +f
  # As a set: every principal found is wanted and every wanted principal is found.
  for token in "${tokens[@]+"${tokens[@]}"}"; do
    if ! in_list "$token" "${wanted[@]}"; then
      fail "$id" 'the reports reader trusts a principal that is not the account root or the trusted account'
      return 0
    fi
  done
  for token in "${wanted[@]}"; do
    if ! in_list "$token" "${tokens[@]+"${tokens[@]}"}"; then
      fail "$id" 'the reports reader does not trust the account root and the trusted account'
      return 0
    fi
  done
  pass "$id"
}

check_bucket_private() {
  local id=reports-bucket-private
  ask "$id" s3api get-public-access-block --bucket "$BUCKET" --query "$BPA_QUERY" --output text || return 0
  if [ "$OUT" = "True${TAB}True${TAB}True${TAB}True" ]; then
    pass "$id"
  else
    fail "$id" 'expected the four Block Public Access settings, all True'
  fi
}

# check_decision <id> <expected> <aws arguments...>: the simulator's EvalDecision is the expected one.
check_decision() {
  local id=$1 expected=$2
  shift 2
  ask "$id" "$@" || return 0
  if [ "$OUT" = "$expected" ]; then
    pass "$id"
  else
    fail "$id" "expected $expected, got $(decision_word "$OUT")"
  fi
}

# simulate <source> <action> <resource> [extra options...]: the arguments of one simulator call.
SIMULATION=()
simulate() {
  local source=$1 action=$2 resource=$3
  shift 3
  SIMULATION=(iam simulate-principal-policy --policy-source-arn "$source" --action-names "$action"
    --resource-arns "$resource")
  if [ "$#" -gt 0 ]; then
    SIMULATION+=("$@")
  fi
  SIMULATION+=(--query "$DECISION_QUERY" --output text)
}

# check_simulation <id> <expected> <source> <action> <resource> [extra options...]
check_simulation() {
  local id=$1 expected=$2
  shift 2
  simulate "$@"
  check_decision "$id" "$expected" "${SIMULATION[@]}"
}

# The finding of Access Analyzer: the account analyzer lists a role that trusts another account
# as external access. It can take up to 30 minutes to appear.
check_finding() {
  local id=external-access-finding
  local -a analyzers=()
  if [ -z "$TRUSTED" ]; then
    skip "$id" 'trusted_account_id is not set'
    return 0
  fi
  ask "$id" accessanalyzer list-analyzers --type ACCOUNT --query "$ANALYZERS_QUERY" --output text || return 0
  set -f
  # shellcheck disable=SC2206
  analyzers=($OUT)
  set +f
  if [ "${#analyzers[@]}" -eq 0 ] || [ "${analyzers[0]}" = None ]; then
    fail "$id" 'no active account analyzer'
    return 0
  fi
  ask "$id" accessanalyzer list-findings --analyzer-arn "${analyzers[0]}" \
    --filter '{"resource":{"eq":["'"$TARGET"'"]},"status":{"eq":["ACTIVE"]}}' \
    --query "$FINDINGS_QUERY" --output text || return 0
  if [[ $OUT == *"$TRUSTED"* ]]; then
    pass "$id"
  else
    skip "$id" 'no active finding for the trusted account yet (Access Analyzer can take up to 30 minutes)'
  fi
}

check_role caller-role fg-lab01-caller
check_role target-role fg-lab01-reports-reader
check_caller_trust
check_target_trust
check_target_principals
check_bucket_private
check_simulation caller-may-assume allowed "$CALLER" sts:AssumeRole "$TARGET"
check_simulation boundary-denies-create-user explicitDeny "$CALLER" iam:CreateUser "$PROBE_ARN"
# Same call with the boundary replaced: the identity policy alone allows it, so the deny above is
# the boundary's doing.
check_simulation identity-allows-create-user allowed "$CALLER" iam:CreateUser "$PROBE_ARN" \
  --permissions-boundary-policy-input-list "$NOBOUNDARY"
check_simulation caller-cannot-list-reports implicitDeny "$CALLER" s3:ListBucket "$BUCKET_ARN"
check_simulation target-may-list-reports allowed "$TARGET" s3:ListBucket "$BUCKET_ARN"
check_simulation target-may-read-reports allowed "$TARGET" s3:GetObject "$BUCKET_ARN/report.txt"
check_finding

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

# as_session <key id> <secret> <token> <command...>: runs the command with those keys in its
# environment and no profile, in a subshell so nothing leaks into this script. Sets OUT (stdout) and
# RC; the stderr is discarded.
as_session() {
  local key=$1 secret=$2 token=$3
  shift 3
  RC=0
  OUT=$(
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
    export AWS_ACCESS_KEY_ID=$key AWS_SECRET_ACCESS_KEY=$secret AWS_SESSION_TOKEN=$token
    exec "$@" 2>/dev/null
  ) || RC=$?
  OUT=${OUT//$CR/}
}

# as_session_denied <key id> <secret> <token> <command...>: the same, but it keeps the stderr in ERR
# (never printed) and discards the stdout, to tell "denied" from other errors.
as_session_denied() {
  local key=$1 secret=$2 token=$3
  shift 3
  RC=0
  ERR=$(
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
    export AWS_ACCESS_KEY_ID=$key AWS_SECRET_ACCESS_KEY=$secret AWS_SESSION_TOKEN=$token
    exec "$@" 2>&1 >/dev/null
  ) || RC=$?
}

# expect_denied <id> <message when the call worked>: after as_session_denied, ok on an AccessDenied
# error, the message if the call worked, "could not ask AWS" for any other error.
expect_denied() {
  if [ "$RC" -eq 0 ]; then
    fail "$1" "$2"
  elif [[ $ERR == *AccessDenied* ]]; then
    pass "$1"
  else
    fail "$1" 'could not ask AWS'
  fi
}

LIVE_IDS=(assume-caller assume-target wrong-external-id-denied missing-external-id-denied
  target-lists-reports caller-cannot-list-reports-live)

if [ "${VERIFY_ASSUME:-}" != 1 ]; then
  for id in "${LIVE_IDS[@]}"; do
    skip "$id" 'set VERIFY_ASSUME=1 to try it for real (needs sts:AssumeRole)'
  done
else
  WRONG_ID=wrong-external-id
  if [ "$EXTERNAL_ID" = "$WRONG_ID" ]; then
    WRONG_ID=wrong-external-id-2
  fi

  # 14: the current identity assumes the caller role. The environment is left as it is.
  CALLER_ID=''
  CALLER_SECRET=''
  CALLER_TOKEN=''
  run aws sts assume-role --role-arn "$CALLER" --role-session-name lab01-verify \
    --query "$CREDENTIALS_QUERY" --output text
  if [ "$RC" -eq 0 ] && read_session; then
    CALLER_ID=$SESSION_ID
    CALLER_SECRET=$SESSION_SECRET
    CALLER_TOKEN=$SESSION_TOKEN
    pass assume-caller
    CALLER_OK=1
  else
    fail assume-caller 'could not assume the caller role with the current identity'
    CALLER_OK=0
  fi

  if [ "$CALLER_OK" -ne 1 ]; then
    for id in "${LIVE_IDS[@]:1}"; do
      skip "$id" 'assume-caller failed'
    done
  else
    # 15: the caller assumes the reports reader with the external ID.
    TARGET_ID=''
    TARGET_SECRET=''
    TARGET_TOKEN=''
    as_session "$CALLER_ID" "$CALLER_SECRET" "$CALLER_TOKEN" aws sts assume-role --role-arn "$TARGET" \
      --role-session-name lab01-verify --external-id "$EXTERNAL_ID" --query "$CREDENTIALS_QUERY" --output text
    if [ "$RC" -eq 0 ] && read_session; then
      TARGET_ID=$SESSION_ID
      TARGET_SECRET=$SESSION_SECRET
      TARGET_TOKEN=$SESSION_TOKEN
      pass assume-target
      TARGET_OK=1
    else
      fail assume-target 'the caller could not assume the reports reader with the external ID'
      TARGET_OK=0
    fi

    # 16: a wrong external ID is refused.
    as_session_denied "$CALLER_ID" "$CALLER_SECRET" "$CALLER_TOKEN" aws sts assume-role --role-arn "$TARGET" \
      --role-session-name lab01-verify --external-id "$WRONG_ID" --query "$CREDENTIALS_QUERY" --output text
    expect_denied wrong-external-id-denied 'AssumeRole worked with a wrong external ID'

    # 17: no external ID is refused too.
    as_session_denied "$CALLER_ID" "$CALLER_SECRET" "$CALLER_TOKEN" aws sts assume-role --role-arn "$TARGET" \
      --role-session-name lab01-verify --query "$CREDENTIALS_QUERY" --output text
    expect_denied missing-external-id-denied 'AssumeRole worked without an external ID'

    # 18: the reports reader can list the bucket (an empty bucket has KeyCount 0).
    if [ "$TARGET_OK" -ne 1 ]; then
      skip target-lists-reports 'assume-target failed'
    else
      as_session "$TARGET_ID" "$TARGET_SECRET" "$TARGET_TOKEN" aws s3api list-objects-v2 --bucket "$BUCKET" \
        --query KeyCount --output text
      if [ "$RC" -ne 0 ]; then
        fail target-lists-reports 'could not ask AWS'
      elif [[ $OUT =~ ^[0-9]+$ ]]; then
        pass target-lists-reports
      else
        fail target-lists-reports 'expected a count of objects, got something else'
      fi
    fi

    # 19: the caller cannot list the same bucket.
    as_session_denied "$CALLER_ID" "$CALLER_SECRET" "$CALLER_TOKEN" aws s3api list-objects-v2 --bucket "$BUCKET" \
      --query KeyCount --output text
    expect_denied caller-cannot-list-reports-live 'the caller could list the bucket'
  fi
fi

# ---- End --------------------------------------------------------------------------------------------

if [ "$FAILED" -eq 0 ]; then
  echo "verify: ok ($PASSED passed, $SKIPPED skipped)"
  exit 0
fi
echo "verify: FAIL ($FAILED failed, $PASSED passed, $SKIPPED skipped)"
exit 1
