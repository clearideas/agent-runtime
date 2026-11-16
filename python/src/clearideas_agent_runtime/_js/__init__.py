"""JavaScript-compatible primitives.

The TypeScript runtime's observable output (hashes, checkpoints, events, error
text) depends on JavaScript semantics: JSON.stringify key order and number
formatting, UTF-16 string lengths, ICU collation, YAML 1.2, WHATWG URLs. These
modules reproduce those semantics on top of maintained libraries so the Python
runtime produces byte-identical results.
"""
