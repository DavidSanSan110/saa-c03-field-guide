# Tests for labs/05-sqs-lambda-dlq (spec 046): the alarm on the dead-letter queue (AC-12).
# All runs use command = plan with a mock provider, so nothing touches AWS. The archive provider is the
# real one: it only zips a local file.
#
# The alarm has no actions: sets that are not configured are null in a plan, so they are checked with
# try() (null or empty).

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

# AC-12: what the alarm watches
run "ac12_alarm_metric" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_not_empty.alarm_name == "fg-lab05-orders-dlq-not-empty"
    error_message = "the alarm name is not fg-lab05-orders-dlq-not-empty"
  }

  assert {
    condition     = try(length(aws_cloudwatch_metric_alarm.dlq_not_empty.alarm_description) > 0, false)
    error_message = "the alarm needs a description (a message reached the DLQ)"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_not_empty.namespace == "AWS/SQS"
    error_message = "the alarm namespace is not AWS/SQS"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_not_empty.metric_name == "ApproximateNumberOfMessagesVisible"
    error_message = "the alarm metric is not ApproximateNumberOfMessagesVisible"
  }

  assert {
    condition     = jsonencode(aws_cloudwatch_metric_alarm.dlq_not_empty.dimensions) == jsonencode({ QueueName = "fg-lab05-orders-dlq" })
    error_message = "the alarm dimensions are not exactly { QueueName = 'fg-lab05-orders-dlq' } (the DLQ, not the source queue)"
  }
}

# AC-12: when it goes off
run "ac12_alarm_threshold" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_not_empty.statistic == "Maximum"
    error_message = "the alarm statistic is not Maximum"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_not_empty.period == 60
    error_message = "the alarm period is not 60"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_not_empty.evaluation_periods == 1
    error_message = "the alarm evaluation_periods is not 1"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_not_empty.threshold == 0
    error_message = "the alarm threshold is not 0"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_not_empty.comparison_operator == "GreaterThanThreshold"
    error_message = "the alarm comparison_operator is not GreaterThanThreshold"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_not_empty.treat_missing_data == "notBreaching"
    error_message = "the alarm treat_missing_data is not notBreaching"
  }
}

# AC-12: no action: no SNS topic, nobody is told
run "ac12_alarm_has_no_actions" {
  command = plan

  assert {
    condition     = try(length(aws_cloudwatch_metric_alarm.dlq_not_empty.alarm_actions) == 0, true)
    error_message = "the alarm must have no alarm_actions"
  }

  assert {
    condition     = try(length(aws_cloudwatch_metric_alarm.dlq_not_empty.ok_actions) == 0, true)
    error_message = "the alarm must have no ok_actions"
  }

  assert {
    condition     = try(length(aws_cloudwatch_metric_alarm.dlq_not_empty.insufficient_data_actions) == 0, true)
    error_message = "the alarm must have no insufficient_data_actions"
  }
}
