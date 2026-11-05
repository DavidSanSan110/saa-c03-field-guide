# Tests for labs/05-sqs-lambda-dlq (spec 046): the three variables and their validations (AC-13),
# including the rule of the Lambda docs: the visibility timeout is at least 6 times the function
# timeout plus the batching window.
# All runs use command = plan with a mock provider, so nothing touches AWS. The archive provider is the
# real one: it only zips a local file.
#
# expect_failures cannot check a message, so the text of the error message is checked by
# lab-05-sqs-lambda-dlq.test.ts. A run that expects a failure of one variable sets the other two so
# that their own validations pass: otherwise two variables would fail and the run would not tell which
# validation did its job.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
}

# AC-13: the defaults are valid on their own (35 = 6 x 5 + 5, exactly on the boundary)
run "ac13_defaults" {
  command = plan

  assert {
    condition     = aws_lambda_function.consumer.timeout == 5 && aws_lambda_event_source_mapping.orders.maximum_batching_window_in_seconds == 5 && aws_sqs_queue.source.visibility_timeout_seconds == 35
    error_message = "the defaults are not function timeout 5, batching window 5 and visibility timeout 35"
  }
}

# AC-13: other values flow into the function, the mapping and the queue; 60 = 6 x 10 + 0 is exactly on
# the boundary
run "ac13_values_are_used" {
  command = plan

  variables {
    function_timeout_seconds   = 10
    batching_window_seconds    = 0
    visibility_timeout_seconds = 60
  }

  assert {
    condition     = aws_lambda_function.consumer.timeout == 10
    error_message = "function_timeout_seconds is not used by the function"
  }

  assert {
    condition     = aws_sqs_queue.source.visibility_timeout_seconds == 60
    error_message = "visibility_timeout_seconds is not used by the source queue"
  }

  assert {
    condition     = aws_lambda_event_source_mapping.orders.maximum_batching_window_in_seconds == 0
    error_message = "batching_window_seconds is not used by the mapping"
  }
}

# AC-13: the upper limits are valid: 900 seconds of function timeout, 300 of window, 43200 of visibility
run "ac13_upper_limits_are_valid" {
  command = plan

  variables {
    function_timeout_seconds   = 900
    batching_window_seconds    = 300
    visibility_timeout_seconds = 43200
  }

  assert {
    condition     = aws_lambda_function.consumer.timeout == 900 && aws_sqs_queue.source.visibility_timeout_seconds == 43200 && aws_lambda_event_source_mapping.orders.maximum_batching_window_in_seconds == 300
    error_message = "the upper limits are not accepted"
  }
}

# AC-13: the lower limit of the function timeout is valid
run "ac13_function_timeout_of_one_is_valid" {
  command = plan

  variables {
    function_timeout_seconds = 1
  }

  assert {
    condition     = aws_lambda_function.consumer.timeout == 1
    error_message = "a function timeout of 1 second is not accepted"
  }
}

# AC-13: 34 is one second short of 6 x 5 + 5
run "ac13_visibility_one_second_short_fails" {
  command = plan

  variables {
    visibility_timeout_seconds = 34
  }

  expect_failures = [var.visibility_timeout_seconds]
}

# AC-13: 59 is one second short of 6 x 10 + 0
run "ac13_visibility_one_second_short_with_other_values_fails" {
  command = plan

  variables {
    function_timeout_seconds   = 10
    batching_window_seconds    = 0
    visibility_timeout_seconds = 59
  }

  expect_failures = [var.visibility_timeout_seconds]
}

# AC-13: the window counts in the rule: 6 x 5 + 300 = 330, so 329 fails
run "ac13_visibility_must_cover_the_batching_window" {
  command = plan

  variables {
    batching_window_seconds    = 300
    visibility_timeout_seconds = 329
  }

  expect_failures = [var.visibility_timeout_seconds]
}

# AC-13: the visibility timeout is a whole number
run "ac13_visibility_not_a_whole_number_fails" {
  command = plan

  variables {
    visibility_timeout_seconds = 40.5
  }

  expect_failures = [var.visibility_timeout_seconds]
}

# AC-13: 43201 is above the SQS maximum (12 hours)
run "ac13_visibility_above_43200_fails" {
  command = plan

  variables {
    visibility_timeout_seconds = 43201
  }

  expect_failures = [var.visibility_timeout_seconds]
}

# AC-13: the function timeout is 1 to 900 seconds, a whole number
run "ac13_function_timeout_zero_fails" {
  command = plan

  variables {
    function_timeout_seconds = 0
  }

  expect_failures = [var.function_timeout_seconds]
}

run "ac13_function_timeout_901_fails" {
  command = plan

  variables {
    function_timeout_seconds   = 901
    visibility_timeout_seconds = 43200
  }

  expect_failures = [var.function_timeout_seconds]
}

run "ac13_function_timeout_not_a_whole_number_fails" {
  command = plan

  variables {
    function_timeout_seconds = 2.5
  }

  expect_failures = [var.function_timeout_seconds]
}

# AC-13: the batching window is 0 to 300 seconds, a whole number
run "ac13_batching_window_301_fails" {
  command = plan

  variables {
    batching_window_seconds    = 301
    visibility_timeout_seconds = 43200
  }

  expect_failures = [var.batching_window_seconds]
}

run "ac13_batching_window_negative_fails" {
  command = plan

  variables {
    batching_window_seconds = -1
  }

  expect_failures = [var.batching_window_seconds]
}

run "ac13_batching_window_not_a_whole_number_fails" {
  command = plan

  variables {
    batching_window_seconds = 2.5
  }

  expect_failures = [var.batching_window_seconds]
}
