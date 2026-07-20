UPDATE character_versions
SET definition = definition
  - 'defaultSettings'
  - 'temperature'
  - 'topP'
  - 'top_p'
  - 'maxResponseTokens'
  - 'max_response_tokens'
  - 'contextWindow'
  - 'contextMessages'
  - 'context_messages';
