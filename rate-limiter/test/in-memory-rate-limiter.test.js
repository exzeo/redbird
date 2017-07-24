'use strict';

const expect = require('chai').expect;
const assert = require('assert');
const sinon = require('sinon');

context('in memory rate limiter', () => {
  const InMemoryRateLimiter = require('../lib/rate-limiters/in-memory-rate-limiter');
  
  beforeEach(() => {
    this.sinon = sinon.sandbox.create();
  });

  afterEach(() => {
    this.sinon.restore();
  });

  describe('increments count against limits', () => {
    it('increments count', async () => {
      const rateLimiter = InMemoryRateLimiter.create();
      const limits = [
        { amount: 5, precision: 1000 }
      ];
      let counts;
      counts = await rateLimiter.incrementRequest('test', limits);
      expect(counts).to.deep.equal([0]);
      counts = await rateLimiter.incrementRequest('test', limits);
      expect(counts).to.deep.equal([1]);
      counts = await rateLimiter.incrementRequest('test', limits);
      expect(counts).to.deep.equal([2]);
    });

    it('increments count until amount is reached', async () => {
      const rateLimiter = InMemoryRateLimiter.create();
      const limits = [
        { amount: 5, precision: 1000 }
      ];
      await rateLimiter.incrementRequest('test', limits);
      await rateLimiter.incrementRequest('test', limits);
      await rateLimiter.incrementRequest('test', limits);
      await rateLimiter.incrementRequest('test', limits);
      await rateLimiter.incrementRequest('test', limits);
      await rateLimiter.incrementRequest('test', limits);
      await rateLimiter.incrementRequest('test', limits);
      const counts = await rateLimiter.incrementRequest('test', limits);

      expect(counts).to.deep.equal([5]);
    });

    it('expires old data', async () => {
      const rateLimiter = InMemoryRateLimiter.create();
      const limits = [
        { amount: 1, precision: 1 }
      ];
      let counts;
      await rateLimiter.incrementRequest('test', limits);
      await rateLimiter.incrementRequest('test', limits);
      counts = await rateLimiter.incrementRequest('test', limits);
      expect(counts).to.deep.equal([1]);

      await (new Promise(resolve => setTimeout(resolve, 1)));

      counts = await rateLimiter.incrementRequest('test', limits);
      expect(counts).to.deep.equal([0]);
    });
  });
});
