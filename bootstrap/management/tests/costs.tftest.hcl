# Tests for bootstrap/management (spec 031): the monthly budget and the anomaly alerts.
# All runs use command = plan with a mock provider, so nothing touches AWS.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }

  override_resource {
    target          = aws_organizations_organization.this
    override_during = plan
    values = {
      id = "o-exampleorg1"
      non_master_accounts = [
        {
          arn    = "arn:aws:organizations::111111111111:account/o-exampleorg1/222222222222"
          email  = "workload@example.com"
          id     = "222222222222"
          name   = "field-guide"
          status = "ACTIVE"
        },
        {
          arn    = "arn:aws:organizations::111111111111:account/o-exampleorg1/333333333333"
          email  = "other@example.com"
          id     = "333333333333"
          name   = "other"
          status = "ACTIVE"
        },
      ]
    }
  }

  override_resource {
    target          = aws_ce_anomaly_monitor.services
    override_during = plan
    values = {
      arn = "arn:aws:ce::111111111111:anomalymonitor/example"
    }
  }
}

variables {
  alert_email = "alerts@example.com"
}

# AC-7: the budget is the pinned monthly cost budget of 10 USD
run "ac7_budget_name_type_period_and_limit" {
  command = plan

  assert {
    condition     = aws_budgets_budget.monthly.name == "field-guide-monthly"
    error_message = "aws_budgets_budget.monthly.name is not 'field-guide-monthly'"
  }

  assert {
    condition     = aws_budgets_budget.monthly.budget_type == "COST"
    error_message = "aws_budgets_budget.monthly.budget_type is not 'COST'"
  }

  assert {
    condition     = aws_budgets_budget.monthly.time_unit == "MONTHLY"
    error_message = "aws_budgets_budget.monthly.time_unit is not 'MONTHLY'"
  }

  assert {
    condition     = tonumber(aws_budgets_budget.monthly.limit_amount) == 10
    error_message = "aws_budgets_budget.monthly.limit_amount is not numerically 10"
  }

  assert {
    condition     = aws_budgets_budget.monthly.limit_unit == "USD"
    error_message = "aws_budgets_budget.monthly.limit_unit is not 'USD'"
  }
}

# AC-7: the budget measures UnblendedCost
run "ac7_budget_metric_is_unblended_cost" {
  command = plan

  assert {
    condition     = toset(aws_budgets_budget.monthly.metrics) == toset(["UnblendedCost"])
    error_message = "aws_budgets_budget.monthly.metrics is not exactly ['UnblendedCost']"
  }
}

# AC-7: the filter is NOT(RECORD_TYPE in {Credit, Refund}) and there is no legacy cost_types block
run "ac7_budget_filter_excludes_credits_and_refunds" {
  command = plan

  assert {
    condition     = length(aws_budgets_budget.monthly.filter_expression) == 1
    error_message = "aws_budgets_budget.monthly needs exactly one filter_expression"
  }

  assert {
    condition     = length(aws_budgets_budget.monthly.filter_expression[0].not) == 1
    error_message = "the budget filter_expression must be a single 'not'"
  }

  assert {
    condition     = length(aws_budgets_budget.monthly.filter_expression[0].not[0].dimensions) == 1
    error_message = "the 'not' must hold exactly one dimensions block"
  }

  assert {
    condition     = aws_budgets_budget.monthly.filter_expression[0].not[0].dimensions[0].key == "RECORD_TYPE"
    error_message = "the budget filter dimension key is not 'RECORD_TYPE'"
  }

  assert {
    condition     = toset(aws_budgets_budget.monthly.filter_expression[0].not[0].dimensions[0].values) == toset(["Credit", "Refund"])
    error_message = "the budget filter values are not exactly {Credit, Refund}"
  }
}

# AC-7: the legacy cost_types block is not set in the configuration
run "ac7_budget_has_no_legacy_cost_types" {
  command = plan

  assert {
    condition     = alltrue([for c in aws_budgets_budget.monthly.cost_types : false])
    error_message = "aws_budgets_budget.monthly must not set a cost_types block"
  }
}

# AC-7: three notifications (ACTUAL 50, ACTUAL 100, FORECASTED 100), as percentages
run "ac7_budget_notification_thresholds" {
  command = plan

  assert {
    condition = toset([
      for n in aws_budgets_budget.monthly.notification : format("%s:%d", n.notification_type, n.threshold)
      ]) == toset([
      "ACTUAL:50",
      "ACTUAL:100",
      "FORECASTED:100",
    ])
    error_message = "the budget notifications are not exactly {(ACTUAL, 50), (ACTUAL, 100), (FORECASTED, 100)}"
  }

  assert {
    condition     = length(aws_budgets_budget.monthly.notification) == 3
    error_message = "the budget needs exactly three notification blocks"
  }

  assert {
    condition = alltrue([
      for n in aws_budgets_budget.monthly.notification :
      n.comparison_operator == "GREATER_THAN" && n.threshold_type == "PERCENTAGE"
    ])
    error_message = "every budget notification must be GREATER_THAN with threshold_type PERCENTAGE"
  }
}

