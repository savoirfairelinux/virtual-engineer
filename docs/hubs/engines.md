# Agent engines

All eight engines, their auth and their models.

Each engine has its own adapter, connection validator, and model service. The workflow does not change with the engine.

| Engine | Authentication | Models |
| --- | --- | --- |
| GitHub Copilot | **Auth** · GitHub OAuth device flow, or a personal access token | **Models** · Copilot models, CLI-managed (auto by default) |
| Claude Code | **Auth** · Anthropic API key, or Claude Pro/Max via OAuth (auth-code + PKCE) | **Models** · Anthropic Claude models |
| Aider | **Auth** · Per-backend API key (Ollama needs none) | **Models** · OpenAI, Anthropic, Ollama, OpenRouter, DeepSeek, any OpenAI-compatible base URL |
| Goose | **Auth** · Per-provider API key (Ollama and Bedrock need none) | **Models** · Anthropic, OpenAI, OpenRouter, Ollama, DeepSeek, Groq, Gemini, Azure OpenAI, Bedrock, Perplexity, Mistral, xAI, Cerebras |
| Codex | **Auth** · OpenAI API key, or a pasted Codex/ChatGPT access token | **Models** · OpenAI Codex models, CLI-managed |
| Gemini CLI | **Auth** · Gemini Developer API key, or a Vertex AI Express Mode key | **Models** · Google Gemini models |
| OpenCode | **Auth** · Per-backend API key (Ollama and Bedrock may need none) | **Models** · Anthropic, OpenAI, OpenRouter, Ollama, DeepSeek, Groq, Gemini, Azure OpenAI, Bedrock, Perplexity, Mistral, xAI, Cerebras |
| Cursor | **Auth** · Cursor API key | **Models** · Cursor-router models — GPT, Claude, Gemini, Grok, and Composer |

Skill directories differ per engine — see [Install skills](../guides/skills.md).
