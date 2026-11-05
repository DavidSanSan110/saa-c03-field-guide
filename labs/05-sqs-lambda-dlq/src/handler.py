"""Consumer of the orders queue (lab 05).

A good order is a JSON object with a non-empty string "order_id". Anything else is a poison message:
the handler reports it in "batchItemFailures" and goes on with the rest of the batch. It never lets
an error out of the function, because an error would fail the whole batch, good orders included.
Standard library only.
"""

import json


def order_id_of(body):
    """The order_id of a good order, or None when the body is anything else."""
    try:
        order = json.loads(body)
    except (TypeError, ValueError, RecursionError):
        return None
    if not isinstance(order, dict):
        return None
    order_id = order.get("order_id")
    if isinstance(order_id, str) and order_id != "":
        return order_id
    return None


def handler(event, context):
    failures = []
    for record in event.get("Records", []):
        order_id = order_id_of(record["body"])
        if order_id is None:
            print("failed message " + record["messageId"])
            failures.append({"itemIdentifier": record["messageId"]})
        else:
            print("processed order " + order_id)
    # With ReportBatchItemFailures on the mapping, only these messages go back to the queue.
    return {"batchItemFailures": failures}
