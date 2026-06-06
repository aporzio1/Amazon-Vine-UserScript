# DeepSeek Provider Support

**Date:** 2026-06-06
**Status:** Approved

## Goal

Add DeepSeek as an alternative AI provider for the AI Review Generator, selectable via a Settings dropdown. Only the active provider is used for generation.

## Config & Storage

Three new keys added to `CONFIG`:

| Key | Storage string | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | `vine_deepseek_api_key` | User's DeepSeek API key |
| `DEEPSEEK_MODEL` | `vine_deepseek_model` | DeepSeek model name (configurable) |
| `AI_PROVIDER` | `vine_ai_provider` | Active provider: `'openai'` or `'deepseek'` |

A `PROVIDERS` map in `CONFIG` centralizes all provider-specific data:

```js
PROVIDERS: {
  openai: {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-3.5-turbo'
  },
  deepseek: {
    label: 'DeepSeek',
    url: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-v4-flash'
  }
}
```

## Settings UI

The "AI Review Generator" block in the Price Settings tab is updated:

1. **Provider dropdown** — `<select>` with OpenAI / DeepSeek options, bound to `AI_PROVIDER`. A `change` listener shows/hides the relevant key fields inline (no reload).
2. **OpenAI section** — existing password field for the OpenAI API key (unchanged).
3. **DeepSeek section** — password field for the DeepSeek API key + text field for the model name (default `deepseek-v4-flash`, pre-filled from storage).
4. **Save** — the existing Save button handler gains three new `setStorage` calls for the new fields.

## Data Flow

`generateReview` changes:

1. Read `AI_PROVIDER` from storage (default `'openai'`).
2. Look up `PROVIDERS[provider]` for `url` and `defaultModel`.
3. Read the correct API key; throw with a provider-named error if empty.
4. Read model: DeepSeek reads `DEEPSEEK_MODEL` storage (falls back to `defaultModel`). OpenAI stays hardcoded to `gpt-3.5-turbo`.
5. `gmFetch` call uses the resolved `url`, `apiKey`, and `model` as variables.
6. Response parsing (`parseGeneratedReview`) is unchanged — both providers return `choices[0].message.content`.

## What Does Not Change

- Request body shape (`messages`, `temperature`, `max_tokens`, `response_format`)
- System prompt and user prompt
- `parseGeneratedReview` and its fallback tiers
- `gmFetch` internals
- All other subsystems

## Error Messages

When the active provider's key is missing:
- OpenAI: `"OpenAI API key not configured. Please add your key in Vine Tools > Price Settings."`
- DeepSeek: `"DeepSeek API key not configured. Please add your key in Vine Tools > Price Settings."`

## Out of Scope

- Per-generation provider toggle in the AI panel
- Automatic fallback between providers
- Configurable OpenAI model name
- Adding a third provider
