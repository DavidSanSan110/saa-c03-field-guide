# Tests for labs/05-sqs-lambda-dlq (spec 046): the consumer role, its trust policy and inline policy,
# the log group, the function and the event source mapping (AC-7, AC-8, AC-9, AC-10, AC-11).
# All runs use command = plan with a mock provider, so nothing touches AWS. The archive provider is the
# real one: it only zips src/handler.py, and the function's source_code_hash is compared with the hash
# it computes.
#
# The ARNs that AWS computes and that the assertions read are overridden during plan. Policies are
# jsonencode() of values, so they are asserted on jsondecode(<resource>.<policy>). Objects are compared
# as jsonencode() text: jsonencode sorts the keys of an object, so the comparison does not depend on
# the order the stack writes them in, and it tells a string from a list. Lists of actions and resources
# are compared sorted and flattened, so a single string and a one-item list mean the same. The order of
# the two statements of the inline policy is part of the contract (a list comparison). Nested blocks
# that must be absent are checked with try(): an absent block is an empty list, or null.

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
  target          = aws_iam_role.consumer
  override_during = plan
  values = {
    arn = "arn:aws:iam::111111111111:role/lab/fg-lab05-consumer"
  }
}

override_resource {
  target          = aws_cloudwatch_log_group.consumer
  override_during = plan
  values = {
    arn = "arn:aws:logs:eu-west-1:111111111111:log-group:/aws/lambda/fg-lab05-orders-consumer"
  }
}

override_resource {
  target          = aws_lambda_function.consumer
  override_during = plan
  values = {
    arn = "arn:aws:lambda:eu-west-1:111111111111:function:fg-lab05-orders-consumer"
  }
}

override_resource {
  target          = aws_lambda_event_source_mapping.orders
  override_during = plan
  values = {
    uuid = "9f2c1d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"
  }
}

# AC-7: the role carries the path and the boundary that bootstrap/workload requires
run "ac7_role" {
  command = plan

  assert {
    condition     = aws_iam_role.consumer.name == "fg-lab05-consumer"
    error_message = "the role name is not fg-lab05-consumer"
  }

  assert {
    condition     = aws_iam_role.consumer.path == "/lab/"
    error_message = "the role path is not /lab/ (fg-workload-boundary lets CI write only roles under it)"
  }

  assert {
    condition     = aws_iam_role.consumer.permissions_boundary == "arn:aws:iam::111111111111:policy/fg-workload-boundary"
    error_message = "the role permissions boundary is not arn:aws:iam::<account_id>:policy/fg-workload-boundary"
  }

  assert {
    condition     = aws_iam_role.consumer.max_session_duration == 3600
    error_message = "the role max_session_duration is not 3600"
  }
}

# AC-7: only the Lambda service can assume the role, with no condition
run "ac7_trust_policy" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role.consumer.assume_role_policy).Version == "2012-10-17"
    error_message = "the trust policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.consumer.assume_role_policy).Statement) == 1
    error_message = "the trust policy must have exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_iam_role.consumer.assume_role_policy).Statement[0].Effect == "Allow"
    error_message = "the trust policy statement is not an Allow"
  }

  assert {
    condition     = jsonencode(jsondecode(aws_iam_role.consumer.assume_role_policy).Statement[0].Principal) == jsonencode({ Service = "lambda.amazonaws.com" })
    error_message = "the trust policy Principal is not exactly { Service = 'lambda.amazonaws.com' }"
  }

  assert {
    condition     = jsonencode(jsondecode(aws_iam_role.consumer.assume_role_policy).Statement[0].Action) == jsonencode("sts:AssumeRole")
    error_message = "the trust policy Action is not exactly 'sts:AssumeRole' (a string)"
  }

  assert {
    condition     = !contains(keys(jsondecode(aws_iam_role.consumer.assume_role_policy).Statement[0]), "Condition")
    error_message = "the trust policy statement must have no Condition"
  }
}

