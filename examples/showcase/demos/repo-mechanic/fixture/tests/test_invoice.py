import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from invoice import invoice_total, line_total  # noqa: E402


class InvoiceTest(unittest.TestCase):
    def test_line_total_rounds_to_cents(self):
        self.assertEqual(line_total(3, 0.335), 1.01)

    def test_total_without_discount(self):
        self.assertEqual(invoice_total([(2, 50.0), (1, 25.0)]), 125.0)

    def test_discount_is_a_percentage(self):
        self.assertEqual(invoice_total([(2, 50.0)], discount_rate=0.10), 90.0)

    def test_tax_applies_after_discount(self):
        self.assertEqual(
            invoice_total([(1, 200.0)], discount_rate=0.25, tax_rate=0.08), 162.0
        )


if __name__ == "__main__":
    unittest.main()
