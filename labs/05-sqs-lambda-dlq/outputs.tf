output "source_queue_url" {
  description = "URL of the source queue (orders). Send messages to it."
  value       = aws_sqs_queue.source.url
}

output "source_queue_arn" {
  description = "ARN of the source queue (orders)."
  value       = aws_sqs_queue.source.arn
}

output "dlq_url" {
  description = "URL of the dead-letter queue (orders-dlq)."
  value       = aws_sqs_queue.dlq.url
}

output "dlq_arn" {
  description = "ARN of the dead-letter queue. It is the source of a redrive (start-message-move-task)."
  value       = aws_sqs_queue.dlq.arn
}

output "function_name" {
  description = "Name of the consumer Lambda function."
  value       = aws_lambda_function.consumer.function_name
}

output "event_source_mapping_uuid" {
  description = "UUID of the event source mapping between the source queue and the function. break-it.md changes it."
  value       = aws_lambda_event_source_mapping.orders.uuid
}

output "log_group_name" {
  description = "Name of the CloudWatch Logs group of the function (kept for one day)."
  value       = aws_cloudwatch_log_group.consumer.name
}

output "alarm_name" {
  description = "Name of the alarm that goes off when the dead-letter queue holds a message."
  value       = aws_cloudwatch_metric_alarm.dlq_not_empty.alarm_name
}
