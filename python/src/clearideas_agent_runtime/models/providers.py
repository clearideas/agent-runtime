"""pydantic-ai model factories for the seven provider drivers.

Each factory mirrors the AI SDK provider the TypeScript runtime creates for the
same driver and sends the same HTTP API:

| Driver              | AI SDK provider                 | pydantic-ai model                          |
| ------------------- | ------------------------------- | ------------------------------------------ |
| `openai`            | `createOpenAI` (Responses API)  | `ResponsesChatModel` (``models/openai.py``) |
| `anthropic`         | `createAnthropic` (Messages)    | `AnthropicModel`                           |
| `google`            | `createGoogleGenerativeAI`      | `GoogleChatModel` (``models/google.py``)   |
| `xai`               | `createXai` (Responses API)     | `ResponsesChatModel` at api.x.ai           |
| `groq`              | `createGroq` (Chat Completions) | `GroqChatModel` (``models/groq.py``)       |
| `cohere`            | `createCohere` (v2 chat)        | `CohereChatModel` (``models/cohere.py``)   |
| `openai-compatible` | `createOpenAICompatible` (Chat) | `OpenAIChatModel` at the configured URL    |

``baseURL`` uses the AI SDK convention (it includes the API version path, for
example ``https://api.anthropic.com/v1``); it is converted to each Python SDK's
convention.
"""

from __future__ import annotations

from collections.abc import Mapping

from .._js.errors import Error
from .ai_sdk.capture import instrument
from .pydantic_ai import ProviderModelFactory, ResolvedModel

DEFAULT_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta",
    "xai": "https://api.x.ai/v1",
    "groq": "https://api.groq.com/openai/v1",
    "cohere": "https://api.cohere.com/v2",
}


def _strip_suffix(url: str, suffix: str) -> str:
    trimmed = url.rstrip("/")
    return trimmed[: -len(suffix)] if trimmed.endswith(suffix) else trimmed


def create_model_factory(
    driver: str,
    name: str,
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    headers: Mapping[str, str] | None = None,
    include_usage: bool | None = None,
    supports_structured_outputs: bool | None = None,
) -> ProviderModelFactory:
    """A factory from model id to a pydantic-ai model for one configured provider."""
    default_headers = dict(headers or {})

    if driver in ("openai", "xai", "openai-compatible"):
        from openai import AsyncOpenAI, DefaultAsyncHttpxClient
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        if driver == "openai-compatible" and not base_url:
            raise Error(f'OpenAI-compatible provider "{name}" requires baseURL.')
        client = AsyncOpenAI(
            api_key=api_key or ("not-needed" if driver == "openai-compatible" else None),
            base_url=(base_url or DEFAULT_BASE_URLS[driver]).rstrip("/"),
            default_headers=default_headers or None,
            http_client=instrument(DefaultAsyncHttpxClient()),
        )
        provider = OpenAIProvider(openai_client=client)

        def openai_model(model_id: str) -> ResolvedModel:
            if driver == "openai-compatible":
                from pydantic_ai.profiles import merge_profile

                profile = merge_profile(
                    provider.model_profile(model_id),
                    {  # pyright: ignore[reportArgumentType]
                        "supports_json_schema_output": supports_structured_outputs is True,
                        "supports_json_object_output": True,
                        # Like the AI SDK's compatible provider: the widely supported field.
                        "openai_chat_supports_max_completion_tokens": False,
                        # ... and reasoning sent back in `reasoning_content`.
                        "openai_chat_send_back_thinking_parts": "field",
                        "openai_chat_thinking_field": "reasoning_content",
                    },
                )
                return ResolvedModel(OpenAIChatModel(model_id, provider=provider, profile=profile), driver, name)
            from pydantic_ai.profiles import merge_profile

            from .openai import ResponsesChatModel
            from .responses_input import is_openai_reasoning_model

            profile = provider.model_profile(model_id) or {}
            if driver == "openai":
                # @ai-sdk/openai sends system messages as developer messages to reasoning models.
                role = "developer" if is_openai_reasoning_model(model_id) else "system"
                profile = merge_profile(profile, {"openai_system_prompt_role": role})  # pyright: ignore[reportArgumentType]
            return ResolvedModel(
                ResponsesChatModel(model_id, driver=driver, provider=provider, profile=profile), driver, name
            )

        return openai_model

    if driver == "anthropic":
        from anthropic import AsyncAnthropic
        from anthropic import DefaultAsyncHttpxClient as AnthropicHttpClient
        from pydantic_ai.models.anthropic import AnthropicModel
        from pydantic_ai.providers.anthropic import AnthropicProvider

        anthropic_client = AsyncAnthropic(
            api_key=api_key,
            base_url=_strip_suffix(base_url or DEFAULT_BASE_URLS["anthropic"], "/v1"),
            default_headers=default_headers or None,
            http_client=instrument(AnthropicHttpClient()),
        )
        anthropic_provider = AnthropicProvider(anthropic_client=anthropic_client)
        return lambda model_id: ResolvedModel(AnthropicModel(model_id, provider=anthropic_provider), driver, name)

    if driver == "google":
        import httpx
        from google import genai
        from google.genai import types
        from pydantic_ai.providers.google import GoogleProvider

        from .google import GoogleChatModel

        url = base_url or DEFAULT_BASE_URLS["google"]
        version = url.rstrip("/").rsplit("/", 1)[-1]
        options = types.HttpOptions(
            base_url=_strip_suffix(url, f"/{version}") + "/",
            api_version=version,
            headers=default_headers or None,
            httpx_async_client=instrument(httpx.AsyncClient(timeout=None)),
        )
        google_provider = GoogleProvider(client=genai.Client(api_key=api_key, http_options=options))
        return lambda model_id: ResolvedModel(GoogleChatModel(model_id, provider=google_provider), driver, name)

    if driver == "groq":
        from groq import AsyncGroq
        from groq import DefaultAsyncHttpxClient as GroqHttpClient
        from pydantic_ai.providers.groq import GroqProvider

        from .groq import GroqChatModel

        groq_client = AsyncGroq(
            api_key=api_key,
            base_url=_strip_suffix(base_url or DEFAULT_BASE_URLS["groq"], "/openai/v1"),
            default_headers=default_headers or None,
            http_client=instrument(GroqHttpClient()),
        )
        groq_provider = GroqProvider(groq_client=groq_client)
        return lambda model_id: ResolvedModel(GroqChatModel(model_id, provider=groq_provider), driver, name)

    if driver == "cohere":
        import httpx
        from cohere import AsyncClientV2
        from pydantic_ai.providers.cohere import CohereProvider

        from .cohere import CohereChatModel

        cohere_client = AsyncClientV2(
            api_key=api_key,
            base_url=_strip_suffix(base_url or DEFAULT_BASE_URLS["cohere"], "/v2"),
            # The Cohere SDK's default client: 300 s timeout, redirects followed.
            httpx_client=instrument(
                httpx.AsyncClient(headers=default_headers or None, timeout=300, follow_redirects=True)
            ),
        )
        cohere_provider = CohereProvider(cohere_client=cohere_client)
        return lambda model_id: ResolvedModel(CohereChatModel(model_id, provider=cohere_provider), driver, name)

    raise Error(f'Unknown model driver "{driver}".')
