#!/usr/bin/env bash
# Check of an applied lab 05 stack (a source queue that moves failing messages to a dead-letter queue,
# a Python function that consumes the queue through an event source mapping and reports partial batch
# failures, and an alarm on the dead-letter queue), read-only unless asked otherwise.
#
# It prints one line per check (ok / FAIL / skip), in this order:
#   - the queues: the source queue (visibility timeout, retention, SSE-SQS), its redrive policy (the
#     DLQ and a maxReceiveCount of 3), the DLQ (retention, SSE-SQS) and its redrive allow policy (only
#     the source queue);
#   - the function: runtime, architecture, timeout, memory, state and role;
#   - its role: path /lab/, the fg-workload-boundary permissions boundary, and (IAM policy simulator)
#     the queue actions allowed and logs:CreateLogGroup not allowed;
#   - the event source mapping, the retention of the log group and the alarm on the DLQ;
#   - live checks, only with VERIFY_SEND=1: it sends a good order and a poison message, and checks that
#     the good order was processed once, that the poison message reached the DLQ, and that the alarm
#     went off (see "Why the live checks are opt-in" below).
#
# Without VERIFY_SEND=1 it only reads: `aws ... get-...`, `describe-...`, `simulate-principal-policy`,
# `sts get-caller-identity` and `terraform output -raw`. It never prints a queue URL, an ARN, a mapping
# UUID, a message ID or an account ID, so its output is safe in a public CI log.
#
# Run it from the stack directory, after `terraform init` (CI) or after a local apply:
#   bash verify.sh
#   VERIFY_SEND=1 bash verify.sh
#   - CI: infra.yml runs it after every apply of this lab, with the read-only fg-tf-plan role and
#     without VERIFY_SEND (that role may not send messages).
#   - Reader: sign in with `aws sso login --profile <profile>`, set AWS_PROFILE, then run it.
# It needs bash 4 or newer, terraform and aws (CLI v2). It learns everything from the `terraform output`
# values of the stack, so no TF_VAR_* variable is needed. VERIFY_POLL_SECONDS (default 5) is the wait
# between two polls.
#
# Exit codes: 0 every check passed (skipped ones do not count), 1 a check failed, 2 it could not run.
#
# Why the live checks are opt-in: they send two messages to the queue (sqs:SendMessage), which the
# read-only CI role is not allowed to do, and they wait for the function to work on them. The poison message stays in the DLQ on
# purpose: break-it.md redrives it. The script never receives or deletes a message, never purges a
# queue, never starts a redrive and never changes the queues or the mapping: reading a queue would hide
# its messages from the function and add to their receive count, and a script that stopped halfway
# would leave the lab changed. The breaks are by hand (break-it.md).
#
# Until the usage and tool checks are done, only shell builtins run (nothing to find on PATH).
# set +x follows at once: xtrace (bash -x, or SHELLOPTS=xtrace in the environment) would print
# account IDs, ARNs and queue URLs.
set -euo pipefail
set +x

if [ "$#" -gt 0 ]; then
  printf '%s\n' 'usage: bash verify.sh (no arguments; run it from the stack directory)' >&2
  exit 2
fi

# VERIFY_POLL_SECONDS, when it is set, is a whole number of seconds: digits only (an empty value, a
# sign, a decimal or a unit is refused before anything runs).
if [ -n "${VERIFY_POLL_SECONDS+set}" ] && [[ ! $VERIFY_POLL_SECONDS =~ ^[0-9]+$ ]]; then
  printf '%s\n' 'verify: VERIFY_POLL_SECONDS must be a whole number of seconds (digits only)' >&2
  exit 2
fi

for tool in terraform aws; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'verify: %s is not installed\n' "$tool" >&2
    exit 2
  fi
done

# The lab lives in eu-west-1 (so does its state). LC_ALL=C keeps [0-9] to ASCII digits.
export AWS_REGION=eu-west-1
export AWS_DEFAULT_REGION=eu-west-1
export AWS_PAGER=
export LC_ALL=C

readonly CR=$'\r'
readonly TAB=$'\t'
POLL_SECONDS=${VERIFY_POLL_SECONDS:-5}

