# Break lab 05 on purpose

Four experiments on the `sqs-lambda-dlq` diagram: a message that can never succeed, the way back out of
the dead-letter queue (DLQ), the setting that makes a batch partly fail, and the timeout rule. Run them
only in **your own stack** (see the [quick start](README.md#quick-start-in-your-own-account)), never on
a shared one. Use Git Bash on Windows, from `labs/05-sqs-lambda-dlq/`, and set the Region first:

```bash
export AWS_REGION=eu-west-1
```

They use the shell variables of [Observe](README.md#observe), step 1. If you opened a new terminal,
run that step again. Do the experiments in order: the second one redrives the message that the first
one leaves in the DLQ.

**Never remove or change the permissions boundary of the lab role.** `fg-workload-boundary` is the
guardrail that keeps lab roles inside the path `/lab/` and away from IAM users and access keys.
Nothing in this lab needs it changed.

Every break is done with the AWS CLI (or a local `terraform plan` that changes nothing) and put back
the same way, so Terraform sees no drift. The poller bills by the request while the lab exists, so
destroy the lab when you are done.

## Send a poison message

### What to do

Send a good order and a message that is not an order, in one batch (this is
[Observe](README.md#observe), step 2, if you have not done it yet), then follow the log:

```bash
aws sqs send-message-batch --queue-url "$SOURCE_URL" \
  --entries '[{"Id":"good","MessageBody":"{\"order_id\":\"o-1\"}"},{"Id":"poison","MessageBody":"not an order"}]'
MSYS_NO_PATHCONV=1 aws logs tail "$LOG_GROUP" --follow
```

Press Ctrl+C after the third `failed message` line. After about 3 × 35 seconds, look at the DLQ and the
alarm (Observe, steps 4 and 5).

### What you see

- `processed order o-1` once, and `failed message <id>` three times, 35 to 40 seconds apart (the
  visibility timeout plus the batching window).
- One message in the DLQ, and the alarm `fg-lab05-orders-dlq-not-empty` in `ALARM` after a minute or
  two.

### Why

The function answers with `ReportBatchItemFailures`: it names only the poison message, so Lambda
deletes the rest of the batch (the good order) and returns the poison message to the queue. One
`send-message-batch` does not promise one batch at the function: Lambda may deliver the two
messages in two invocations, and then the good order's batch simply succeeds. Each
return makes it visible again after the visibility timeout. The redrive policy counts the receives
(`maxReceiveCount` is 3), and when a message has used them all SQS moves it to the DLQ. Nothing about
the DLQ is in the function or its role. The Lambda documentation recommends a `maxReceiveCount` of
**at least 5**, because a message can be received without the function failing it (a throttled
invocation, for example). This lab uses 3 only to make the demo faster.

### Put it back

Leave the message in the DLQ: the next experiment redrives it.

## Redrive the dead-letter queue

### What to do

Start a move task from the DLQ. Without a destination, the messages go back to the queue they came
from. Then look at the task:

```bash
aws sqs start-message-move-task --source-arn "$DLQ_ARN"
aws sqs list-message-move-tasks --source-arn "$DLQ_ARN"
MSYS_NO_PATHCONV=1 aws logs tail "$LOG_GROUP" --follow
```

### What you see

- The task is `RUNNING`, then `COMPLETED` after it moved the messages of the DLQ. Right after the
  start the counter can lag: `COMPLETED` with `ApproximateNumberOfMessagesMoved` 0 for a few seconds.
  Run `list-message-move-tasks` again.
- The message comes back to the source queue, **with a new message ID**: the `failed message <id>`
  lines in the log now show an ID that differs from the first run. It fails 3 more times, because
  nothing fixed the consumer, and it ends in the DLQ again.

### Why

A redrive only moves messages. It does not fix whatever made them fail, so a poison message goes round
again. Fix the consumer first, then redrive. SQS allows one active move task per queue. The source
queue's redrive policy names this queue as its DLQ, which is what makes it a valid source for a move
task. The redrive allow policy (`byQueue`) only limits which queues may use it as their DLQ.

### Put it back

Nothing to undo, but wait until the DLQ holds the message again (about 3 × 35 seconds; Observe, step
4 shows how to check) before you start the next experiment. If the message is still going round,
"Turn off partial batch responses" would delete it from the source queue and its result would be
wrong.

## Turn off partial batch responses

### What to do

Clear the response types of the mapping, check it, wait until the state is `Enabled` again (about 15
seconds; it is `Updating` until then) and send the pair once more (a different order ID, so you can tell
the runs apart):

```bash
aws lambda update-event-source-mapping --uuid "$MAPPING" --function-response-types '[]'
aws lambda get-event-source-mapping --uuid "$MAPPING" --query '[State,FunctionResponseTypes]' --output text
aws sqs send-message-batch --queue-url "$SOURCE_URL" \
  --entries '[{"Id":"good","MessageBody":"{\"order_id\":\"o-2\"}"},{"Id":"poison","MessageBody":"not an order"}]'
MSYS_NO_PATHCONV=1 aws logs tail "$LOG_GROUP" --follow
```

### What you see

- The check prints only `Enabled`: the list is empty, so the text output has nothing to show for it.
- The function still returns the failure list, but Lambda ignores it. The invocation counts as a
  success, so the poison message is deleted as if it had been processed. `failed message <id>` shows
  **once**, not three times, and the message **never reaches the DLQ**: its count stays where it was.

### Why

Without `ReportBatchItemFailures`, only an exception fails a batch, and then the whole batch goes back
to the queue, good orders included. Our function never throws, so with the setting off a bad message is
silently lost. The setting is what makes "only the poison message fails" possible. (The CLI
documentation has no example of clearing the setting: `--function-response-types '[]'`, an empty JSON
list, does it.)

### Put it back

```bash
aws lambda update-event-source-mapping --uuid "$MAPPING" --function-response-types ReportBatchItemFailures
```

Check with `get-event-source-mapping` that the state is `Enabled` and the list holds
`ReportBatchItemFailures`.

## Break the timeout rule

### What to do

First ask Terraform. The rule is a validation on the variable, so the plan stops before it changes
anything (it may read a few resources first):

```bash
terraform plan -var visibility_timeout_seconds=10
```

Then go around Terraform and set the queue yourself. SQS accepts any visibility timeout:

```bash
aws sqs set-queue-attributes --queue-url "$SOURCE_URL" --attributes VisibilityTimeout=10
aws lambda update-event-source-mapping --uuid "$MAPPING" --batch-size 10
```

Wait until `get-event-source-mapping` shows `Enabled` again, then go below the function timeout of 5
seconds, the case the Lambda documentation says it checks:

```bash
aws sqs set-queue-attributes --queue-url "$SOURCE_URL" --attributes VisibilityTimeout=3
aws lambda update-event-source-mapping --uuid "$MAPPING" --batch-size 10
```

### What you see

- The plan fails with the message of the variable: `visibility_timeout_seconds must be at least 6
times the function timeout plus the batching window`. Terraform used 6 × 5 + 5 = 35 as the lower
  limit.
- `VisibilityTimeout=10` is accepted by SQS, and so is the mapping update: 10 seconds is longer than
  the 5-second function timeout. Six times is a recommendation, not a check.
- `VisibilityTimeout=3` is accepted by SQS. The Lambda documentation says Lambda checks the rule when
  you create or update a mapping and returns an error when the function timeout is longer than the
  visibility timeout; reports of that error show an `InvalidParameterValueException` that names both
  values. In a test run of this lab (November 2026) the update was **accepted** anyway, also when it
  changed the batch size, and the mapping stayed `Enabled` with a 3-second visibility timeout.

### Why

A message that is processed longer than its visibility timeout becomes visible again while the first
invocation still works on it, and is processed twice. The Lambda documentation asks for at least six
times the function timeout (plus the batching window), because invocations can be retried and a batch
waits for its window. AWS checks at most the weakest form, and only when a mapping is created or
updated; nothing checks a change to the queue afterwards, and the test run shows that even the update
check can let a too-short timeout through. So do not rely on AWS to catch it. Terraform's validation
is stricter on purpose, so a plan never produces a setup the documentation warns about.

### Put it back

```bash
aws sqs set-queue-attributes --queue-url "$SOURCE_URL" --attributes VisibilityTimeout=35
```

Then run `terraform plan` (with no `-var`): it shows no change.
