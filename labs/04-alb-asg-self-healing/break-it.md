# Break lab 04 on purpose

Three experiments on the `alb-asg-az-failure` diagram: terminate an instance and watch the Auto Scaling
group replace it, break the health check and watch the load balancer fail open, and shift traffic away
from one AZ with a zonal shift. Run them only in **your own stack** (see the
[quick start](README.md#quick-start-in-your-own-account)), never on a shared one. Use Git Bash on
Windows, from `labs/04-alb-asg-self-healing/`, and set the Region first:

```bash
export AWS_REGION=eu-west-1
```

Run [Observe](README.md#observe), step 1, in every terminal you use: it sets `DNS`, `ALB`, `TG`, `ASG`
and the two AZ names `AZ1` and `AZ2`. Keep a request loop running in a second terminal during all
three experiments. `curl` opens a new connection for each request, so it follows the changes at once:

```bash
while true; do curl -sS --max-time 5 "http://$DNS/" || echo "no answer"; sleep 2; done
```

Do the experiments in order, and wait for the "Put it back" check of each one before you start the
next.

Every break is done with the AWS CLI and put back the same way, so Terraform sees no drift. The load
balancer and the instances bill by the hour, so destroy the lab when you are done.

## Terminate an instance

### What to do

Pick the instance in the first AZ, then terminate it. Watch the targets and the scaling activities
from the first terminal, and repeat the two watch commands every ten seconds or so:

```bash
VICTIM=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" \
  --query "AutoScalingGroups[0].Instances[?AvailabilityZone=='$AZ1'].InstanceId | [0]" --output text | tr -d '\r')
aws ec2 terminate-instances --instance-ids "$VICTIM"
```

```bash
aws elbv2 describe-target-health --target-group-arn "$TG" \
  --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State,TargetHealth.Reason]' --output table
aws autoscaling describe-scaling-activities --auto-scaling-group-name "$ASG" \
  --query 'Activities[].[StartTime,StatusCode,Description]' --output table
```

### What you see

- The target of the terminated instance goes to `draining` (reason `Target.DeregistrationInProgress`).
  The lab sets a deregistration delay of 30 seconds, so it does not stay long. Depending on timing you
  may see it `unhealthy` first.
- The request loop answers only from the instance in the other AZ.
- `describe-scaling-activities` shows the termination and then a launch of a replacement.
- The new instance appears as a target in `initial` (reason `Elb.InitialHealthChecking`) and turns
  `healthy` after its health checks pass. Then both AZs answer again.

How long the replacement takes is not stated in the documentation, so time it and note the result.
Check in which AZ it starts too. The group balances its AZs, so expect the AZ that lost its instance;
the documentation does not promise this for a single replacement.

### Why

The group keeps its desired capacity of 2. The documentation says that a manual termination of an
instance in a group launches a replacement to maintain the desired capacity, so the replacement
follows the termination. (Rebalancing is a different event: when a group moves capacity between AZs,
it launches new instances before it terminates the earlier ones. That does not describe this
experiment.) The load balancer sends no new requests to a target that is deregistering, so the loop
shifts to the surviving instance while the replacement boots.

Terminating through Auto Scaling gives the same result: with `--no-should-decrement-desired-capacity`
the group launches a replacement after the instance terminates. To try it, wait until two targets are
`healthy` again, then, instead of `terminate-instances`, pick a running instance (not the one you
terminated above, which is gone) and run:

```bash
VICTIM2=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" \
  --query "AutoScalingGroups[0].Instances[?LifecycleState=='InService'].InstanceId | [0]" --output text | tr -d '\r')
aws autoscaling terminate-instance-in-auto-scaling-group --instance-id "$VICTIM2" \
  --no-should-decrement-desired-capacity
```

With `--should-decrement-desired-capacity` the group would shrink instead of replacing the instance.

### Put it back

Nothing: the group healed itself. Wait until `describe-target-health` shows two `healthy` targets.

## Break the health check

### What to do

Point the health check at a path that does not exist. The servers stay fine, only the check is wrong.
`MSYS_NO_PATHCONV=1` stops Git Bash from rewriting an argument that starts with `/` into a Windows path:

```bash
MSYS_NO_PATHCONV=1 aws elbv2 modify-target-group --target-group-arn "$TG" --health-check-path /missing
```

Watch the targets (the first command of the previous section) and the scaling activities, and keep the
request loop running.

### What you see

- After two failed checks (about 20 seconds with the lab's settings) both targets are `unhealthy`, with
  the reason `Target.ResponseCodeMismatch` and a description that says the health checks failed with
  the code 404.
- The request loop still gets answers. With every target unhealthy, the load balancer **fails open**:
  it sends requests to all targets anyway. The pages are fine, so the answers are right.
- Soon after they turn unhealthy, the group replaces them: their grace period ended long ago. Each new
  instance gets 120 seconds of grace, then fails the same check and is replaced in turn, round after
  round. Each round costs a few instance-minutes. You may see gaps in the loop while a round replaces
  the instances. How fast the rounds follow each other is not stated in the documentation, so watch
  `describe-scaling-activities` and note it.

### Why

With `health_check_type = "ELB"` the group trusts the load balancer: when the load balancer reports a
registered instance as unhealthy, the group marks it unhealthy on its next periodic health check and
replaces it. A wrong check, as here, therefore replaces servers that work. With EC2 status checks only
(the default), nothing would be replaced, because the instances pass those. The grace period only stops
the group from judging an instance that is still starting. The fail-open behaviour is the load
balancer's last resort: when no target is healthy, an answer from a target that may be fine is better
than none.

### Put it back

Restore the path. Again `MSYS_NO_PATHCONV=1`, for the leading `/`:

```bash
MSYS_NO_PATHCONV=1 aws elbv2 modify-target-group --target-group-arn "$TG" --health-check-path /
```

Wait until two targets are `healthy` (`describe-target-health`) before the next section. The instance
IDs may be different from the start: the group replaced them. A `terraform plan` should show no
change, because the path is `/` again.

## Shift traffic away from one AZ

### What to do

A zonal shift needs the AZ ID of the zone (`ZoneId`, like `euw1-az1`), not its name. AZ IDs differ from
account to account, so look it up and never type one. Then check that the load balancer is a managed
resource of zonal shift, and start a 30-minute shift away from the first AZ. `--comment` is required
(it may be empty). Keep the `zonalShiftId`:

```bash
AZ1_ID=$(aws ec2 describe-availability-zones --zone-names "$AZ1" --query 'AvailabilityZones[0].ZoneId' --output text | tr -d '\r')
aws arc-zonal-shift get-managed-resource --resource-identifier "$ALB"
SHIFT=$(aws arc-zonal-shift start-zonal-shift --resource-identifier "$ALB" --away-from "$AZ1_ID" \
  --expires-in 30m --comment "lab 04" --query zonalShiftId --output text | tr -d '\r')
```

Then watch the request loop and the targets:

```bash
aws elbv2 describe-target-health --target-group-arn "$TG" \
  --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State,AdministrativeOverride.State]' --output table
```

### What you see

- After a short while the request loop answers only from the other AZ.
- Both targets stay `healthy`. `describe-target-health` shows `zonal_shift_active` as the
  `AdministrativeOverride` state of the target in the shifted AZ. The health check has no idea that
  anything is wrong.
- The Auto Scaling group does nothing: it is not opted in to zonal shift.

A browser may keep using the shifted AZ for a while, because the ALB keeps a client connection open for
3600 seconds by default (`client_keep_alive`). `curl` opens a new connection for each request, so it
follows the shift.

### Why

A zonal shift moves traffic away from a zone that looks fine to the health checks but is not (a gray
failure), without waiting for anything to turn unhealthy. Because cross-zone load balancing is always
on for an ALB, a shift blocks all traffic to the targets in the shifted AZ and removes the load
balancer's address for that AZ from DNS. It is free and expires on its own. A zonal shift has no effect
while the load balancer fails open, which is why this experiment comes after the health check is put
back. A group that is opted in to zonal shift (`AvailabilityZoneImpairmentPolicy`, see the
[README](README.md#zonal-shift-on-the-group)) would also launch new capacity only in the other AZs.

### Put it back

Cancel the shift, or let it expire after 30 minutes:

```bash
aws arc-zonal-shift cancel-zonal-shift --zonal-shift-id "$SHIFT"
```

Wait a little, and both AZs answer in the loop again. Then run `terraform plan`: it should show no change.
Destroy the lab when you are done ([Destroy now](README.md#destroy-now)).
