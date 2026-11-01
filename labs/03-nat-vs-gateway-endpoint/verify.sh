#!/usr/bin/env bash
# Check of an applied lab 03 stack (a VPC with a NAT gateway and an S3 gateway endpoint with an endpoint
# policy, and a private instance reached only through Systems Manager), read-only unless asked
# otherwise.
#
# It prints one line per check (ok / FAIL / skip), in this order:
#   - the network: DNS on, the public route to an internet gateway, the private routes (to the NAT
#     gateway, and to the S3 prefix list through the endpoint, and none to an internet gateway), the NAT
#     gateway and the endpoint;
#   - the endpoint policy: it names the data bucket, not the other bucket, and no Resource of "*";
#   - the instance: running, no public IP, no key pair, IMDSv2 only, and no inbound rule;
#   - its role: path /lab/, the fg-workload-boundary permissions boundary, the Systems Manager managed
#     policy, and (IAM policy simulator) the Systems Manager actions and a read of the other bucket
#     allowed by IAM, so that only the endpoint policy can refuse it;
#   - the buckets: Block Public Access on, and the bucket policy of the data bucket (a deny of reads
#     under endpoint-only/ unless they come through the endpoint, with no Null or IfExists condition);
#   - the instance is online in Systems Manager (it can take a few minutes after the apply);
#   - live checks, only with VERIFY_ASSUME=1: Run Command and Session Manager on the instance, the
#     internet address it shows, a read through the endpoint, an upload through the endpoint, the other
#     bucket refused by the endpoint policy, and the reads from outside refused or accepted by the
#     bucket policy (see "Why the live checks are opt-in" below).
#
# The simulator cannot read a bucket policy for a role or an endpoint policy, which is why the
# endpoint policy and the bucket policy are read statically (checks 8 and 16) and their denies are only
# tested for real, by the live checks.
#
# Without VERIFY_ASSUME=1 it only reads: `aws ... describe-...`, `get-...`, `list-...`,
# `simulate-principal-policy`, `sts get-caller-identity` and `terraform output -raw`. It never prints
# a bucket name, a resource ID, an IP address, an ARN or an account ID, so its output is safe in a
# public CI log.
#
# Run it from the stack directory, after `terraform init` (CI) or after a local apply:
#   bash verify.sh
#   VERIFY_ASSUME=1 bash verify.sh
#   - CI: infra.yml runs it after every apply of this lab, with the read-only fg-tf-plan role and
#     without VERIFY_ASSUME (that role may not read objects or send commands).
#   - Reader: sign in with `aws sso login --profile <profile>`, set AWS_PROFILE, then run it.
# It needs bash 4 or newer, terraform and aws (CLI v2). The live checks also need the Session Manager
# plugin. It learns everything from the `terraform output` values of the stack, so no TF_VAR_* variable
# is needed. VERIFY_POLL_SECONDS (default 5) is the wait between two polls.
#
# Exit codes: 0 every check passed (skipped ones do not count), 1 a check failed, 2 it could not run.
#
# Why the live checks are opt-in: they send commands to the instance, open a session on it and write
# two small probe objects (verify-probe.txt, under endpoint-only/ in the data bucket and at the top of
# the other bucket), which the read-only CI role is not allowed to do. The probe objects stay after the
# run (they are overwritten on the next one, and `terraform destroy` empties the buckets); the script
# never deletes an object, and it never changes a route or the endpoint: a script that stopped halfway
# would leave the lab broken while the NAT gateway bills. The two route breaks are by hand
# (break-it.md).
#
# Until the usage and tool checks are done, only shell builtins run (nothing to find on PATH).
# set +x follows at once: xtrace (bash -x, or SHELLOPTS=xtrace in the environment) would print
# account IDs, ARNs and resource IDs.
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

# The lab lives in us-east-1 (its state does not). LC_ALL=C keeps [0-9] to ASCII digits.
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
export AWS_PAGER=
export LC_ALL=C

readonly CR=$'\r'
readonly TAB=$'\t'
readonly REGION=us-east-1
POLL_SECONDS=${VERIFY_POLL_SECONDS:-5}

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

