# Tests for labs/05-sqs-lambda-dlq (spec 046): the source queue, the dead-letter queue, the redrive
# policy and the redrive allow policy (AC-5, AC-6).
# All runs use command = plan with a mock provider, so nothing touches AWS. The archive provider is the
# real one: it only zips a local file.
#
# Names are plain strings, so they are known at plan time. The ARNs and URLs of the two queues are
# computed by AWS, so they are overridden during plan: the policies below refer to them. The policies
# are jsonencode() of values, so they are asserted on jsondecode(<resource>.<policy>), compared as
# jsonencode() text: jsonencode sorts the keys of an object, so the comparison does not depend on the
# order the stack writes them in, and it tells a number from a string and a list from a string.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
}

override_resource {
  target          = aws_sqs_queue.source
  override_during = plan
  values = {
    id  = "https://sqs.eu-west-1.amazonaws.com/111111111111/fg-lab05-orders"
    url = "https://sqs.eu-west-1.amazonaws.com/111111111111/fg-lab05-orders"
    arn = "arn:aws:sqs:eu-west-1:111111111111:fg-lab05-orders"
  }
}

override_resource {
  target          = aws_sqs_queue.dlq
  override_during = plan
  values = {
    id  = "https://sqs.eu-west-1.amazonaws.com/111111111111/fg-lab05-orders-dlq"
    url = "https://sqs.eu-west-1.amazonaws.com/111111111111/fg-lab05-orders-dlq"
    arn = "arn:aws:sqs:eu-west-1:111111111111:fg-lab05-orders-dlq"
  }
}

# AC-5: the source queue
run "ac5_source_queue" {
  command = plan

  assert {
    condition     = aws_sqs_queue.source.name == "fg-lab05-orders"
    error_message = "the source queue name is not fg-lab05-orders"
  }

  assert {
    condition     = aws_sqs_queue.source.visibility_timeout_seconds == 35
    error_message = "the source queue visibility timeout is not 35 (6 x 5 + 5)"
  }

  assert {
    condition     = aws_sqs_queue.source.message_retention_seconds == 345600
    error_message = "the source queue retention is not 345600 (4 days)"
  }

  assert {
    condition     = aws_sqs_queue.source.sqs_managed_sse_enabled == true
    error_message = "the source queue must use SSE-SQS"
  }
}

# AC-5: the dead-letter queue
run "ac5_dead_letter_queue" {
  command = plan

  assert {
    condition     = aws_sqs_queue.dlq.name == "fg-lab05-orders-dlq"
    error_message = "the dead-letter queue name is not fg-lab05-orders-dlq"
  }

  assert {
    condition     = aws_sqs_queue.dlq.message_retention_seconds == 1209600
    error_message = "the dead-letter queue retention is not 1209600 (14 days)"
  }

  assert {
    condition     = aws_sqs_queue.dlq.sqs_managed_sse_enabled == true
    error_message = "the dead-letter queue must use SSE-SQS"
  }
}

# AC-5: the DLQ keeps messages longer than the source queue (a message expires from its original
# enqueue time, so the DLQ needs the longer retention)
run "ac5_dlq_retention_is_longer_than_the_source" {
  command = plan

  assert {
    condition     = aws_sqs_queue.dlq.message_retention_seconds > aws_sqs_queue.source.message_retention_seconds
    error_message = "the DLQ retention must be longer than the source queue retention"
  }
}

# AC-6: the redrive policy is on the source queue and points at the DLQ after 3 receives
run "ac6_redrive_policy" {
  command = plan

  assert {
    condition     = aws_sqs_queue_redrive_policy.source.queue_url == "https://sqs.eu-west-1.amazonaws.com/111111111111/fg-lab05-orders"
    error_message = "the redrive policy is not on the URL of the source queue"
  }

  assert {
    condition = jsonencode(jsondecode(aws_sqs_queue_redrive_policy.source.redrive_policy)) == jsonencode({
      deadLetterTargetArn = "arn:aws:sqs:eu-west-1:111111111111:fg-lab05-orders-dlq"
      maxReceiveCount     = 3
    })
    error_message = "the redrive policy must be exactly deadLetterTargetArn = the DLQ ARN and maxReceiveCount = 3 (a number)"
  }

  assert {
    condition     = jsonencode(sort(keys(jsondecode(aws_sqs_queue_redrive_policy.source.redrive_policy)))) == jsonencode(["deadLetterTargetArn", "maxReceiveCount"])
    error_message = "the redrive policy must have exactly the keys deadLetterTargetArn and maxReceiveCount"
  }
}

# AC-6: only the source queue may use the DLQ
run "ac6_redrive_allow_policy" {
  command = plan

  assert {
    condition     = aws_sqs_queue_redrive_allow_policy.dlq.queue_url == "https://sqs.eu-west-1.amazonaws.com/111111111111/fg-lab05-orders-dlq"
    error_message = "the redrive allow policy is not on the URL of the DLQ"
  }

  assert {
    condition = jsonencode(jsondecode(aws_sqs_queue_redrive_allow_policy.dlq.redrive_allow_policy)) == jsonencode({
      redrivePermission = "byQueue"
      sourceQueueArns   = ["arn:aws:sqs:eu-west-1:111111111111:fg-lab05-orders"]
    })
    error_message = "the redrive allow policy must be exactly redrivePermission = byQueue and sourceQueueArns = [the source queue ARN]"
  }

  assert {
    condition     = jsonencode(sort(keys(jsondecode(aws_sqs_queue_redrive_allow_policy.dlq.redrive_allow_policy)))) == jsonencode(["redrivePermission", "sourceQueueArns"])
    error_message = "the redrive allow policy must have exactly the keys redrivePermission and sourceQueueArns"
  }
}
