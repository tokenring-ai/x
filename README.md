# @tokenring-ai/x

## Overview

The `@tokenring-ai/x` package provides an X (formerly Twitter) social media
integration for the Token Ring AI ecosystem. It implements the
`SocialMediaProvider` interface from `@tokenring-ai/social`, enabling agents to
authenticate with X/Twitter, retrieve user accounts, fetch recent posts, look up
posts by ID, and create new posts.

This package integrates with the Token Ring agent, chat, and social media
service systems to provide seamless X/Twitter functionality within
AI-powered workflows.

### Key Features

- **Authentication**: OAuth 2.0 Bearer Token authentication for X API v2
- **Account Management**: Retrieve authenticated user account information
- **Post Retrieval**: Fetch recent posts with configurable filters (replies,
  reshares, date ranges)
- **Post Lookup**: Retrieve specific posts by ID with author information
- **Post Creation**: Create new posts with optional reply threading
- **Metrics Tracking**: Access to engagement metrics (likes, replies, retweets,
  quotes, impressions)
- **Provider Architecture**: Pluggable design following Token Ring's social
  media service pattern
- **Account Caching**: Caches account information to reduce API calls
- **Multi-Account Support**: Configure multiple X accounts via environment
  variables or configuration

## Installation

```bash
bun add @tokenring-ai/x
```

## Dependencies

- `@tokenring-ai/agent` - Agent orchestration
- `@tokenring-ai/app` - Application base and plugin system
- `@tokenring-ai/utility` - HTTP utilities and helper functions
- `zod` - Schema validation

## Features

- **OAuth 2.0 Authentication**: Bearer token-based authentication for X API v2
- **Account Caching**: Provider caches account information to reduce API calls
- **Multi-Account Support**: Configure multiple X accounts via environment
  variables or configuration
- **Post Filtering**: Filter recent posts by replies, reshares, and date ranges
- **Reply Threading**: Create posts as replies to existing tweets
- **Response Validation**: All API responses are validated with Zod schemas
- **Automatic Environment Loading**: Automatically loads accounts from `X_TOKEN{n}` environment variables

## Chat Commands

This package does not define chat commands directly. Chat commands for social
media operations are provided by the `@tokenring-ai/social` package.

## Tools

This package does not define tools directly. Tools for social media operations
are provided by the `@tokenring-ai/social` package.

## Configuration

### Environment Variables

The package supports configuration via environment variables for multiple
accounts. Environment variables are automatically loaded when the plugin is
installed:

| Variable            | Description                                                 | Required                         |
|---------------------|-------------------------------------------------------------|----------------------------------|
| `X_TOKEN`           | Bearer token for the default account                        | No                               |
| `X_TOKEN{n}`        | Bearer token for account {n} (e.g., `X_TOKEN0`, `X_TOKEN1`) | No                               |
| `X_ACCOUNT_NAME{n}` | Display name for account {n}                                | No (defaults to "X Account {n}") |

At least one bearer token must be provided either through environment variables
or configuration.

Bearer tokens must have user-context access for the following API endpoints:

- `GET /2/users/me` -- Retrieve current user account
- `GET /2/users/:id/tweets` -- Retrieve user's recent posts
- `POST /2/tweets` -- Create new posts

### Configuration Options

| Option        | Type   | Default                                                        | Description                                          |
|---------------|--------|----------------------------------------------------------------|------------------------------------------------------|
| `baseUrl`     | string | `"https://api.x.com"`                                          | X API base URL                                       |
| `bearerToken` | string | Required                                                       | OAuth 2.0 Bearer Token                               |
| `userAgent`   | string | `"TokenRing-Writer/1.0 (https://github.com/tokenring/writer)"` | User-Agent header                                    |
| `userId`      | string | Optional                                                       | Specific user ID to fetch (defaults to current user) |

### Configuration Schema

```typescript
// Provider options schema
export const XProviderOptionsSchema = z.object({
  baseUrl: z.string().default("https://api.x.com"),
  bearerToken: z.string(),
  userAgent: z.string()
    .default("TokenRing-Writer/1.0 (https://github.com/tokenring/writer)"),
  userId: z.string().exactOptional(),
});

// Full configuration schema
export const XConfigSchema = z.object({
  accounts: z.record(z.string(), XProviderOptionsSchema),
});
```

### Configuration Example

Configure the package in your application configuration:

```yaml
x:
  accounts:
    main:
      bearerToken: "your-bearer-token-here"
```

### Programmatic Configuration

```typescript
import { App } from "@tokenring-ai/app";
import xPlugin from "@tokenring-ai/x/plugin";

const app = new App();

await app.install(xPlugin, {
  x: {
    accounts: {
      main: {
        bearerToken: "your-bearer-token",
      },
    },
  },
});
```

### Environment Variable Configuration

Accounts can also be configured via environment variables:

```bash
# Default account
export X_TOKEN="your-bearer-token"

# Multiple accounts
export X_TOKEN0="token-for-account-0"
export X_ACCOUNT_NAME0="My Account 0"
export X_TOKEN1="token-for-account-1"
export X_ACCOUNT_NAME1="My Account 1"
```

When using environment variables, the plugin automatically registers each account
as a separate social media provider.

## API Endpoints

The package uses the following X API v2 endpoints:

| Endpoint              | Method | Description                         |
|-----------------------|--------|-------------------------------------|
| `/2/users/me`         | GET    | Retrieve current authenticated user |
| `/2/users/:id`        | GET    | Retrieve specific user by ID        |
| `/2/users/:id/tweets` | GET    | Retrieve user's recent posts        |
| `/2/tweets/:id`       | GET    | Retrieve specific post by ID        |
| `/2/tweets`           | POST   | Create a new post                   |

## Exports

```typescript
// Main exports
export { XProviderOptionsSchema, XConfigSchema } from "./schema.ts";
export type { XProviderOptions, XConfig } from "./schema.ts";
export { default as XSocialMediaProvider } from "./XSocialMediaProvider.ts";
```

## Testing

```bash
# Run tests
bun test

# Run tests in watch mode
bun test --watch

# Run tests with coverage
bun test --coverage
```

## License

MIT License - see LICENSE file for details.
