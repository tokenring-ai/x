# @tokenring-ai/x

## Overview

X (Twitter) transport for TokenRing bots. This package connects X accounts and hands each one to
[`@tokenring-ai/bot`](../bot) as a messaging provider — it carries text to and from X (mentions and
direct messages), and nothing else.

Who a bot talks to and which agent answers are configured on the bot, not here. See the
`@tokenring-ai/bot` README for that half.

### Key Features

- **Multiple accounts**: run any number of X accounts side by side
- **Mentions**: polls the mentions timeline and routes each thread as a conversation
- **Direct messages**: polls DM events and routes each conversation as a 1:1 chat
- **Outbound posts and DMs**: bots can reply in a thread or message a user by id
- **Post-once replies**: streamed answers are posted once per part (no "working..." stub, no edits), since free accounts cannot edit a post
- **Secrets**: access tokens use the `@tokenring-ai/secrets` pattern

## Installation

```bash
bun add @tokenring-ai/x
```

Create a developer app at [developer.x.com](https://developer.x.com/) and obtain an **OAuth 2.0
user-context access token** for the account the bot should speak as. Typical scopes:

- `tweet.read`, `tweet.write`, `users.read` — mentions and public replies
- `dm.read`, `dm.write` — direct messages

## Configuration

```yaml
x:
  accounts:
    x:                                    # the service name bots address, e.g. x:123456789
      accessToken: { source: env, env: X_ACCESS_TOKEN }
      pollIntervalMs: 20000
      maxMessageLength: 280
      pollMentions: true
      pollDirectMessages: true
```

| Option               | Type      | Default                 | Description                                                                 |
|----------------------|-----------|-------------------------|-----------------------------------------------------------------------------|
| `accessToken`        | `secret`  | required                | OAuth 2.0 user-context access token (Bearer)                                |
| `baseUrl`            | `string`  | `https://api.x.com`     | X API base URL                                                              |
| `userAgent`          | `string`  | TokenRing-One/...       | User-Agent header                                                           |
| `pollIntervalMs`     | `number`  | `20000`                 | How often to poll for new mentions and DMs (minimum 5000)                   |
| `maxMessageLength`   | `number`  | `280`                   | Longest single post/DM; raise for Premium long-form                         |
| `pollMentions`       | `boolean` | `true`                  | Poll the mentions timeline                                                  |
| `pollDirectMessages` | `boolean` | `true`                  | Poll DM events                                                              |

Then point a bot at it:

```yaml
bot:
  bots:
    helper:
      agentType: assistant
      directMessages: listed          # only the users below; or none
      users:
        "x:123456789": admin          # X user id
      channels:
        mentions:
          target: "x:mentions"        # answer public mentions
          allowedUsers:               # who may mention it (see the bot README)
            - "x:123456789"
```

DMs use the bot's **direct message** policy. Mentions are public, so they are channel traffic in
the `mentions` room: a bot answers them only with a channel whose target is `x:mentions`, and each
reply thread gets its own conversation. The answer is posted as a reply to the mention itself.

Poll cursors are saved to `<workspace>/bot-state/x/<account>.json`, so a restart picks up the
mentions and DMs that arrived while it was down instead of skipping or replaying them.

### Connecting from chat

```
/connect x --name=x
```

Paste the token when prompted (a masked prompt), or pass it as a positional where nobody can answer a prompt (it then stays in
the chat history). The token is saved in the vault (category `x`, key `<name>.accessToken`) and the account's
`accessToken` is set to a `{ source: vault, ... }` reference to it; the vault must be unlocked.

### Addressing

| Target form        | Meaning                                      |
|--------------------|----------------------------------------------|
| `x:<userId>`       | DM that user (opens a conversation if needed)|
| conversation ids   | Internal: `dm:…` for DMs, `tweet:…` for threads |

User ids are numeric snowflakes from the X API (`/2/users/me`, profile lookups, etc.).

### Polling and rate limits

X does not expose a free realtime bot socket for all accounts, so this transport polls. Defaults are
conservative; raise `pollIntervalMs` if you hit rate limits, or lower it (not below 5000) for snappier
replies on higher tiers.

### Streaming without Premium

This provider sets `editsInPlace = false`, so ConversationStream never posts a "working..." placeholder
and never edits. Each part of an answer is posted once, when it can no longer change: a short answer is one
post, and a long answer is one post per part (split at the platform limit). Tweet edits require Premium
(Blue) and a short window, so posting once works on any account.

## Chat Commands

| Command       | Description                                      |
|---------------|--------------------------------------------------|
| `/connect x`  | Save an X access token to the vault and reference it from user or project config |

## Exports

```typescript
export { default as XMessagingProvider } from "./XMessagingProvider.ts";
export { default as XService } from "./XService.ts";
export { XAccountConfigSchema, XServiceConfigSchema, ... } from "./schema.ts";
```

## Testing

```bash
bun test
bun test --watch
bun test --coverage
```

## License

MIT License - see LICENSE file for details.