# AC-7: every notification goes to alert_email and nobody else
run "ac7_budget_notification_subscribers" {
  command = plan

  assert {
    condition = alltrue([
      for n in aws_budgets_budget.monthly.notification :
      length(n.subscriber_email_addresses) == 1 && contains(n.subscriber_email_addresses, "alerts@example.com")
    ])
    error_message = "every budget notification must have subscriber_email_addresses = ['alerts@example.com']"
  }
}

# AC-8: the managed monitor is the default Services monitor
run "ac8_anomaly_monitor_is_default_services_monitor" {
  command = plan

  assert {
    condition     = aws_ce_anomaly_monitor.services.name == "Default-Services-Monitor"
    error_message = "aws_ce_anomaly_monitor.services.name is not 'Default-Services-Monitor'"
  }

  assert {
    condition     = aws_ce_anomaly_monitor.services.monitor_type == "DIMENSIONAL"
    error_message = "aws_ce_anomaly_monitor.services.monitor_type is not 'DIMENSIONAL'"
  }

  assert {
    condition     = aws_ce_anomaly_monitor.services.monitor_dimension == "SERVICE"
    error_message = "aws_ce_anomaly_monitor.services.monitor_dimension is not 'SERVICE'"
  }
}

# AC-8: the new subscription is daily and emails alert_email
run "ac8_anomaly_subscription_frequency_and_subscriber" {
  command = plan

  assert {
    condition     = aws_ce_anomaly_subscription.impact_5usd.frequency == "DAILY"
    error_message = "aws_ce_anomaly_subscription.impact_5usd.frequency is not 'DAILY'"
  }

  assert {
    condition     = length(aws_ce_anomaly_subscription.impact_5usd.subscriber) == 1
    error_message = "the anomaly subscription needs exactly one subscriber"
  }

  assert {
    condition = alltrue([
      for s in aws_ce_anomaly_subscription.impact_5usd.subscriber :
      s.type == "EMAIL" && s.address == "alerts@example.com"
    ])
    error_message = "the anomaly subscriber must be type EMAIL with address 'alerts@example.com'"
  }
}

# AC-8: the subscription fires on a total impact of at least 5 USD
run "ac8_anomaly_subscription_threshold_is_5_usd_impact" {
  command = plan

  assert {
    condition     = length(aws_ce_anomaly_subscription.impact_5usd.threshold_expression) == 1
    error_message = "the anomaly subscription needs exactly one threshold_expression"
  }

  assert {
    condition     = length(aws_ce_anomaly_subscription.impact_5usd.threshold_expression[0].dimension) == 1
    error_message = "the threshold_expression must hold exactly one dimension"
  }

  assert {
    condition     = aws_ce_anomaly_subscription.impact_5usd.threshold_expression[0].dimension[0].key == "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
    error_message = "the threshold dimension key is not 'ANOMALY_TOTAL_IMPACT_ABSOLUTE'"
  }

  assert {
    condition     = toset(aws_ce_anomaly_subscription.impact_5usd.threshold_expression[0].dimension[0].match_options) == toset(["GREATER_THAN_OR_EQUAL"])
    error_message = "the threshold match_options is not exactly ['GREATER_THAN_OR_EQUAL']"
  }

  assert {
    condition = (
      length(aws_ce_anomaly_subscription.impact_5usd.threshold_expression[0].dimension[0].values) == 1 &&
      tonumber(tolist(aws_ce_anomaly_subscription.impact_5usd.threshold_expression[0].dimension[0].values)[0]) == 5
    )
    error_message = "the threshold must have exactly one value, numerically 5"
  }
}

# AC-8: the subscription watches the managed monitor and only that one
run "ac8_anomaly_subscription_watches_the_services_monitor" {
  command = plan

  assert {
    condition     = length(aws_ce_anomaly_subscription.impact_5usd.monitor_arn_list) == 1
    error_message = "monitor_arn_list must have exactly one element"
  }

  assert {
    condition     = contains(aws_ce_anomaly_subscription.impact_5usd.monitor_arn_list, "arn:aws:ce::111111111111:anomalymonitor/example")
    error_message = "monitor_arn_list must hold the ARN of aws_ce_anomaly_monitor.services"
  }
}
