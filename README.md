# @tokenring-ai/x

`@tokenring-ai/x` registers X/Twitter providers with `@tokenring-ai/social`.

## Configuration

```ts
{
  social: {
    providers: {
      x: {
        type: "x",
        bearerToken: process.env.X_BEARER_TOKEN
      }
    }
  }
}
```

The bearer token must have user-context access for `GET /2/users/me`, `GET /2/users/:id/tweets`, and `POST /2/tweets`.