# AC-8: the inline policy: two statements, in this order, with exactly these actions and resources
run "ac8_inline_policy_name_and_role" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.consumer.name == "consume-orders"
    error_message = "the inline policy name is not consume-orders"
  }

  assert {
    condition     = aws_iam_role_policy.consumer.role == "fg-lab05-consumer"
    error_message = "the inline policy is not on the role fg-lab05-consumer"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.consumer.policy).Version == "2012-10-17"
    error_message = "the inline policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.consumer.policy).Statement) == 2
    error_message = "the inline policy must have exactly two statements"
  }
}

run "ac8_consume_source_queue" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role_policy.consumer.policy).Statement[0].Sid == "ConsumeSourceQueue"
    error_message = "statement 1 of the inline policy is not ConsumeSourceQueue"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.consumer.policy).Statement[0].Effect == "Allow"
    error_message = "statement 1 of the inline policy is not an Allow"
  }

  assert {
    condition     = jsonencode(sort(flatten([jsondecode(aws_iam_role_policy.consumer.policy).Statement[0].Action]))) == jsonencode(["sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"])
    error_message = "statement 1 must allow exactly sqs:ReceiveMessage, sqs:DeleteMessage and sqs:GetQueueAttributes"
  }

  assert {
    condition     = jsonencode(flatten([jsondecode(aws_iam_role_policy.consumer.policy).Statement[0].Resource])) == jsonencode(["arn:aws:sqs:eu-west-1:111111111111:fg-lab05-orders"])
    error_message = "statement 1 must be on exactly the source queue ARN"
  }

  assert {
    condition     = jsonencode(sort(keys(jsondecode(aws_iam_role_policy.consumer.policy).Statement[0]))) == jsonencode(["Action", "Effect", "Resource", "Sid"])
    error_message = "statement 1 must have exactly the keys Sid, Effect, Action and Resource (no Condition, no Principal)"
  }
}

run "ac8_write_own_logs" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role_policy.consumer.policy).Statement[1].Sid == "WriteOwnLogs"
    error_message = "statement 2 of the inline policy is not WriteOwnLogs"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.consumer.policy).Statement[1].Effect == "Allow"
    error_message = "statement 2 of the inline policy is not an Allow"
  }

  assert {
    condition     = jsonencode(sort(flatten([jsondecode(aws_iam_role_policy.consumer.policy).Statement[1].Action]))) == jsonencode(["logs:CreateLogStream", "logs:PutLogEvents"])
    error_message = "statement 2 must allow exactly logs:CreateLogStream and logs:PutLogEvents (no logs:CreateLogGroup)"
  }

  assert {
    condition     = jsonencode(flatten([jsondecode(aws_iam_role_policy.consumer.policy).Statement[1].Resource])) == jsonencode(["arn:aws:logs:eu-west-1:111111111111:log-group:/aws/lambda/fg-lab05-orders-consumer:*"])
    error_message = "statement 2 must be on exactly the log group ARN followed by :*"
  }

  assert {
    condition     = jsonencode(sort(keys(jsondecode(aws_iam_role_policy.consumer.policy).Statement[1]))) == jsonencode(["Action", "Effect", "Resource", "Sid"])
    error_message = "statement 2 must have exactly the keys Sid, Effect, Action and Resource (no Condition, no Principal)"
  }
}

run "ac8_no_wildcard_action_and_nothing_on_the_dlq" {
  command = plan

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.consumer.policy).Statement :
      alltrue([for action in flatten([statement.Action]) : !strcontains(action, "*")])
    ])
    error_message = "no action of the inline policy may contain a wildcard"
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.consumer.policy).Statement :
      alltrue([for resource in flatten([statement.Resource]) : !strcontains(resource, "fg-lab05-orders-dlq")])
    ])
    error_message = "no statement of the inline policy may name the dead-letter queue"
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.consumer.policy).Statement :
      !contains(flatten([statement.Action]), "logs:CreateLogGroup")
    ])
    error_message = "the inline policy must not allow logs:CreateLogGroup"
  }
}

