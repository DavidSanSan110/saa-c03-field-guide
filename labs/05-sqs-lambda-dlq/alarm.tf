# Goes to ALARM when the DLQ holds a message. No actions: there is no SNS topic, so the alarm is only
# something to look at (describe-alarms, or the console). A missing data point is not a breach: an
# empty queue that is not reporting must not look like a problem.
resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name        = local.alarm_name
  alarm_description = "A message reached the dead-letter queue of lab 05: the consumer failed it ${local.max_receive_count} receives in a row."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}
