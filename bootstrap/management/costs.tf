# Created by Terraform: 10 USD per month, excluding credits and refunds. If a budget with this name
# already exists the create fails (see the README). cost_types is not used: it conflicts with metrics.
resource "aws_budgets_budget" "monthly" {
  name         = "field-guide-monthly"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = "10.0"
  limit_unit   = "USD"
  metrics      = ["UnblendedCost"]

  # The account's primary billing view, the one the console uses. Set explicitly because the
  # provider does not compute this argument.
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

# Imported: new accounts get this default monitor from AWS. If the account has none, skip the import
# and Terraform creates it.
resource "aws_ce_anomaly_monitor" "services" {
  name              = "Default-Services-Monitor"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

# A daily email for any anomaly costing at least 5 USD, on the monitor above. New accounts get AWS's
# own Default-Services-Subscription (100 USD and 40 percent): import it and, because name forces a
# new resource, the plan replaces it with this one, so exactly one subscription remains.
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