# AC-9: the log group exists before the function and keeps logs for one day
run "ac9_log_group" {
  command = plan

  assert {
    condition     = aws_cloudwatch_log_group.consumer.name == "/aws/lambda/fg-lab05-orders-consumer"
    error_message = "the log group name is not /aws/lambda/fg-lab05-orders-consumer"
  }

  assert {
    condition     = aws_cloudwatch_log_group.consumer.retention_in_days == 1
    error_message = "the log group retention is not 1 day"
  }
}

# AC-10: the function
run "ac10_function" {
  command = plan

  assert {
    condition     = aws_lambda_function.consumer.function_name == "fg-lab05-orders-consumer"
    error_message = "the function name is not fg-lab05-orders-consumer"
  }

  assert {
    condition     = aws_lambda_function.consumer.role == "arn:aws:iam::111111111111:role/lab/fg-lab05-consumer"
    error_message = "the function does not use the role ARN of fg-lab05-consumer"
  }

  assert {
    condition     = aws_lambda_function.consumer.runtime == "python3.14"
    error_message = "the function runtime is not python3.14"
  }

  assert {
    condition     = jsonencode(aws_lambda_function.consumer.architectures) == jsonencode(["arm64"])
    error_message = "the function architectures are not exactly ['arm64']"
  }

  assert {
    condition     = aws_lambda_function.consumer.handler == "handler.handler"
    error_message = "the function handler is not handler.handler"
  }

  assert {
    condition     = aws_lambda_function.consumer.timeout == 5
    error_message = "the function timeout is not 5 seconds"
  }

  assert {
    condition     = aws_lambda_function.consumer.memory_size == 128
    error_message = "the function memory_size is not 128"
  }
}

run "ac10_function_code_hash" {
  command = plan

  assert {
    condition     = aws_lambda_function.consumer.source_code_hash == data.archive_file.handler.output_base64sha256
    error_message = "the function source_code_hash is not the output_base64sha256 of the archive"
  }

  assert {
    condition     = data.archive_file.handler.output_base64sha256 != ""
    error_message = "the archive has no hash: src/handler.py was not zipped"
  }
}

run "ac10_function_has_no_environment_and_no_vpc" {
  command = plan

  assert {
    condition     = try(length(aws_lambda_function.consumer.environment) == 0, true)
    error_message = "the function must have no environment block"
  }

  assert {
    condition     = try(length(aws_lambda_function.consumer.vpc_config) == 0, true)
    error_message = "the function must have no vpc_config block"
  }
}

# AC-11: the event source mapping
run "ac11_mapping" {
  command = plan

  assert {
    condition     = aws_lambda_event_source_mapping.orders.event_source_arn == "arn:aws:sqs:eu-west-1:111111111111:fg-lab05-orders"
    error_message = "the mapping does not read the source queue ARN"
  }

  assert {
    condition     = contains(["arn:aws:lambda:eu-west-1:111111111111:function:fg-lab05-orders-consumer", "fg-lab05-orders-consumer"], aws_lambda_event_source_mapping.orders.function_name)
    error_message = "the mapping does not invoke the consumer function"
  }

  assert {
    condition     = aws_lambda_event_source_mapping.orders.batch_size == 10
    error_message = "the mapping batch_size is not 10"
  }

  assert {
    condition     = aws_lambda_event_source_mapping.orders.maximum_batching_window_in_seconds == 5
    error_message = "the mapping maximum_batching_window_in_seconds is not 5"
  }

  assert {
    condition     = jsonencode(aws_lambda_event_source_mapping.orders.function_response_types) == jsonencode(["ReportBatchItemFailures"])
    error_message = "the mapping function_response_types are not exactly ['ReportBatchItemFailures']"
  }

  assert {
    condition     = aws_lambda_event_source_mapping.orders.enabled == true
    error_message = "the mapping is not enabled"
  }

  assert {
    condition     = try(length(aws_lambda_event_source_mapping.orders.scaling_config) == 0, true)
    error_message = "the mapping must have no scaling_config block (no maximum concurrency)"
  }
}
