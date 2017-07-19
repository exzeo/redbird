'use strict';

function incrementRequest(client, addSha, id, limit) {
  const ts = Date.now();
  const aged = ts - limit.precision;
  const key = `${id}:${limit.precision}`;
  return client
    .zremrangebyscore(key, 0, aged)
    .zcard(key)    
    .evalsha(addSha, 1, key, limit.amount, ts)
    .expire(key, Math.ceil((ts + limit.precision + 1) / 1000));
}

function createRedisRateLimiterProvider(options = {}) {
  let {
    client = null
  } = options;

  let loadScript = new Promise((resolve, reject) => {
    client.script('load', 
`local c = tonumber(redis.call('ZCARD', KEYS[1]));
if c == nil or tonumber(ARGV[1]) > c then
  redis.call('zadd', KEYS[1], ARGV[2], ARGV[2]);
  return 1;
else
  return 0;
end`, (error, scriptSha) => {
      if (error) {
        return reject(error);
      }

      resolve(scriptSha);
    });
  });

  return {
    incrementRequest(id, limits) {
      return loadScript
        .then(addScriptSha => new Promise((resolve, reject) => {
          let clientRequest = client.multi();
          for (const limit of limits) {
            clientRequest = incrementRequest(clientRequest, addScriptSha, id, limit);
          }
          return clientRequest.exec((error, response) => {
            if (error) {
              return reject(error);
            }

            const counts = response.filter((result, index) => index % 4 === 1);
            resolve(counts);
          });
        })
      );
    }
  };
}

function createInMemoryRateLimiterProvider(options = {}) {
  const sets = {};

  return {
    incrementRequest(id, limits) {
      return Promise.resolve(limits.map(limit => {
        const key = `${id}:${limit.precision}`;

        if (!sets[key]) {
          sets[key] = [];
        }
        
        const ts = Date.now();
        const aged = ts - limit.precision;

        for (let i = 0; i < sets[key].length; ++i) {
          if (sets[key][i] <= aged) {
            sets[key].shift();
            --i;
          } else {
            break;
          }
        }

        const count = sets[key].length;

        if (sets[key].length < limit.amount) {
          sets[key].push(ts);
        }
        
        return count;
      }));
    }
  };
}

function createRateLimiter(options = {}) {
  const {
    provider = createInMemoryRateLimiterProvider(),
    limits = [
      { amount: 10, precision: 1000 }
    ]
  } = options;

  return {
    incrementRequest(id, alternateLimits) {
      let requestLimits = alternateLimits || limits;

      return provider.incrementRequest(id, requestLimits)
        .then(counts => {
          const limitRequest = counts.some((c, i) => c >= requestLimits[i].amount);

          if (limitRequest) {
            const error = new Error('Too Many Requests');
            error.status = 429;
            throw error;
          }
        });
    }
  };
}

function middleware(options) {
  const rateLimiter = createRateLimiter(options);  

  return (context, request, response, next) => {
    if (context.bypassRateLimits) {
      return next();
    }

    rateLimiter.incrementRequest(context.id, context.alternateLimits)
      .then(next, next);
  };
}

module.exports = { middleware, createRateLimiter, createRedisRateLimiterProvider, createInMemoryRateLimiterProvider };