'use strict';

const rateLimiter = require('./rate-limiter');

function createInMemoryRateLimiter(options = {}) {
  const sets = {};

  return Object.assign(rateLimiter.create(options), {
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
  });
}

module.exports = { create: createInMemoryRateLimiter };