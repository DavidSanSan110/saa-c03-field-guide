# The consumer: a small Python function and the event source mapping that makes Lambda poll the source
# queue for it.

# The zip is built on the machine that runs Terraform. The same bytes must come out in the plan job and
# in the apply job of infra.yml (it compares a digest of the planned values), so: the archive provider
# zeroes the timestamps, output_file_mode fixes the file modes, and .gitattributes keeps the line
# endings of handler.py as LF.
data "archive_file" "handler" {
  type             = "zip"
  source_file      = "${path.module}/src/handler.py"
  output_path      = "${path.module}/.build/handler.zip"
  output_file_mode = "0644"
}

# The role of the function. Path /lab/ and the fg-workload-boundary permissions boundary are not
# optional: the boundary denies every role write, PassRole and AssumeRole outside
# arn:aws:iam::<account>:role/lab/*, and refuses to create a role without itself. The same denies are on
# the role that applies this stack, so without them the apply fails.
resource "aws_iam_role" "consumer" {
  name                 = local.role_name
  path                 = "/lab/"
  permissions_boundary = local.boundary_arn
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      },
    ]
  })
}

# An inline policy, not AWSLambdaSQSQueueExecutionRole: that managed policy grants logs:CreateLogGroup
# and the SQS actions on every queue. Here the role reads one queue and writes to one log group, and it
# cannot create a log group. Terraform creates the group (below) before the function exists. With
# logs:CreateLogGroup, an invocation after a destroy (a poller still running) could create the group
# again, with no retention and no tags. The role has nothing on the DLQ: SQS itself moves messages
# there.
resource "aws_iam_role_policy" "consumer" {
  name = "consume-orders"
  role = aws_iam_role.consumer.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConsumeSourceQueue"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.source.arn
      },
      {
        Sid      = "WriteOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.consumer.arn}:*"
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "consumer" {
  #checkov:skip=CKV_AWS_158:The log lines hold only order IDs and the group lives for one day; a customer managed KMS key adds a monthly fee and a key policy for nothing the lab teaches.
  #checkov:skip=CKV_AWS_338:One day of retention is the point: the lab is run and destroyed within a day, and the group is kept short on purpose.
  name              = local.log_group_name
  retention_in_days = 1
}

resource "aws_lambda_function" "consumer" {
  #checkov:skip=CKV_AWS_116:A dead-letter queue on the function is for asynchronous invocations; this function is polled from a queue, and the queue has its own DLQ.
  #checkov:skip=CKV_AWS_117:The function only talks to the public SQS and Logs endpoints; a VPC would need a NAT gateway or endpoints that bill by the hour.
  #checkov:skip=CKV_AWS_115:No reserved concurrency: a new account has a reduced concurrency quota, and a reservation could not be set.
  #checkov:skip=CKV_AWS_272:The zip is built and applied by the same pipeline from this repository; a code signing configuration is out of scope for a lab.
  #checkov:skip=CKV_AWS_50:X-Ray tracing is out of scope for the lab (spec 046) and adds nothing to the SQS lesson.
  function_name = local.function_name
  role          = aws_iam_role.consumer.arn
  runtime       = "python3.14"
  architectures = ["arm64"] # cheaper per GB-second than x86_64
  handler       = "handler.handler"
  memory_size   = 128
  timeout       = var.function_timeout_seconds

  filename         = data.archive_file.handler.output_path
  source_code_hash = data.archive_file.handler.output_base64sha256

  # The log group and the policy that allows writing to it must exist before the function does.
  depends_on = [
    aws_cloudwatch_log_group.consumer,
    aws_iam_role_policy.consumer,
  ]
}

# Lambda polls the queue and invokes the function with batches of up to 10 messages. With
# ReportBatchItemFailures the function answers with the IDs of the messages that failed: only those go
# back to the queue (and, after max_receive_count receives, to the DLQ); the rest of the batch is
# deleted. There is no scaling_config (maximum concurrency): with it, Lambda cannot scale its pollers
# down to 2 on a quiet queue.
resource "aws_lambda_event_source_mapping" "orders" {
  event_source_arn                   = aws_sqs_queue.source.arn
  function_name                      = aws_lambda_function.consumer.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = var.batching_window_seconds
  function_response_types            = ["ReportBatchItemFailures"]
  enabled                            = true

  # Lambda checks the role's SQS permissions and the redrive policy when it creates the mapping.
  depends_on = [
    aws_iam_role_policy.consumer,
    aws_sqs_queue_redrive_policy.source,
  ]
}
