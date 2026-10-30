# Inventory & procurement guide

## Purchasing

1. *Procurement → New purchase order*: supplier, delivery site and lines. Unit cost defaults to the
   supplier's latest price.
2. *Submit for approval*. Someone other than the creator approves, within their role's approval limit.
3. *Mark sent* → *Supplier confirmed* (optional steps for tracking) → *Print PO* for the supplier.

## Receiving

1. *Receive goods*: quantity, batch number and expiry per line. Partial deliveries are normal;
   the PO shows *pending* until fully received. Receiving more than ordered is refused.
2. Received units sit in **Quarantined** and cannot be sold yet.
3. *Inspect*: split each line into accepted / damaged / rejected (reason required). Accepted
   units become available; rejected units leave stock (returned to supplier).
4. *Complete* once every line is inspected. Price differences against the PO are flagged for
   invoice verification.

## Replenishment

*AI Intelligence → Compute replenishment* proposes transfers for SKUs at or below their reorder
point (or below forecast demand when a recent forecast exists). Each row explains why.
*Create transfer for all* drafts a transfer from the supplying warehouse; dispatch it from
*Inventory → Transfers*.

Forecasts show the method used. "Model" means the AI engine's gradient-boosting model, with
coverage-based confidence. "Rule" means a moving average used when the engine is offline or
history is too short; it carries no model confidence.
