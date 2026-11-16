"""Model profiles, host model policy, and the configured model adapter (``packages/runtime/src/providers.ts``)."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass
from typing import Any

from .._js import json as js_json
from .._js.errors import Error
from .._js.url import URL
from .schema import built_in_provider_definition
from .values import ValueResolutionContext, resolve_environment_reference, resolve_headers, resolve_value_source

JsonObject = dict[str, Any]

DEFAULT_API_KEY_ENV = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_GENERATIVE_AI_API_KEY",
    "xai": "XAI_API_KEY",
    "groq": "GROQ_API_KEY",
    "cohere": "COHERE_API_KEY",
}


@dataclass
class ModelAuthorizationPolicy:
    """Host policy for manifest model references (``ModelAuthorizationPolicy``)."""

    require_profiles: bool | None = None
    allowed_providers: Iterable[str] | None = None
    allowed_models: Iterable[str] | None = None
    allow_manifest_options: bool | None = None
    #: ``authorize_model({"reference", "resolved"})``; raise to reject.
    authorize_model: Callable[[JsonObject], None] | None = None


def _merge_options(base: JsonObject | None, override: JsonObject | None) -> JsonObject | None:
    if not base and not override:
        return None
    return {**(base or {}), **(override or {})}


def _explicit(reference: JsonObject) -> bool:
    return "provider" in reference


def resolve_model_reference(reference: JsonObject, config: JsonObject) -> JsonObject:
    """``{provider, model, options?, capabilities?, profile?}`` for a manifest model reference."""
    if _explicit(reference):
        resolved: JsonObject = {"provider": reference["provider"], "model": reference["model"]}
        if reference.get("options"):
            resolved["options"] = reference["options"]
        return resolved
    definition = (config.get("models") or {}).get(reference["ref"])
    if definition is None:
        raise Error(f'Unknown model profile "{reference["ref"]}".')
    defaults = js_json.to_json_value(definition["options"]) if isinstance(definition.get("options"), dict) else None
    options = _merge_options(defaults, reference.get("options"))
    resolved = {"provider": definition["provider"], "model": definition["model"]}
    if options:
        resolved["options"] = options
    if definition.get("capabilities"):
        resolved["capabilities"] = definition["capabilities"]
    resolved["profile"] = reference["ref"]
    return resolved


def _configured_provider(name: str, config: JsonObject) -> JsonObject:
    definition = (config.get("providers") or {}).get(name) or built_in_provider_definition(name)
    if definition is None:
        raise Error(f'Unknown model provider "{name}".')
    return definition


def _provider_api_key(name: str, definition: JsonObject, context: ValueResolutionContext | None) -> str | None:
    if definition.get("apiKey"):
        return resolve_environment_reference(definition["apiKey"], context, f"Provider {name}")
    environment_name = DEFAULT_API_KEY_ENV.get(definition["driver"])
    if environment_name is None:
        return None
    return resolve_environment_reference({"env": environment_name}, context, f"Provider {name}")


def _validate_base_url(value: str, provider_name: str) -> str:
    try:
        url = URL(value)
    except Exception as error:
        raise Error(f'Provider "{provider_name}" baseURL is invalid.') from error
    if url.protocol not in ("https:", "http:") or url.username or url.password:
        raise Error(f'Provider "{provider_name}" baseURL must use HTTP or HTTPS without URL credentials.')
    return value


def _model_factory(name: str, definition: JsonObject, context: ValueResolutionContext | None) -> Callable[[str], Any]:
    from ..models.providers import create_model_factory

    api_key = _provider_api_key(name, definition, context)
    base_url = (
        _validate_base_url(resolve_value_source(definition["baseURL"], context, f"Provider {name} baseURL"), name)
        if definition.get("baseURL")
        else None
    )
    return create_model_factory(
        definition["driver"],
        name,
        api_key=api_key,
        base_url=base_url,
        headers=resolve_headers(definition.get("headers"), context),
        include_usage=definition.get("includeUsage"),
        supports_structured_outputs=definition.get("supportsStructuredOutputs"),
    )


def _walk_steps(steps: list[JsonObject], visit: Callable[[JsonObject], None]) -> None:
    for step in steps:
        visit(step)
        if step["type"] == "loop":
            _walk_steps(step["steps"], visit)


def manifest_model_references(manifest: JsonObject) -> list[JsonObject]:
    """Every model a manifest can call, including summarizer models."""
    references: list[JsonObject] = [manifest["model"]] if manifest.get("model") else []
    summarizer = (((manifest.get("policies") or {}).get("context") or {}).get("summarizer") or {}).get("model")
    if summarizer:
        references.append(summarizer)

    def visit(step: JsonObject) -> None:
        if step["type"] == "prompt" and step.get("model"):
            references.append(step["model"])
        step_summarizer = (((step.get("policies") or {}).get("context") or {}).get("summarizer") or {}).get("model")
        if step_summarizer:
            references.append(step_summarizer)

    _walk_steps(manifest["steps"], visit)
    return references


def _authorize(reference: JsonObject, resolved: JsonObject, policy: ModelAuthorizationPolicy) -> None:
    if policy.require_profiles is True and _explicit(reference):
        raise Error("This host requires agent manifests to use configured model profiles.")
    if policy.allowed_providers is not None and resolved["provider"] not in list(policy.allowed_providers):
        raise Error(f'Model provider "{resolved["provider"]}" is not authorized by this host.')
    qualified = f"{resolved['provider']}/{resolved['model']}"
    if policy.allowed_models is not None and qualified not in list(policy.allowed_models):
        raise Error(f'Model "{qualified}" is not authorized by this host.')
    if policy.allow_manifest_options is False and reference.get("options"):
        raise Error("Model option overrides are not authorized by this host.")
    if policy.authorize_model is not None:
        policy.authorize_model({"reference": reference, "resolved": resolved})


def _resolve_request_model(model: str, config: JsonObject) -> JsonObject:
    if model.startswith("ref/"):
        return resolve_model_reference({"ref": model[len("ref/") :]}, config)
    separator = model.find("/")
    if separator <= 0 or separator >= len(model) - 1:
        raise Error(f'Model "{model}" must use provider/model format or a model profile.')
    return {"provider": model[:separator], "model": model[separator + 1 :]}


class ConfiguredModelAdapter:
    """Resolves profiles, enforces host model policy, and merges profile options."""

    def __init__(self, delegate: Any, config: JsonObject, policy: ModelAuthorizationPolicy) -> None:
        self._delegate = delegate
        self._config = config
        self._policy = policy

    def _request(self, request: JsonObject) -> JsonObject:
        resolved = _resolve_request_model(request["model"], self._config)
        reference = (
            {"ref": resolved["profile"]}
            if resolved.get("profile")
            else {"provider": resolved["provider"], "model": resolved["model"]}
        )
        _authorize(reference, resolved, self._policy)
        if self._policy.allow_manifest_options is False and request.get("providerOptions"):
            raise Error("Model option overrides are not authorized by this host.")
        provider_options = _merge_options(resolved.get("options"), request.get("providerOptions"))
        result = {**request, "model": f"{resolved['provider']}/{resolved['model']}"}
        if provider_options:
            result["providerOptions"] = provider_options
        return result

    async def generate(self, request: JsonObject) -> JsonObject:
        return await self._delegate.generate(self._request(request))

    def describe_model(self, model: str) -> JsonObject | None:
        """Limits from the configured model's ``capabilities``, when known."""
        try:
            resolved = _resolve_request_model(model, self._config)
            capabilities = resolved.get("capabilities") or next(
                (
                    definition.get("capabilities")
                    for definition in (self._config.get("models") or {}).values()
                    if definition["provider"] == resolved["provider"] and definition["model"] == resolved["model"]
                ),
                None,
            )
        except Exception:
            return None
        if not capabilities:
            return None
        description = {
            key: capabilities[key]
            for key in ("maxInputTokens", "maxOutputTokens", "imageInput")
            if capabilities.get(key) is not None
        }
        return description or None

    async def stream(self, request: JsonObject) -> AsyncIterator[JsonObject]:
        resolved = self._request(request)
        stream = getattr(self._delegate, "stream", None)
        if stream is None:
            yield {"type": "completed", "result": await self._delegate.generate(resolved)}
            return
        async for event in stream(resolved):
            yield event