# run <command...>: sets OUT (stdout without carriage returns) and RC (exit code). The stderr of
# every call is discarded: AWS errors carry ARNs and account IDs.
OUT=''
RC=0
run() {
  RC=0
  OUT=$("$@" 2>/dev/null) || RC=$?
  OUT=${OUT//$CR/}
}

# pause: the wait between two polls. It is never called after the last one.
pause() {
  sleep "$POLL_SECONDS"
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

output_of source_queue_url
SRC_URL=$OUT
output_of source_queue_arn
SRC_ARN=$OUT
output_of dlq_url
DLQ_URL=$OUT
output_of dlq_arn
DLQ_ARN=$OUT
output_of function_name
FUNCTION=$OUT
output_of event_source_mapping_uuid
MAPPING=$OUT
output_of log_group_name
LOG_GROUP=$OUT
output_of alarm_name
ALARM=$OUT

# The account ID needs no permission. It is never printed.
run aws sts get-caller-identity --query Account --output text
if [ "$RC" -ne 0 ] || [[ ! $OUT =~ ^[0-9]{12}$ ]]; then
  echo 'verify: could not read the account ID (is there an AWS session?)' >&2
  exit 2
fi
ACCOUNT=$OUT

ROLE_NAME=fg-lab05-consumer
DLQ_NAME=fg-lab05-orders-dlq
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/lab/$ROLE_NAME"
BOUNDARY_ARN="arn:aws:iam::$ACCOUNT:policy/fg-workload-boundary"

# The run ID of the live checks: it names the good order, so that the logs tell this run's order from
# an older one. It is checked here, before anything is printed or sent.
RUN_ID=''
if [ "${VERIFY_SEND:-}" = 1 ]; then
  run date +%s
  if [ "$RC" -ne 0 ] || [[ ! $OUT =~ ^[0-9]+$ ]]; then
    echo 'verify: date +%s did not answer a number' >&2
    exit 2
  fi
  RUN_ID="verify-$OUT"
fi

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

# ---- Read-only checks -------------------------------------------------------------------------------

# get-queue-attributes answers {"Attributes": {...}}: every query starts at Attributes.

# 1: the source queue.
check_equal source-queue "35${TAB}345600${TAB}true" \
  'expected a visibility timeout of 35, a retention of 345600 and SSE-SQS on' \
  sqs get-queue-attributes --queue-url "$SRC_URL" --attribute-names All \
  --query 'Attributes.[VisibilityTimeout,MessageRetentionPeriod,SqsManagedSseEnabled]' --output text

# 2: the redrive policy is JSON in a string. The white space is taken out first, so a pretty-printed
# policy passes too, and maxReceiveCount may be a number or a string (SQS returns what was set).
check_redrive_policy() {
  local id=redrive-policy compact
  ask "$id" sqs get-queue-attributes --queue-url "$SRC_URL" --attribute-names All \
    --query 'Attributes.RedrivePolicy' --output text || return 0
  compact=${OUT//[[:space:]]/}
  if [[ $compact != *"\"deadLetterTargetArn\":\"$DLQ_ARN\""* ]]; then
    fail "$id" 'the redrive policy does not target the DLQ'
  elif [[ $compact != *'"maxReceiveCount":3,'* && $compact != *'"maxReceiveCount":3}'* &&
    $compact != *'"maxReceiveCount":"3"'* ]]; then
    fail "$id" 'maxReceiveCount is not 3'
  else
    pass "$id"
  fi
}
check_redrive_policy

# 3: the dead-letter queue.
check_equal dlq "1209600${TAB}true" \
  'expected a retention of 1209600 and SSE-SQS on' \
  sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names All \
  --query 'Attributes.[MessageRetentionPeriod,SqsManagedSseEnabled]' --output text

# 4: only the source queue may use the DLQ.
check_redrive_allow() {
  local id=dlq-redrive-allow compact
  ask "$id" sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names All \
    --query 'Attributes.RedriveAllowPolicy' --output text || return 0
  compact=${OUT//[[:space:]]/}
  if [[ $compact == *'"redrivePermission":"byQueue"'* &&
    $compact == *"\"sourceQueueArns\":[\"$SRC_ARN\"]"* ]]; then
    pass "$id"
  else
    fail "$id" 'expected byQueue, with the source queue as the only source'
  fi
}
check_redrive_allow

# 5: the function. get-function-configuration answers the configuration at the top level.
check_equal function \
  "python3.14${TAB}arm64${TAB}5${TAB}128${TAB}Active${TAB}${ROLE_ARN}" \
  'expected python3.14 on arm64, 5 seconds, 128 MB, active, with the role of the lab' \
  lambda get-function-configuration --function-name "$FUNCTION" \
  --query '[Runtime,Architectures[0],Timeout,MemorySize,State,Role]' --output text

# 6 to 8: the role, and what the simulator says about it.
check_equal function-role "/lab/${TAB}${BOUNDARY_ARN}" \
  'expected the path /lab/ and the fg-workload-boundary permissions boundary' \
  iam get-role --role-name "$ROLE_NAME" \
  --query 'Role.[Path,PermissionsBoundary.PermissionsBoundaryArn]' --output text
check_equal role-may-consume "allowed${TAB}allowed${TAB}allowed" \
  'expected IAM to allow the three queue actions on the source queue' \
  iam simulate-principal-policy --policy-source-arn "$ROLE_ARN" \
  --action-names sqs:ReceiveMessage sqs:DeleteMessage sqs:GetQueueAttributes \
  --resource-arns "$SRC_ARN" --query 'EvaluationResults[].EvalDecision' --output text
check_equal role-no-log-groups implicitDeny \
  'expected the role to have no permission to create a log group' \
  iam simulate-principal-policy --policy-source-arn "$ROLE_ARN" \
  --action-names logs:CreateLogGroup \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 9: the event source mapping. get-event-source-mapping answers the mapping at the top level.
check_equal mapping "Enabled${TAB}${SRC_ARN}${TAB}10${TAB}5${TAB}ReportBatchItemFailures" \
  'expected an enabled mapping on the source queue: batch size 10, window 5, partial batch responses' \
  lambda get-event-source-mapping --uuid "$MAPPING" \
  --query '[State,EventSourceArn,BatchSize,MaximumBatchingWindowInSeconds,FunctionResponseTypes[0]]' \
  --output text

# 10: the log group keeps one day of logs. The name starts with a slash: MSYS (Git Bash) would turn it
# into a Windows path, hence MSYS_NO_PATHCONV for the aws logs calls and for no other call.
MSYS_NO_PATHCONV=1 check_equal log-group 1 'expected a log group with a retention of 1 day' \
  logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" \
  --query "logGroups[?logGroupName=='$LOG_GROUP'].retentionInDays" --output text

# 11: the alarm is on the DLQ, goes off above 0 messages, and has no action.
check_equal dlq-alarm \
  "AWS/SQS${TAB}ApproximateNumberOfMessagesVisible${TAB}${DLQ_NAME}${TAB}GreaterThanThreshold${TAB}0.0${TAB}0" \
  'expected an alarm on the messages visible in the DLQ: above 0, with no action' \
  cloudwatch describe-alarms --alarm-names "$ALARM" \
  --query 'MetricAlarms[0].[Namespace,MetricName,Dimensions[0].Value,ComparisonOperator,Threshold,length(AlarmActions)]' \
  --output text

# ---- Live checks (VERIFY_SEND=1) --------------------------------------------------------------------

BASE=0
TOTAL=0
COUNT=0
POISON_OK=0

# dlq_total: sets TOTAL to the messages in the DLQ, visible and in flight, or returns 1.
dlq_total() {
  local pattern="^([0-9]+)${TAB}([0-9]+)"'$'
  run aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names All \
    --query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]' \
    --output text
  if [ "$RC" -ne 0 ] || [[ ! $OUT =~ $pattern ]]; then
    return 1
  fi
  TOTAL=$((10#${BASH_REMATCH[1]} + 10#${BASH_REMATCH[2]}))
}

# count_good_events: sets COUNT to the number of log events of this run's good order, or returns 1.
# The pattern is one argument and keeps its double quotes: a filter term with a character other than a
# letter, a digit or an underscore (the run ID has a dash) must be quoted. When the CLI pages through
# the answer, the query gives one number per page, so the numbers are added up.
count_good_events() {
  local number
  MSYS_NO_PATHCONV=1 run aws logs filter-log-events --log-group-name "$LOG_GROUP" \
    --filter-pattern "\"processed order $RUN_ID\"" --query 'length(events)' --output text
  if [ "$RC" -ne 0 ] || [[ ! $OUT =~ ^[[:space:]]*[0-9]+([[:space:]]+[0-9]+)*[[:space:]]*$ ]]; then
    return 1
  fi
  COUNT=0
  for number in $OUT; do
    COUNT=$((COUNT + 10#$number))
  done
}

# 12: sends the good order and the poison message in one batch, then waits for the good order to show
# in the logs (up to 24 polls). Returns 1 when nothing was sent, so that the checks after it are
# skipped: they depend on the messages being in the queue.
check_good_processed() {
  local id=good-processed try=1 entries
  if ! dlq_total; then
    fail "$id" 'could not ask AWS'
    return 1
  fi
  BASE=$TOTAL
  entries='[{"Id":"good","MessageBody":"{\"order_id\":\"'"$RUN_ID"'\"}"},{"Id":"poison","MessageBody":"not an order"}]'
  # The CLI exits 0 when only some entries failed: the answer lists them under "Failed". The output
  # format is set to json for this one call (a profile or AWS_DEFAULT_OUTPUT could say text or table),
  # and an answer with a non-empty "Failed" list, white space removed, is a failed send.
  AWS_DEFAULT_OUTPUT=json run aws sqs send-message-batch --queue-url "$SRC_URL" --entries "$entries"
  if [ "$RC" -ne 0 ] || [[ ${OUT//[[:space:]]/} == *'"Failed":[{'* ]]; then
    fail "$id" 'the messages could not be sent'
    return 1
  fi
  while [ "$try" -le 24 ]; do
    if count_good_events && [ "$COUNT" -ge 1 ]; then
      pass "$id"
      return 0
    fi
    if [ "$try" -lt 24 ]; then pause; fi
    try=$((try + 1))
  done
  fail "$id" 'the good order was not processed'
}

# 13: the poison message moves to the DLQ after 3 receives, about 3 x 35 seconds: up to 60 polls. The
# DLQ may hold older messages, so the check is "one more than at the start". An error is one more try.
check_poison_in_dlq() {
  local id=poison-in-dlq try=1
  while [ "$try" -le 60 ]; do
    if dlq_total && [ "$TOTAL" -ge $((BASE + 1)) ]; then
      POISON_OK=1
      pass "$id"
      return 0
    fi
    if [ "$try" -lt 60 ]; then pause; fi
    try=$((try + 1))
  done
  fail "$id" 'the poison message did not reach the DLQ'
}

# 14: the good order was processed once: partial batch responses keep it out of the retries.
check_good_once() {
  local id=good-once
  if [ "$POISON_OK" -ne 1 ]; then
    skip "$id" 'poison-in-dlq failed'
    return 0
  fi
  if ! count_good_events; then
    fail "$id" 'could not ask AWS'
  elif [ "$COUNT" -eq 1 ]; then
    pass "$id"
  else
    fail "$id" 'the good order was processed more than once'
  fi
}

# 15: the alarm on the DLQ goes to ALARM. The metric is sent every minute and the alarm looks at a
# period of 60 seconds, so it can take a few minutes: up to 120 polls.
check_alarm_fires() {
  local id=alarm-fires try=1
  if [ "$POISON_OK" -ne 1 ]; then
    skip "$id" 'poison-in-dlq failed'
    return 0
  fi
  while [ "$try" -le 120 ]; do
    run aws cloudwatch describe-alarms --alarm-names "$ALARM" \
      --query 'MetricAlarms[0].StateValue' --output text
    if [ "$RC" -eq 0 ] && [ "$OUT" = ALARM ]; then
      pass "$id"
      return 0
    fi
    if [ "$try" -lt 120 ]; then pause; fi
    try=$((try + 1))
  done
  fail "$id" 'the DLQ alarm did not go off'
}

LIVE_IDS=(good-processed poison-in-dlq good-once alarm-fires)
SKIP_LIVE='set VERIFY_SEND=1 to try it for real (sends two messages; needs sqs:SendMessage and logs:FilterLogEvents)'

if [ "${VERIFY_SEND:-}" != 1 ]; then
  for id in "${LIVE_IDS[@]}"; do
    skip "$id" "$SKIP_LIVE"
  done
elif check_good_processed; then
  check_poison_in_dlq
  check_good_once
  check_alarm_fires
else
  for id in poison-in-dlq good-once alarm-fires; do
    skip "$id" 'good-processed failed'
  done
fi

# ---- End --------------------------------------------------------------------------------------------

if [ "$FAILED" -eq 0 ]; then
  echo "verify: ok ($PASSED passed, $SKIPPED skipped)"
  exit 0
fi
echo "verify: FAIL ($FAILED failed, $PASSED passed, $SKIPPED skipped)"
exit 1
