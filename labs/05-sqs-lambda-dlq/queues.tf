# The source queue and its dead-letter queue (DLQ). Both are standard queues with SSE-SQS (keys owned
# by SQS: no KMS key, no KMS charge, and the redrive needs no kms: permission).

resource "aws_sqs_queue" "source" {
  name                       = local.source_queue_name
  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = 345600 # 4 days, the SQS default
  sqs_managed_sse_enabled    = true

  # No redrive_policy here: aws_sqs_queue_redrive_policy.source sets it. The DLQ must exist first,
  # and keeping the two apart lets the dead-letter queue and the redrive allow policy point at each
  # other without a cycle.
}

resource "aws_sqs_queue" "dlq" {
  name = local.dlq_name

  # 14 days against 4 on the source queue. For a standard queue a message expires by its ORIGINAL
  # enqueue time, also after it moved to the DLQ, so a DLQ with the same retention could lose the
  # message before anyone looked at it.
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

# After max_receive_count receives that did not end in a delete, SQS moves the message to the DLQ.
resource "aws_sqs_queue_redrive_policy" "source" {
  queue_url = aws_sqs_queue.source.url

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = local.max_receive_count
  })
}

# Only the source queue may use this DLQ.
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.url

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.source.arn]
  })
}
