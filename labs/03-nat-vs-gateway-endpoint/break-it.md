# Break lab 03 on purpose

Two experiments, each one a route you remove to see what the `vpc-nat-vs-gateway-endpoint` diagram
depends on. Run them only in **your own stack** (see the
[quick start](README.md#quick-start-in-your-own-account)), never on a shared one. Use Git Bash on
Windows, from `labs/03-nat-vs-gateway-endpoint/`.

They use the shell variables of [Observe](README.md#observe), step 1, the objects that step 3 uploads
and the `big.bin` file that step 8 leaves on the instance. Run steps 1 to 8 first. If you opened a new
terminal, run step 1 again.

**Never remove or change the permissions boundary of the lab role.** `fg-workload-boundary` is the
guardrail that keeps lab roles inside the path `/lab/` and away from IAM users and access keys.
Nothing in this lab needs it changed.

Both breaks are done with the AWS CLI and put back the same way, so Terraform sees no drift. The
NAT gateway is billing the whole time, so do not leave for lunch with a route removed. Do them one
after the other, and destroy the lab the same day.

## Remove the endpoint route

### What to do

Take the private route table out of the endpoint. This deletes the prefix list route and nothing
else:

```bash
aws ec2 modify-vpc-endpoint --vpc-endpoint-id "$ENDPOINT" --remove-route-table-ids "$PRIVATE_RT"
```

Look at the routes again (Observe, step 2): the prefix list route goes away, and `0.0.0.0/0` to the
NAT gateway is the only way out. The list can still show the old route for a short while after S3
traffic has already moved to the NAT gateway. Print the two bucket names (`echo "$DATA" "$OTHER"`), because the
session cannot see them. Then open a session (`aws ssm start-session --target "$INSTANCE"`) and, on
the instance, go to /tmp and set the Region and the two bucket names as in Observe, step 6. Read the
object under `endpoint-only/`, then the object in the other bucket, then send the 5 MB file again:

```bash
cd /tmp
aws s3api get-object --bucket "$DATA" --key endpoint-only/probe.txt got.txt
aws s3api get-object --bucket "$OTHER" --key probe.txt got.txt && cat got.txt
aws s3 cp big.bin "s3://$DATA/big2.bin"
exit
```

Back on your machine, read the NAT gateway's bytes as in Observe, step 10, after a couple of
minutes.

### What you see

S3 still works, but now through the NAT gateway:

- The read under `endpoint-only/` is `AccessDenied`, "with an explicit deny in a resource-based
  policy". It is the bucket policy: the request no longer comes through the endpoint, so it carries no
  `aws:SourceVpce`, and the deny is true when that key is missing.
- **The other bucket can now be read.** It printed `lab 03 probe`, although it was refused before.
- The upload works, and `BytesOutToDestination` of the NAT gateway rises by about the size of the file,
  where the first 5 MB upload, through the endpoint, did not move it.

### Why

Removing the route changes the **path**. An endpoint policy only limits traffic that uses the
endpoint. With the route gone, S3 traffic leaves through the NAT gateway and the internet gateway to
the public S3 address, so the endpoint policy is never looked at. Do not count on an endpoint policy
as a guard against data leaving to the wrong bucket while another route to the internet exists. To
make that sure you would remove the way out, or add a bucket policy on the other side. The bucket
policy of the data bucket keeps refusing the read under `endpoint-only/`, because it asks for
`aws:SourceVpce`, which only a request through the endpoint carries. The NAT gateway's bytes rise
because it bills per GB: this is the cost angle of the diagram, and the reason to send S3 traffic
through a free gateway endpoint.

### Put it back

```bash
aws ec2 modify-vpc-endpoint --vpc-endpoint-id "$ENDPOINT" --add-route-table-ids "$PRIVATE_RT"
```

Read the routes again (Observe, step 2): the prefix list route is back. In a new session the read of
the other bucket is refused again, and the one under `endpoint-only/` works.

## Remove the NAT route

### What to do

Systems Manager reaches the instance through the NAT gateway, so this break takes the instance away
from Systems Manager. To keep seeing the instance, start a heartbeat **before** the route goes. For 60
rounds of 10 seconds, it asks the check address for the internet address, with a limit of 5 seconds,
and writes the answer (or `none`) and the time to `heartbeat.txt` in the data bucket. The write goes
through the endpoint, not the NAT gateway. The script holds no double quote, so it fits inside the
JSON of `--parameters`; `MSYS_NO_PATHCONV=1` stops Git Bash from rewriting the paths in it:

```bash
HEARTBEAT='for n in $(seq 60); do R=$(curl -s --max-time 5 https://checkip.amazonaws.com); echo $(date +%T) internet=${R:-none} | aws s3 cp - s3://'"$DATA"'/heartbeat.txt --region us-east-1; sleep 10; done'
MSYS_NO_PATHCONV=1 aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters '{"commands":["'"$HEARTBEAT"'"]}' --query Command.CommandId --output text | tr -d '\r'
```

Wait about 30 seconds for the first round (until then the read answers NoSuchKey). Read the
heartbeat, a few times:

```bash
aws s3api get-object --bucket "$DATA" --key heartbeat.txt heartbeat.txt > /dev/null && cat heartbeat.txt
```

It shows a time and the public IP of the NAT gateway. Now open a second terminal, run Observe,
step 1, in it (`$INSTANCE` is empty there until you do; set `AWS_PROFILE` there too if you exported
it in the first), open a session (`aws ssm start-session --target "$INSTANCE"`) and leave it open.
Then remove the route from the first one:

```bash
aws ec2 delete-route --route-table-id "$PRIVATE_RT" --destination-cidr-block 0.0.0.0/0
```

Read the heartbeat again every half minute, and ask Systems Manager what it sees of the instance:

```bash
aws s3api get-object --bucket "$DATA" --key heartbeat.txt heartbeat.txt > /dev/null && cat heartbeat.txt
aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE" \
  --query 'InstanceInformationList[0].PingStatus' --output text | tr -d '\r'
```

### What you see

The open session freezes, and a new one fails at once with `TargetNotConnected`. A Run Command sent
now stays `Pending`. Do not wait for `PingStatus` to say so: it can still show `Online` ten minutes
later, long before it turns `ConnectionLost`. But `heartbeat.txt` keeps changing: the time moves on
and the line now ends with `internet=none`. The instance is running and has no internet, and yet it
still writes to S3.

### Why

The SSM Agent reaches `ssm`, `ssmmessages` and `ec2messages` through the NAT gateway, so without the
route it can no longer keep the connection to Systems Manager, and the session dies with it. S3 does
not use the NAT gateway: its traffic takes the prefix list route of the endpoint, which is still
there, so the heartbeat reaches the bucket. Interface endpoints for the three Systems Manager
services would keep the agent online without a NAT route, for about $0.03 an hour more. This lab
leaves them out on purpose, because they would hide this lesson.

### Put it back

```bash
aws ec2 create-route --nat-gateway-id "$NAT" --route-table-id "$PRIVATE_RT" \
  --destination-cidr-block 0.0.0.0/0
```

The agent needs a couple of minutes to connect again: until then a new session still fails with
`TargetNotConnected`, and a `Pending` Run Command runs as soon as it is back. Open a new session to
check, or run `bash verify.sh`. The heartbeat stops by itself after its 60 rounds; delete `heartbeat.txt` from the
lab directory when you are done.
