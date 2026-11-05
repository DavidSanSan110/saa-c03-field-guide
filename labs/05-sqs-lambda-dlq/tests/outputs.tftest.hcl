# Tests for labs/05-sqs-lambda-dlq (spec 046): the eight outputs (AC-14).
# All runs use command = plan with a mock provider, so nothing touches AWS. The archive provider is the
# real one: it only zips a local file.
#
# The queues' URLs and ARNs and the mapping's UUID are computed by AWS, so they are overridden during
# plan; the outputs must hand them on unchanged. The names are plain strings.

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

override_resource {
  target          = aws_lambda_event_source_mapping.orders
  override_during = plan
  values = {
    uuid = "9f2c1d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"
  }
}

# AC-14: the queues
run "ac14_queue_outputs" {
  command = plan

  assert {
    condition     = output.source_queue_url == "https://sqs.eu-west-1.amazonaws.com/111111111111/fg-lab05-orders"
    error_message = "output source_queue_url is not the URL of the source queue"
  }

  assert {
    condition     = output.source_queue_arn == "arn:aws:sqs:eu-west-1:111111111111:fg-lab05-orders"
    error_message = "output source_queue_arn is not the ARN of the source queue"
  }

  assert {
    condition     = output.dlq_url == "https://sqs.eu-west-1.amazonaws.com/111111111111/fg-lab05-orders-dlq"
    error_message = "output dlq_url is not the URL of the dead-letter queue"
  }

  assert {
    condition     = output.dlq_arn == "arn:aws:sqs:eu-west-1:111111111111:fg-lab05-orders-dlq"
    error_message = "output dlq_arn is not the ARN of the dead-letter queue"
  }
}

# AC-14: the function, the mapping, the log group and the alarm
run "ac14_other_outputs" {
  command = plan

  assert {
    condition     = output.function_name == "fg-lab05-orders-consumer"
    error_message = "output function_name is not fg-lab05-orders-consumer"
  }

  assert {
    condition     = output.event_source_mapping_uuid == "9f2c1d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"
    error_message = "output event_source_mapping_uuid is not the UUID of the mapping"
  }

  assert {
    condition     = output.log_group_name == "/aws/lambda/fg-lab05-orders-consumer"
    error_message = "output log_group_name is not /aws/lambda/fg-lab05-orders-consumer"
  }

  assert {
    condition     = output.alarm_name == "fg-lab05-orders-dlq-not-empty"
    error_message = "output alarm_name is not fg-lab05-orders-dlq-not-empty"
  }
}
