#!/usr/bin/env bash
# Check of an applied lab 04 stack (an internet-facing Application Load Balancer in two public subnets,
# in front of an Auto Scaling group of two instances in private subnets that have no route out, no
# public IP, no key pair and no role), read-only.
#
# It prints one line per check (ok / FAIL), in this order:
#   - the load balancer: state, scheme, type and IP address type; its two AZs; zonal shift enabled; the
#     one HTTP listener that forwards to the target group;
#   - the target group: the health check values and the deregistration delay;
#   - the group: size, health check type and grace period; its target group; its two private subnets;
#   - the instances: private, no key pair, no role, IMDSv2 required, tagged;
#   - the network: the instances' security group has one rule in (from the load balancer's group) and
#     none out, the private route table holds only the local route, and the VPC has no NAT gateway;
#   - live: the targets become healthy, and plain HTTP requests to the load balancer are answered by
#     instances in both AZs.
#
# It only reads: `aws ... describe-...`, `sts get-caller-identity`, `terraform output -raw` and plain HTTP
# GET requests to the load balancer. It never terminates an instance, changes a health check or starts a
# zonal shift (the breaks are by hand: break-it.md). It never prints an ARN, a DNS name, a resource ID, an
# instance ID, an IP address or an account ID, so its output is safe in a public CI log.
#
# Run it from the stack directory, after `terraform init` (CI) or after a local apply:
#   bash verify.sh
#   - CI: infra.yml runs it after every apply of this lab, with the read-only fg-tf-plan role.
#   - Reader: sign in with `aws sso login --profile <profile>`, set AWS_PROFILE, then run it.
# It needs bash 4 or newer, terraform, aws (CLI v2) and curl. It learns everything from the
# `terraform output` values of the stack, so no TF_VAR_* variable is needed. VERIFY_POLL_SECONDS
# (default 5) is the wait between two polls.
#
# Exit codes: 0 every check passed, 1 a check failed, 2 it could not run.
#
# Until the usage and tool checks are done, only shell builtins run (nothing to find on PATH).
# set +x follows at once: xtrace (bash -x, or SHELLOPTS=xtrace in the environment) would print
# account IDs, ARNs and the DNS name.
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

for tool in terraform aws curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'verify: %s is not installed\n' "$tool" >&2
    exit 2
  fi
done

# The lab lives in eu-west-1 (so does its state). LC_ALL=C keeps [0-9a-f] to ASCII.
export AWS_REGION=eu-west-1
export AWS_DEFAULT_REGION=eu-west-1
export AWS_PAGER=
export LC_ALL=C

readonly CR=$'\r'
readonly TAB=$'\t'
readonly PROJECT=saa-c03-field-guide
POLL_SECONDS=${VERIFY_POLL_SECONDS:-5}

# run <command...>: sets OUT (stdout without carriage returns) and RC (exit code). The stderr of
# every call is discarded: AWS errors carry ARNs and account IDs, and curl errors carry the host name.
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

output_of vpc_id
VPC=$OUT
output_of availability_zones
AZS=$OUT
output_of alb_arn
ALB=$OUT
output_of alb_dns_name
DNS=$OUT
output_of target_group_arn
TG=$OUT
output_of asg_name
ASG=$OUT
output_of alb_security_group_id
ALB_SG=$OUT
output_of web_security_group_id
WEB_SG=$OUT
output_of private_subnet_ids
PRIV=$OUT
output_of private_route_table_id
PRIV_RT=$OUT

# The two AZs and the two private subnets: exactly two words each, or the script stops here.
AZ_1=''
AZ_2=''
PRIV_1=''
PRIV_2=''
EXTRA=''
read -r AZ_1 AZ_2 EXTRA <<<"$AZS"
if [ -z "$AZ_2" ] || [ -n "$EXTRA" ]; then
  echo 'verify: terraform output availability_zones is not two words' >&2
  exit 2
fi
read -r PRIV_1 PRIV_2 EXTRA <<<"$PRIV"
if [ -z "$PRIV_2" ] || [ -n "$EXTRA" ]; then
  echo 'verify: terraform output private_subnet_ids is not two words' >&2
  exit 2
fi

# The account ID needs no permission. It is never printed.
run aws sts get-caller-identity --query Account --output text
if [ "$RC" -ne 0 ] || [[ ! $OUT =~ ^[0-9]{12}$ ]]; then
  echo 'verify: could not read the account ID (is there an AWS session?)' >&2
  exit 2
fi

# ---- Results ----------------------------------------------------------------------------------------

PASSED=0
FAILED=0