def create_configured_model_adapter(
    manifest: JsonObject,
    config: JsonObject,
    context: ValueResolutionContext | None = None,
    policy: ModelAuthorizationPolicy | None = None,
) -> ConfiguredModelAdapter | None:
    from ..models.pydantic_ai import PydanticAIModelAdapter, create_provider_registry_model_resolver

    policy = policy or ModelAuthorizationPolicy()
    providers: dict[str, None] = {}
    for reference in manifest_model_references(manifest):
        resolved = resolve_model_reference(reference, config)
        _authorize(reference, resolved, policy)
        providers[resolved["provider"]] = None
    if not providers:
        return None
    registry = {name: _model_factory(name, _configured_provider(name, config), context) for name in providers}
    adapter = PydanticAIModelAdapter(resolve_model=create_provider_registry_model_resolver(registry))
    return ConfiguredModelAdapter(adapter, config, policy)


def validate_model_capabilities(manifest: JsonObject, config: JsonObject) -> None:
    def visit(step: JsonObject) -> None:
        if step["type"] != "prompt":
            return
        reference = step.get("model") or manifest.get("model")
        if not reference:
            raise Error(f"Prompt step {step['id']} requires a model.")
        resolved = resolve_model_reference(reference, config)
        capabilities = resolved.get("capabilities") or {}
        if step.get("tools") and capabilities.get("tools") is False:
            raise Error(f"Model used by prompt step {step['id']} does not support tools.")
        if step.get("outputSchema") and capabilities.get("structuredOutput") is False:
            raise Error(f"Model used by prompt step {step['id']} does not support structured output.")
        limit = capabilities.get("maxOutputTokens")
        if step.get("maxOutputTokens") and limit and step["maxOutputTokens"] > limit:
            raise Error(
                f"Prompt step {step['id']} requests {step['maxOutputTokens']} output tokens, exceeding the configured model limit of {limit}."
            )
        summarizer = ((step.get("policies") or {}).get("context") or {}).get("summarizer")
        if summarizer is None:
            summarizer = ((manifest.get("policies") or {}).get("context") or {}).get("summarizer")
        if summarizer and summarizer.get("maxOutputTokens"):
            summarizer_resolved = resolve_model_reference(summarizer.get("model") or reference, config)
            summarizer_limit = (summarizer_resolved.get("capabilities") or {}).get("maxOutputTokens")
            if summarizer_limit and summarizer["maxOutputTokens"] > summarizer_limit:
                raise Error(
                    f"The summarizer for prompt step {step['id']} requests {summarizer['maxOutputTokens']} output tokens, exceeding the configured model limit of {summarizer_limit}."
                )

    _walk_steps(manifest["steps"], visit)
