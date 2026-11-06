from decimal import ROUND_HALF_UP, Decimal


def round_cents(amount):
    """Round a monetary amount to two decimal places, half up."""
    return float(Decimal(str(amount)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
