# Imported: the monthly budget already exists. The values below match what AWS stores, so the only
# expected diff is the default tags. cost_types is not used: it conflicts with metrics.
resource "aws_budgets_budget" "monthly" {
  name         = "field-guide-monthly"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = "10.0"
  limit_unit   = "USD"
  metrics      = ["UnblendedCost"]

  # The existing budget uses the primary billing view. The provider does not compute this argument,
  # so without it the import would plan to remove the view.
  billing_view_arn = "arn:aws:billing::${local.account_id}:billingview/primary"

  filter_expression {
    not {
      dimensions {
        key    = "RECORD_TYPE"
        values = ["Credit", "Refund"]
      }
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

# Imported: the default Services monitor that AWS created. Its existing $100 subscription is not
# managed here and stays as it is.
resource "aws_ce_anomaly_monitor" "services" {
  name              = "Default-Services-Monitor"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

# A new, lower-threshold subscription on the same monitor: a daily email for any anomaly costing
# at least 5 USD.
resource "aws_ce_anomaly_subscription" "impact_5usd" {
  name             = "field-guide-impact-5usd"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

  subscriber {
    type    = "EMAIL"
    address = var.alert_email
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = ["5.0"]
    }
  }
}
