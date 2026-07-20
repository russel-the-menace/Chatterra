Chatterra backend MVP additions

Files added:
- `types.ts`: TypeScript interfaces for User, Character, Conversation, Message, Memory, ConversationSummary.

What changed in `server.ts`:
- Added a tiny file-backed JSON store under `/data` for `users.json`, `characters.json`, `conversations.json`, `messages.json`, and `memories.json`.
- Persist messages and conversations on each chat call.
- Simple rule-based memory extraction (heuristic looking for "I am / I'm / I worked" patterns).
- Calls DeepSeek API using `DEEPSEEK_API_KEY` from environment.

Run backend:

```bash
cd backend
npm install
# ensure .env has DEEPSEEK_API_KEY
npm run dev
```
