'use strict';

module.exports = class TooManyRequestsError extends require('./status-error') {
  constructor() {
    super('Too Many Requests', 429);
  }
};
