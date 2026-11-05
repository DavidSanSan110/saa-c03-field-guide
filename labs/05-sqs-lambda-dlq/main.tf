module "tags" {
  source = "../../modules/tags"

  lab = "05-sqs-lambda-dlq"
}

# The account ID is read at plan time and never typed anywhere. Only account_id is used.
data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # The Region of the lab, for readers of the code. The provider block (providers.tf) sets the same
  # value as a literal, so that it is easy to see and to test.
  # tflint-ignore: terraform_unused_declarations
  region = "eu-west-1"

  # Created by bootstrap/workload: the boundary every lab role must carry. The lab can only attach
  # it, never create or change it.
  boundary_arn = "arn:aws:iam::${local.account_id}:policy/fg-workload-boundary"

  # Every name is fixed, so that verify.sh and the docs can name them. A queue name is unique per
  # account and Region; a second copy of the lab in the same account would fail on purpose.
  source_queue_name = "fg-lab05-orders"
  dlq_name          = "fg-lab05-orders-dlq"
  function_name     = "fg-lab05-orders-consumer"
  role_name         = "fg-lab05-consumer"
  log_group_name    = "/aws/lambda/fg-lab05-orders-consumer"
  alarm_name        = "fg-lab05-orders-dlq-not-empty"

  # A message that fails this many receives moves to the dead-letter queue. The diagram says 3, which
  # makes the demo fast; the Lambda documentation recommends at least 5 (see the README).
  max_receive_count = 3
}