pass() {
  echo "ok: $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo "FAIL: $1: $2"
  FAILED=$((FAILED + 1))
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

# 1: the load balancer.
check_equal alb "active${TAB}internet-facing${TAB}application${TAB}ipv4" \
  'expected an active, internet-facing, IPv4 Application Load Balancer' \
  elbv2 describe-load-balancers --load-balancer-arns "$ALB" \
  --query 'LoadBalancers[0].[State.Code,Scheme,Type,IpAddressType]' --output text

# 2: exactly the two AZs of the stack, in any order.
check_alb_azs() {
  local id=alb-azs first='' second='' third=''
  ask "$id" elbv2 describe-load-balancers --load-balancer-arns "$ALB" \
    --query 'LoadBalancers[0].AvailabilityZones[].ZoneName' --output text || return 0
  read -r first second third <<<"$OUT"
  if [ -n "$third" ]; then
    fail "$id" 'expected the load balancer in exactly the two AZs of the stack'
  elif [ "$first $second" = "$AZ_1 $AZ_2" ] || [ "$first $second" = "$AZ_2 $AZ_1" ]; then
    pass "$id"
  else
    fail "$id" 'expected the load balancer in exactly the two AZs of the stack'
  fi
}
check_alb_azs

# 3: zonal shift is switched on (it is off by default).
check_equal alb-zonal-shift true \
  'expected zonal shift to be enabled on the load balancer' \
  elbv2 describe-load-balancer-attributes --load-balancer-arn "$ALB" \
  --query "Attributes[?Key=='zonal_shift.config.enabled'].Value" --output text

# 4: one listener: port 80, HTTP, forwarding to the target group.
check_equal listener "80${TAB}HTTP${TAB}forward${TAB}${TG}" \
  'expected one HTTP listener on port 80 that forwards to the target group' \
  elbv2 describe-listeners --load-balancer-arn "$ALB" \
  --query 'Listeners[].[Port,Protocol,DefaultActions[0].Type,DefaultActions[0].TargetGroupArn]' \
  --output text

# 5: the health check, all values set on purpose (they differ from AWS's defaults).
check_equal health-check "HTTP${TAB}80${TAB}instance${TAB}/${TAB}10${TAB}5${TAB}2${TAB}2${TAB}200" \
  'expected HTTP on port 80, instance targets, path /, interval 10, timeout 5, thresholds 2 and 2, code 200' \
  elbv2 describe-target-groups --target-group-arns "$TG" \
  --query 'TargetGroups[0].[Protocol,Port,TargetType,HealthCheckPath,HealthCheckIntervalSeconds,HealthCheckTimeoutSeconds,HealthyThresholdCount,UnhealthyThresholdCount,Matcher.HttpCode]' \
  --output text

# 6: the deregistration delay.
check_equal deregistration-delay 30 \
  'expected a deregistration delay of 30 seconds' \
  elbv2 describe-target-group-attributes --target-group-arn "$TG" \
  --query "Attributes[?Key=='deregistration_delay.timeout_seconds'].Value" --output text

# 7 to 9: the group. Each check asks on its own.
check_equal asg "2${TAB}4${TAB}2${TAB}ELB${TAB}120" \
  'expected a group of 2 to 4 instances, desired 2, with ELB health checks and a 120 second grace period' \
  autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" \
  --query 'AutoScalingGroups[0].[MinSize,MaxSize,DesiredCapacity,HealthCheckType,HealthCheckGracePeriod]' \
  --output text
check_equal asg-target-group "$TG" \
  'expected the group to register its instances in the target group, and only that one' \
  autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" \
  --query 'AutoScalingGroups[0].TargetGroupARNs' --output text

# 9: VPCZoneIdentifier is the subnet IDs joined by commas.
check_asg_subnets() {
  local id=asg-subnets
  ask "$id" autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" \
    --query 'AutoScalingGroups[0].VPCZoneIdentifier' --output text || return 0
  if [ "$OUT" = "$PRIV_1,$PRIV_2" ] || [ "$OUT" = "$PRIV_2,$PRIV_1" ]; then
    pass "$id"
  else
    fail "$id" 'expected the group in exactly the two private subnets'
  fi
}
check_asg_subnets

# 10: the instances that are pending or running. One line each: type, public IP, key pair, role, IMDS
# token mode, project tag; "None" is what the CLI prints for a value that is not there. The checks go
# in this order: how many, then the first five columns, then the tag.
check_instances_private() {
  local id=instances-private line count=0 bad=0 untagged=0
  local prefix="t4g.nano${TAB}None${TAB}None${TAB}None${TAB}required"
  ask "$id" ec2 describe-instances \
    --filters "Name=tag:aws:autoscaling:groupName,Values=$ASG" \
    'Name=instance-state-name,Values=pending,running' \
    --query "Reservations[].Instances[].[InstanceType,PublicIpAddress,KeyName,IamInstanceProfile.Arn,MetadataOptions.HttpTokens,Tags[?Key=='project'].Value|[0]]" \
    --output text || return 0
  if [ -n "$OUT" ]; then
    while IFS= read -r line; do
      count=$((count + 1))
      case $line in
        "$prefix${TAB}$PROJECT") ;;
        "$prefix${TAB}"*) untagged=1 ;;
        *) bad=1 ;;
      esac
    done <<<"$OUT"
  fi
  if [ "$count" -lt 2 ]; then
    fail "$id" 'fewer than two instances are running'
  elif [ "$bad" -eq 1 ]; then
    fail "$id" 'an instance has a public IP, a key pair, a role or optional IMDS'
  elif [ "$untagged" -eq 1 ]; then
    fail "$id" 'an instance lacks the project tag'
  else
    pass "$id"
  fi
}
check_instances_private

