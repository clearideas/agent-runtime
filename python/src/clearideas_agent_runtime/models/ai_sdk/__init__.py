"""The AI SDK's interpretation of provider responses, for ``ModelResult`` parity.

``capture`` records raw provider responses; the provider modules turn a
response body or event stream into AI SDK content parts, usage, finish reason,
and provider metadata the way the AI SDK providers do; ``core`` assembles them
into a ``ModelResult`` the way AI SDK Core and ``AiSdkModelAdapter`` do.
"""
