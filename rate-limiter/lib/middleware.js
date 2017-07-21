'use strict';

const inMemoryRateLimiter = require('./rate-limiters/in-memory-rate-limiter');

function middleware(options = {}) {
  let {
    rateLimiter = null
  } = options;

  if (!rateLimiter) {
    rateLimiter = inMemoryRateLimiter.create(options);
  }

  return (context, request, response, next) => {
    if (context.bypassRateLimits) {
      return Promise.resolve(next());
    }

    return rateLimiter.validateRequest(context.id, context.alternateLimits)
      .then(next, next);
  };
}

module.exports = middleware;