# 11: the rules of the instances' security group: one rule in (TCP 80 from the load balancer's group)
# and no rule out. IsEgress is True or False. An egress line is reported first.
check_web_sg_rules() {
  local id=web-sg-rules
  ask "$id" ec2 describe-security-group-rules --filters "Name=group-id,Values=$WEB_SG" \
    --query 'SecurityGroupRules[].[IsEgress,IpProtocol,FromPort,ToPort,ReferencedGroupInfo.GroupId]' \
    --output text || return 0
  if [[ $OUT == "True${TAB}"* || $OUT == *$'\n'"True${TAB}"* ]]; then
    fail "$id" 'the instances have an egress rule'
  elif [ "$OUT" = "False${TAB}tcp${TAB}80${TAB}80${TAB}$ALB_SG" ]; then
    pass "$id"
  else
    fail "$id" 'the instances accept traffic from elsewhere'
  fi
}
check_web_sg_rules

# 12: the private route table has only the local route: nothing leaves the VPC.
check_equal private-no-route-out "10.40.0.0/16${TAB}local" \
  'expected the private route table to hold only the local route' \
  ec2 describe-route-tables --route-table-ids "$PRIV_RT" \
  --query 'RouteTables[0].Routes[].[DestinationCidrBlock,GatewayId]' --output text

# 13: no NAT gateway in the VPC (one that is pending or available would bill by the hour).
check_equal no-nat-gateway '' \
  'expected no NAT gateway in the VPC' \
  ec2 describe-nat-gateways --filter "Name=vpc-id,Values=$VPC" \
  'Name=state,Values=pending,available' \
  --query 'NatGateways[].NatGatewayId' --output text

# ---- Live checks -------------------------------------------------------------------------------------

# 14: up to 60 polls until at least two targets are healthy. An error is one more try.
check_targets_healthy() {
  local id=targets-healthy try=1 state healthy
  while [ "$try" -le 60 ]; do
    run aws elbv2 describe-target-health --target-group-arn "$TG" \
      --query 'TargetHealthDescriptions[].TargetHealth.State' --output text
    if [ "$RC" -eq 0 ]; then
      healthy=0
      for state in $OUT; do
        if [ "$state" = healthy ]; then healthy=$((healthy + 1)); fi
      done
      if [ "$healthy" -ge 2 ]; then
        pass "$id"
        return 0
      fi
    fi
    if [ "$try" -lt 60 ]; then pause; fi
    try=$((try + 1))
  done
  fail "$id" 'fewer than two targets became healthy'
}
check_targets_healthy

# 15: up to 30 plain HTTP requests to the load balancer. Every answer of a request that worked must be
# the page of a lab instance (its ID and one of the two AZs); the check is ok as soon as both AZs have
# answered. A request that fails is one more try, and its output is ignored.
check_serves_both_azs() {
  local id=serves-both-azs try=1 seen_1=0 seen_2=0
  local pattern="^instance=i-[0-9a-f]{8,17} az=(${AZ_1}|${AZ_2})"'$'
  while [ "$try" -le 30 ]; do
    run curl -sS --max-time 5 "http://$DNS/"
    if [ "$RC" -eq 0 ]; then
      if [[ ! $OUT =~ $pattern ]]; then
        fail "$id" 'an answer did not come from a lab instance'
        return 0
      fi
      if [[ $OUT == *" az=$AZ_1" ]]; then seen_1=1; else seen_2=1; fi
      if [ "$seen_1" -eq 1 ] && [ "$seen_2" -eq 1 ]; then
        pass "$id"
        return 0
      fi
    fi
    if [ "$try" -lt 30 ]; then pause; fi
    try=$((try + 1))
  done
  fail "$id" 'the load balancer did not answer from both AZs'
}
check_serves_both_azs

# ---- End --------------------------------------------------------------------------------------------

if [ "$FAILED" -eq 0 ]; then
  echo "verify: ok ($PASSED passed, 0 skipped)"
  exit 0
fi
echo "verify: FAIL ($FAILED failed, $PASSED passed, 0 skipped)"
exit 1