# run_err <command...>: the same, but it keeps the stderr in ERR (never printed) and discards the
# stdout, to tell the kind of denial from other errors.
ERR=''
run_err() {
  RC=0
  ERR=$("$@" 2>&1 >/dev/null) || RC=$?
  ERR=${ERR//$CR/}
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

output_of vpc_id
VPC=$OUT
output_of public_route_table_id
PUBLIC_RT=$OUT
output_of private_route_table_id
PRIVATE_RT=$OUT
output_of nat_gateway_id
NAT=$OUT
output_of nat_public_ip
NAT_IP=$OUT
output_of s3_endpoint_id
ENDPOINT=$OUT
output_of instance_id
INSTANCE=$OUT
output_of instance_security_group_id
INSTANCE_SG=$OUT
output_of instance_role_arn
ROLE=$OUT
output_of data_bucket_name
DATA=$OUT
output_of other_bucket_name
OTHER=$OUT

# The account ID needs no permission. It is never printed.
run aws sts get-caller-identity --query Account --output text
if [ "$RC" -ne 0 ] || [[ ! $OUT =~ ^[0-9]{12}$ ]]; then
  echo 'verify: could not read the account ID (is there an AWS session?)' >&2
  exit 2
fi
ACCOUNT=$OUT

ROLE_NAME=fg-lab03-instance
BOUNDARY_ARN="arn:aws:iam::$ACCOUNT:policy/fg-workload-boundary"
SSM_POLICY_ARN=arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
S3_SERVICE="com.amazonaws.$REGION.s3"
DATA_ARN="arn:aws:s3:::$DATA"
PROBE_KEY=endpoint-only/verify-probe.txt
OTHER_KEY=verify-probe.txt
PROBE_TEXT='lab 03 verify probe'

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

ROUTE_ALL="Routes[?DestinationCidrBlock=='0.0.0.0/0']"
BPA_QUERY='PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]'
BPA_ALL_TRUE="True${TAB}True${TAB}True${TAB}True"
BPA_REASON='expected the four Block Public Access settings, all True'

# 1 and 2: DNS and the public route.
check_equal vpc-dns True 'expected DNS resolution on in the VPC' \
  ec2 describe-vpc-attribute --vpc-id "$VPC" --attribute enableDnsSupport \
  --query EnableDnsSupport.Value --output text

check_public_route() {
  local id=public-route
  ask "$id" ec2 describe-route-tables --route-table-ids "$PUBLIC_RT" \
    --query "$ROUTE_ALL.[GatewayId,State]" --output text || return 0
  if [[ $OUT == igw-*"${TAB}active" ]]; then
    pass "$id"
  else
    fail "$id" 'expected 0.0.0.0/0 to go to an internet gateway, active'
  fi
}
check_public_route

# 3 to 5: the private routes. The NAT route is the default; the endpoint adds the prefix list route.
check_equal private-nat-route "${NAT}${TAB}active" \
  'expected 0.0.0.0/0 to go to the NAT gateway of the lab, active' \
  ec2 describe-route-tables --route-table-ids "$PRIVATE_RT" \
  --query "$ROUTE_ALL.[NatGatewayId,State]" --output text

check_private_no_igw() {
  local id=private-no-igw
  ask "$id" ec2 describe-route-tables --route-table-ids "$PRIVATE_RT" \
    --query 'Routes[].GatewayId' --output text || return 0
  if [[ $OUT == *igw-* ]]; then
    fail "$id" 'the private route table has a route to an internet gateway'
  else
    pass "$id"
  fi
}
check_private_no_igw

# The route of the endpoint has the prefix list of S3 as its destination: look the list up first.
check_endpoint_route() {
  local id=private-endpoint-route prefix_list
  ask "$id" ec2 describe-managed-prefix-lists --filters "Name=prefix-list-name,Values=$S3_SERVICE" \
    --query 'PrefixLists[0].PrefixListId' --output text || return 0
  if [[ ! $OUT =~ ^pl-[0-9a-f]+$ ]]; then
    fail "$id" 'could not ask AWS'
    return 0
  fi
  prefix_list=$OUT
  check_equal "$id" "${prefix_list}${TAB}active" \
    'expected the S3 prefix list to go to the endpoint, active' \
    ec2 describe-route-tables --route-table-ids "$PRIVATE_RT" \
    --query "Routes[?GatewayId=='$ENDPOINT'].[DestinationPrefixListId,State]" --output text
}
check_endpoint_route

# 6 and 7: the NAT gateway and the endpoint. The endpoint state is documented with both spellings.
check_equal nat-gateway "available${TAB}public${TAB}${NAT_IP}" \
  'expected an available public NAT gateway with the address of the lab' \
  ec2 describe-nat-gateways --nat-gateway-ids "$NAT" \
  --query 'NatGateways[0].[State,ConnectivityType,NatGatewayAddresses[0].PublicIp]' --output text

check_s3_endpoint() {
  local id=s3-endpoint
  ask "$id" ec2 describe-vpc-endpoints --vpc-endpoint-ids "$ENDPOINT" \
    --query 'VpcEndpoints[0].[State,VpcEndpointType,ServiceName]' --output text || return 0
  if [ "${OUT,,}" = "available${TAB}gateway${TAB}${S3_SERVICE}" ]; then
    pass "$id"
  else
    fail "$id" 'expected an available gateway endpoint for S3 in us-east-1'
  fi
}
check_s3_endpoint

# 8: the endpoint policy lets the data bucket through and nothing else. A Resource of "*" would let
# every bucket through, with any white space around the colon.
check_endpoint_policy() {
  local id=s3-endpoint-policy
  local everything='"Resource"[[:space:]]*:[[:space:]]*"\*"'
  ask "$id" ec2 describe-vpc-endpoints --vpc-endpoint-ids "$ENDPOINT" \
    --query 'VpcEndpoints[0].PolicyDocument' --output text || return 0
  if [[ $OUT != *"$DATA_ARN"* ]]; then
    fail "$id" 'the endpoint policy does not name the data bucket'
  elif [[ $OUT == *"$OTHER"* ]]; then
    fail "$id" 'the endpoint policy names the other bucket'
  elif [[ $OUT =~ $everything ]]; then
    fail "$id" 'the endpoint policy allows every resource'
  else
    pass "$id"
  fi
}
check_endpoint_policy

# 9 and 10: the instance.
check_equal instance-private "running${TAB}None${TAB}None${TAB}required" \
  'expected a running instance with no public IP, no key pair and IMDSv2 required' \
  ec2 describe-instances --instance-ids "$INSTANCE" \
  --query 'Reservations[0].Instances[0].[State.Name,PublicIpAddress,KeyName,MetadataOptions.HttpTokens]' \
  --output text
check_equal instance-no-inbound '' 'expected the security group to have no inbound rule' \
  ec2 describe-security-group-rules --filters "Name=group-id,Values=$INSTANCE_SG" \
  --query 'SecurityGroupRules[?IsEgress==`false`].SecurityGroupRuleId' --output text

# 11 to 14: the role, and what the simulator says about it. The role may read the other bucket as far
# as IAM goes: the refusal has to come from the endpoint policy.
check_equal instance-role "/lab/${TAB}${BOUNDARY_ARN}" \
  'expected the path /lab/ and the fg-workload-boundary permissions boundary' \
  iam get-role --role-name "$ROLE_NAME" \
  --query 'Role.[Path,PermissionsBoundary.PermissionsBoundaryArn]' --output text
check_equal instance-ssm-policy "$SSM_POLICY_ARN" \
  'expected exactly the AmazonSSMManagedInstanceCore managed policy' \
  iam list-attached-role-policies --role-name "$ROLE_NAME" \
  --query 'AttachedPolicies[].PolicyArn' --output text

SSM_ACTIONS=(ssm:UpdateInstanceInformation ssmmessages:CreateControlChannel
  ssmmessages:CreateDataChannel ssmmessages:OpenControlChannel ssmmessages:OpenDataChannel
  ec2messages:GetMessages)
ALLOWED_SIX="allowed${TAB}allowed${TAB}allowed${TAB}allowed${TAB}allowed${TAB}allowed"
check_equal role-may-use-ssm "$ALLOWED_SIX" \
  'expected IAM to allow the six actions of the SSM Agent' \
  iam simulate-principal-policy --policy-source-arn "$ROLE" --action-names "${SSM_ACTIONS[@]}" \
  --query 'EvaluationResults[].EvalDecision' --output text
check_equal role-may-read-other allowed \
  'expected IAM to allow the role to read the other bucket (only the endpoint policy refuses it)' \
  iam simulate-principal-policy --policy-source-arn "$ROLE" --action-names s3:GetObject \
  --resource-arns "arn:aws:s3:::$OTHER/$OTHER_KEY" \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 15: Block Public Access on both buckets.
check_buckets_private() {
  local id=buckets-private bucket
  for bucket in "$DATA" "$OTHER"; do
    ask "$id" s3api get-public-access-block --bucket "$bucket" --query "$BPA_QUERY" --output text ||
      return 0
    if [ "$OUT" != "$BPA_ALL_TRUE" ]; then
      fail "$id" "$BPA_REASON"
      return 0
    fi
  done
  pass "$id"
}
check_buckets_private

# has_sid <sid>: success when the bucket policy text in OUT has "Sid": "<sid>", with any white space
# (spaces, tabs, line ends) around the colon. A pretty-printed policy passes too.
has_sid() {
  local pattern="\"Sid\"[[:space:]]*:[[:space:]]*\"$1\""
  [[ $OUT =~ $pattern ]]
}

# 16: the bucket policy of the data bucket. DenyReadOutsideEndpoint has no Null condition on purpose:
# a request from outside has no aws:SourceVpce key, a negated operator is true on a missing key, and
# that is the case to refuse. A Null or an IfExists operator would let such a request through.
check_data_policy() {
  local id=data-bucket-policy sid
  local null_key='"Null"[[:space:]]*:'
  ask "$id" s3api get-bucket-policy --bucket "$DATA" --query Policy --output text || return 0
  for sid in DenyInsecureTransport DenyReadOutsideEndpoint; do
    if ! has_sid "$sid"; then
      fail "$id" "the bucket policy lacks $sid"
      return 0
    fi
  done
  if [[ $OUT != *aws:SourceVpce* || $OUT != *"$ENDPOINT"* ]]; then
    fail "$id" 'the bucket policy does not name the endpoint'
  elif [[ $OUT != *'endpoint-only/*'* ]]; then
    fail "$id" 'the bucket policy does not limit the deny to endpoint-only/'
  elif [[ $OUT =~ $null_key || $OUT == *IfExists* ]]; then
    fail "$id" 'the bucket policy has a Null or IfExists condition'
  else
    pass "$id"
  fi
}
check_data_policy

# 17: the SSM Agent registers a minute or two after the instance starts, and goes back to Online by
# itself after a break. Up to 60 polls; an error or any other answer is one more try.
check_instance_online() {
  local id=instance-online try=1
  while [ "$try" -le 60 ]; do
    run aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE" \
      --query 'InstanceInformationList[0].PingStatus' --output text
    if [ "$RC" -eq 0 ] && [ "$OUT" = Online ]; then
      pass "$id"
      return 0
    fi
    if [ "$try" -lt 60 ]; then pause; fi
    try=$((try + 1))
  done
  fail "$id" 'the instance did not come online in Systems Manager'
}
check_instance_online

# ---- Live checks (VERIFY_ASSUME=1) ------------------------------------------------------------------

STATUS=''
STDOUT=''
STDERR=''
RUN_COMMAND_OK=0
PROBE_OK=0

# trim_end <text>: the text without its trailing white space.
trim_end() {
  local text=$1
  printf '%s' "${text%"${text##*[![:space:]]}"}"
}

# on_instance <script>: runs the script on the instance, as root, with Run Command. It sets STATUS
# (the status of the invocation, or "unknown") and, when the status is known, STDOUT and STDERR
# (trailing white space removed). They are never printed: the instance's output may hold anything.
# No script holds a double quote or a backslash, so the JSON argument needs no escaping. MSYS would
# rewrite the paths in that argument in Git Bash, hence MSYS_NO_PATHCONV for this one call.
on_instance() {
  local script=$1 params command_id try=1
  STATUS=unknown
  STDOUT=''
  STDERR=''
  printf -v params '{"commands":["%s"]}' "$script"
  MSYS_NO_PATHCONV=1 run aws ssm send-command --instance-ids "$INSTANCE" \
    --document-name AWS-RunShellScript --parameters "$params" \
    --query Command.CommandId --output text
  if [ "$RC" -ne 0 ] || [ -z "$OUT" ]; then
    return 0
  fi
  command_id=$OUT
  # Right after send-command AWS can answer InvocationDoesNotExist: an error is one more try.
  while [ "$try" -le 24 ]; do
    run aws ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE" \
      --query Status --output text
    if [ "$RC" -eq 0 ]; then
      case $OUT in
        Pending | InProgress | Delayed) ;;
        *)
          STATUS=$OUT
          break
          ;;
      esac
    fi
    if [ "$try" -lt 24 ]; then pause; fi
    try=$((try + 1))
  done
  if [ "$STATUS" = unknown ]; then
    return 0
  fi
  run aws ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE" \
    --query StandardOutputContent --output text
  if [ "$RC" -eq 0 ]; then STDOUT=$(trim_end "$OUT"); fi
  run aws ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE" \
    --query StandardErrorContent --output text
  if [ "$RC" -eq 0 ]; then STDERR=$(trim_end "$OUT"); fi
}

# 18: Run Command reaches the instance with no inbound rule.
check_run_command() {
  local id=run-command
  on_instance 'echo lab03-run-command'
  if [ "$STATUS" = Success ] && [ "$STDOUT" = lab03-run-command ]; then
    RUN_COMMAND_OK=1
    pass "$id"
  else
    fail "$id" 'Run Command did not reach the instance'
  fi
}

# 19: Session Manager opens a session, with no SSH. The standard input comes from /dev/null so that
# the call never waits for a keyboard. The paths in the JSON argument need MSYS_NO_PATHCONV, as above.
check_session_manager() {
  local id=session-manager params
  if ! command -v session-manager-plugin >/dev/null 2>&1; then
    fail "$id" 'the Session Manager plugin is not installed'
    return 0
  fi
  printf -v params '{"command":["%s"]}' 'echo lab03-session'
  MSYS_NO_PATHCONV=1 run aws ssm start-session --target "$INSTANCE" \
    --document-name AWS-StartNonInteractiveCommand --parameters "$params" </dev/null
  if [ "$RC" -eq 0 ] && [[ $OUT == *lab03-session* ]]; then
    pass "$id"
  else
    fail "$id" 'no session could be opened'
  fi
}

# 20: the two probe objects, uploaded with your own identity. The one under endpoint-only/ can be read
# only through the endpoint. Both hold the same text.
check_probe_objects() {
  local id=probe-objects
  run aws s3api put-object --bucket "$DATA" --key "$PROBE_KEY" --body "$BODY_FILE"
  if [ "$RC" -eq 0 ]; then
    run aws s3api put-object --bucket "$OTHER" --key "$OTHER_KEY" --body "$BODY_FILE"
  fi
  if [ "$RC" -eq 0 ]; then
    PROBE_OK=1
    pass "$id"
  else
    fail "$id" 'the probe objects could not be uploaded'
  fi
}

# need_run_command <id>: success when the instance checks may go on; else it prints the skip.
need_run_command() {
  if [ "$RUN_COMMAND_OK" -ne 1 ]; then
    skip "$1" 'run-command failed'
    return 1
  fi
}

# need_probe_objects <id>: success when the probe objects are there; else it prints the skip.
need_probe_objects() {
  if [ "$PROBE_OK" -ne 1 ]; then
    skip "$1" 'probe-objects failed'
    return 1
  fi
}

# 21: the internet address the instance shows is the NAT gateway's.
check_internet() {
  local id=internet-through-nat
  need_run_command "$id" || return 0
  on_instance 'curl -sS --max-time 15 https://checkip.amazonaws.com'
  if [ "$STATUS" = Success ] && [ "$STDOUT" = "$NAT_IP" ]; then
    pass "$id"
  elif [ "$STATUS" = Success ] && [ -n "$STDOUT" ]; then
    fail "$id" 'the instance reached the internet from another address'
  else
    fail "$id" 'the instance could not reach the internet'
  fi
}

# 22: the instance reads the object that only the endpoint can read. s3api get-object, never s3 cp:
# cp starts with a HEAD request, whose error has no body and so no reason.
check_s3_through_endpoint() {
  local id=s3-through-endpoint
  need_run_command "$id" || return 0
  need_probe_objects "$id" || return 0
  on_instance "aws s3api get-object --region $REGION --bucket $DATA --key $PROBE_KEY lab03-probe >/dev/null && cat lab03-probe"
  if [ "$STATUS" = Success ] && [ "$STDOUT" = "$PROBE_TEXT" ]; then
    pass "$id"
  elif [[ $STDERR == *'explicit deny in a resource-based policy'* ]]; then
    fail "$id" 'S3 did not see the request come through the endpoint'
  else
    fail "$id" 'the read failed'
  fi
}

# 23: the endpoint policy allows s3:PutObject on the data bucket.
check_instance_upload() {
  local id=instance-upload
  need_run_command "$id" || return 0
  on_instance "echo lab03 | aws s3 cp - s3://$DATA/verify-from-instance.txt --region $REGION"
  if [ "$STATUS" = Success ]; then
    pass "$id"
  else
    fail "$id" 'the upload through the endpoint failed'
  fi
}

# 24: the other bucket is refused although IAM allows it (check 14): S3 names the endpoint policy in
# its message, "because no VPC endpoint policy allows" (implicit) or "with an explicit deny in a VPC
# endpoint policy" (explicit). Both contain "VPC endpoint policy".
check_other_bucket_denied() {
  local id=other-bucket-denied
  need_run_command "$id" || return 0
  need_probe_objects "$id" || return 0
  on_instance "aws s3api get-object --region $REGION --bucket $OTHER --key $OTHER_KEY lab03-probe >/dev/null"
  if [ "$STATUS" = Success ]; then
    fail "$id" 'the read through the endpoint was accepted'
  elif [[ $STDERR != *AccessDenied* ]]; then
    fail "$id" 'could not ask AWS'
  elif [[ $STDERR == *'VPC endpoint policy'* ]]; then
    pass "$id"
  else
    fail "$id" 'denied, but not by the endpoint policy'
  fi
}

# 25: from outside the VPC the object under endpoint-only/ is refused by the bucket policy. S3's
# same-account AccessDenied message names the kind of policy ("explicit deny in a resource-based
# policy"), so an identity problem cannot pass for the bucket policy.
check_outside_read_denied() {
  local id=outside-read-denied
  need_probe_objects "$id" || return 0
  run_err aws s3api get-object --bucket "$DATA" --key "$PROBE_KEY" "$OUT_FILE"
  if [ "$RC" -eq 0 ]; then
    fail "$id" 'a read from outside the VPC was accepted'
  elif [[ $ERR != *AccessDenied* ]]; then
    fail "$id" 'could not ask AWS'
  elif [[ $ERR == *'explicit deny in a resource-based policy'* ]]; then
    pass "$id"
  else
    fail "$id" 'denied, but not by the bucket policy'
  fi
}

# 26: the other bucket can be read from outside: the object exists and nothing refuses it there.
check_outside_other_read() {
  local id=outside-other-read content=''
  need_probe_objects "$id" || return 0
  : >"$OUT_FILE"
  run_err aws s3api get-object --bucket "$OTHER" --key "$OTHER_KEY" "$OUT_FILE"
  if [ "$RC" -eq 0 ]; then
    content=$(<"$OUT_FILE") || content=''
    content=${content//$CR/}
  fi
  if [ "$RC" -eq 0 ] && [ "$content" = "$PROBE_TEXT" ]; then
    pass "$id"
  else
    fail "$id" 'the other bucket could not be read from outside'
  fi
}

LIVE_IDS=(run-command session-manager probe-objects internet-through-nat s3-through-endpoint
  instance-upload other-bucket-denied outside-read-denied outside-other-read)
SKIP_LIVE='set VERIFY_ASSUME=1 to try it for real (needs ssm:SendCommand, ssm:StartSession and s3:PutObject)'

if [ "${VERIFY_ASSUME:-}" != 1 ]; then
  for id in "${LIVE_IDS[@]}"; do
    skip "$id" "$SKIP_LIVE"
  done
else
  if ! BODY_FILE=$(mktemp) || ! OUT_FILE=$(mktemp); then
    echo 'verify: could not create a temporary file' >&2
    exit 2
  fi
  printf '%s\n' "$PROBE_TEXT" >"$BODY_FILE"

  check_run_command
  check_session_manager
  check_probe_objects
  check_internet
  check_s3_through_endpoint
  check_instance_upload
  check_other_bucket_denied
  check_outside_read_denied
  check_outside_other_read
fi

# ---- End --------------------------------------------------------------------------------------------

if [ "$FAILED" -eq 0 ]; then
  echo "verify: ok ($PASSED passed, $SKIPPED skipped)"
  exit 0
fi
echo "verify: FAIL ($FAILED failed, $PASSED passed, $SKIPPED skipped)"
exit 1
