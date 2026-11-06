from money import round_cents


def line_total(quantity, unit_price):
    """Price of one invoice line."""
    return round_cents(quantity * unit_price)


def invoice_total(lines, discount_rate=0.0, tax_rate=0.0):
    """Total for (quantity, unit_price) lines.

    discount_rate and tax_rate are fractions: 0.10 means ten percent.
    The discount applies to the subtotal; tax applies after the discount.
    """
    subtotal = sum(line_total(quantity, price) for quantity, price in lines)
    discounted = subtotal - discount_rate
    return round_cents(discounted * (1 + tax_rate))
