# Tests for labs/01-iam-assume-role (spec 040, AC-13 and AC-14): variable validation.
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# expect_failures checks which object failed, not the message: the wording of the messages is
# checked on the file text by tools/guardrails/src/lab-01-iam-assume-role.test.ts (AC-3).

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
}

# ---- external_id: 2 to 1224 characters of [\w+=,.@:/-] ----------------------------------------------

# AC-13: the shortest value passes
run "ac13_external_id_two_characters_is_accepted" {
  command = plan

  variables {
    external_id = "ab"
  }

  assert {
    condition     = var.external_id == "ab"
    error_message = "external_id = 'ab' should pass validation"
  }
}

# AC-13: the default passes
run "ac13_external_id_default_is_accepted" {
  command = plan

  variables {
    external_id = "field-guide-lab-01"
  }

  assert {
    condition     = var.external_id == "field-guide-lab-01"
    error_message = "external_id = 'field-guide-lab-01' should pass validation"
  }
}

# AC-13: an underscore is a word character
run "ac13_external_id_underscore_is_accepted" {
  command = plan

  variables {
    external_id = "a_b"
  }

  assert {
    condition     = var.external_id == "a_b"
    error_message = "external_id = 'a_b' should pass validation"
  }
}

# AC-13: every special character STS allows passes
run "ac13_external_id_all_special_characters_are_accepted" {
  command = plan

  variables {
    external_id = "a+b=c,d.e@f:g/h-i"
  }

  assert {
    condition     = var.external_id == "a+b=c,d.e@f:g/h-i"
    error_message = "external_id = 'a+b=c,d.e@f:g/h-i' should pass validation"
  }
}

# AC-13: 1224 characters is the longest value that passes
run "ac13_external_id_1224_characters_is_accepted" {
  command = plan

  variables {
    external_id = join("", [for i in range(612) : "aa"])
  }

  assert {
    condition     = length(var.external_id) == 1224
    error_message = "an external_id of 1224 characters should pass validation"
  }
}

# AC-13: one character is too short
run "ac13_external_id_one_character_is_rejected" {
  command = plan

  variables {
    external_id = "a"
  }

  expect_failures = [var.external_id]
}

# AC-13: 1225 characters is too long
run "ac13_external_id_1225_characters_is_rejected" {
  command = plan

  variables {
    external_id = join("", concat([for i in range(612) : "aa"], ["a"]))
  }

  expect_failures = [var.external_id]
}

# AC-13: a space is rejected
run "ac13_external_id_space_is_rejected" {
  command = plan

  variables {
    external_id = "has space"
  }

  expect_failures = [var.external_id]
}

# AC-13: a semicolon is rejected
run "ac13_external_id_semicolon_is_rejected" {
  command = plan

  variables {
    external_id = "semi;colon"
  }

  expect_failures = [var.external_id]
}

# AC-13: an empty value is rejected
run "ac13_external_id_empty_is_rejected" {
  command = plan

  variables {
    external_id = ""
  }

  expect_failures = [var.external_id]
}

# ---- trusted_account_id: null or exactly 12 digits ---------------------------------------------------

# AC-14: null (the default) passes
run "ac14_trusted_account_id_null_is_accepted" {
  command = plan

  variables {
    trusted_account_id = null
  }

  assert {
    condition     = var.trusted_account_id == null
    error_message = "trusted_account_id = null should pass validation"
  }
}

# AC-14: twelve digits pass
run "ac14_trusted_account_id_twelve_digits_is_accepted" {
  command = plan

  variables {
    trusted_account_id = "222222222222"
  }

  assert {
    condition     = var.trusted_account_id == "222222222222"
    error_message = "trusted_account_id = '222222222222' should pass validation"
  }
}

# AC-14: eleven digits are rejected
run "ac14_trusted_account_id_eleven_digits_is_rejected" {
  command = plan

  variables {
    trusted_account_id = "22222222222"
  }

  expect_failures = [var.trusted_account_id]
}

# AC-14: thirteen digits are rejected
run "ac14_trusted_account_id_thirteen_digits_is_rejected" {
  command = plan

  variables {
    trusted_account_id = "2222222222222"
  }

  expect_failures = [var.trusted_account_id]
}

# AC-14: a letter among twelve characters is rejected
run "ac14_trusted_account_id_letter_is_rejected" {
  command = plan

  variables {
    trusted_account_id = "22222222222a"
  }

  expect_failures = [var.trusted_account_id]
}

# AC-14: an empty value is rejected
run "ac14_trusted_account_id_empty_is_rejected" {
  command = plan

  variables {
    trusted_account_id = ""
  }

  expect_failures = [var.trusted_account_id]
}
