
# Exframe Redbird Rate Limiter - Rate limiter middleware

Flexible and module sliding window rate limiting for the exframe variant of Redbird.

```javascript
const { middleware: rateLimit, redisRateLimiter } = require('rate-limiter');

server.AddResolver(...)
  .use(rateLimit({
    rateLimiter: redisRateLimiter.create({
      client: redisClient,
      limits: [
        { amount: 100, precision: 1000 },
        { amount: 1000, precision: 60 * 1000 }
        ...
      ]
    })
  }))
  .use(...);
```

## Usage

### middleware(options) -> redbird middleware
Creates a rate limiting middleware that will dynamically restrict the number of requests.

`options`
- `rateLimiter` - (*required*) The rate limiting provider that will interface with whatever store is being used. Redis and in memory providers are included.

Creates an error object with a field `status` set to 429 for too many requests.

### redisRateLimiter.create(options) -> rate limiter provider
Creates a rate limiter provider that uses redis as its store. Uses sorted sets to track usage.

`options`
- `client` - (*required*) The redis client. See [redis npm module](https://www.npmjs.com/package/redis).
- `limits` - (*optional, defaults to 10 requests per second*) The array of limits to apply to any given request. See more @ [Limits](#limits).

### inMemoryRateLimiter.create(options) -> rate limiter provider
A rudimentary provider in that resides totally in memory. Is not heavily optimized and is not recommended for extreme use in production.

`options`
- `limits` - (*optional, defaults to 10 requests per second*) The array of limits to apply to any given request. See more @ [Limits](#limits).

## Limits
The rate limiter applies limits to requests using a tiered approach. The developer can choose varying amounts and varying levels of precision to achieve granular control over the number of requests flowing through the proxy.

A limit is defined as the amount of requests over a given time precision (in milliseconds).

```javascript
{
  amount: 1000
  precision: 60 * 1000
}
```

### Adjusting Limits per Request
The limits for any given request can be adjust upstream of the rate limiting middleware. Fields can be applied to the context object.

- `context.bypassRateLimits` - (*boolean*, defaults to false) If true, the rate limiter will not track the usage and simply let all requests through.
- `context.alternateLimits` - (*array of [limits](#limits)*) When set for a request, the rate limiter will use these given limits instead.