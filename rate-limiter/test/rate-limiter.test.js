'use strict';

const expect = require('chai').expect;
const assert = require('assert');
const sinon = require('sinon');

context.only('rate limiter', () => {
  const RateLimiter = require('../lib/rate-limiters/rate-limiter');
  const errors = require('../lib/errors');

  beforeEach(() => {
    this.sinon = sinon.sandbox.create();
  });

  afterEach(() => {
    this.sinon.restore();
  });

  describe('checks count against limits', () => {
    it('validates the request when the count is less than the limit', () => {
      const rateLimiter = RateLimiter.create({ limits: [{ amount: 10, precision: 1000 }] });
      return rateLimiter.validateRequest('test')
        .catch(
          assert.fail
        );
    });

    it('checks the incremented count against the request limit', () => {
      const rateLimiter = RateLimiter.create({ limits: [{ amount: 1, precision: 1000 }] });
      return rateLimiter.validateRequest('test')
        .then(
          assert.fail,
          error => expect(error).to.be.an.instanceof(errors.TooManyRequestsError)
        );
    });

    it('with multiple limits any one count invalidates the request', () => {
      const rateLimiter = RateLimiter.create({
        limits: [
          { amount: 1, precision: 1000 },
          { amount: 10, precision: 1000 }
        ]
      });
      return rateLimiter.validateRequest('test')
        .then(
          assert.fail,
          error => expect(error).to.be.an.instanceof(errors.TooManyRequestsError)
        );
    });

    it('applies alternate limits if passed', () => {
      const rateLimiter = RateLimiter.create({
        limits: [
          { amount: 1, precision: 1000 }
        ]
      });
      return rateLimiter.validateRequest('test', [{ amount: 10, precision: 1000 }])
        .catch(
          assert.fail
        );
    });
  });
});
