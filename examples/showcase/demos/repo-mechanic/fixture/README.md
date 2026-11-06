# Invoice service

Computes invoice totals for the billing API.

- `src/money.py` rounds amounts to cents.
- `src/invoice.py` applies a percentage discount, then tax.

Run the tests with `python3 -m unittest discover -s tests`
