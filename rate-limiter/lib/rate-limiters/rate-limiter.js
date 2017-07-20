'use strict';

const errors = require('../errors');

function createRateLimiter(options = {}) {
  const {
    limits = [
      { amount: 10, precision: 1000 }
    ]
  } = options;

  return {
    validateRequest(id, alternateLimits) {
      let requestLimits = alternateLimits || limits;

      return this.incrementRequest(id, requestLimits)
        .then(counts => {
          const limitRequest = counts.some((c, i) => c >= requestLimits[i].amount);

          if (limitRequest) {
            throw new errors.TooManyRequestsError();
          }
        });
    },

    incrementRequest(id, requestLimits) {
      return Promise.resolve(requestLimits.map(() => 1));
    }
  };
}

module.exports = { create: createRateLimiter };
