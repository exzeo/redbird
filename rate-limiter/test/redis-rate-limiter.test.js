'use strict';

const expect = require('chai').expect;
const assert = require('assert');
const sinon = require('sinon');

context('redis rate limiter', () => {
  const RedisRateLimiter = require('../lib/rate-limiters/redis-rate-limiter');
  const redisClientMock = {
    script(command, script, callback) { callback(null, 'fakesha'); },
    multi() { return this; },
    zremrangebyscore() { return this; },
    zcard() { return this; },
    evalsha() { return this; },
    expire() { return this; },
    exec(callback) { callback(); }
  };

  beforeEach(() => {
    this.sinon = sinon.sandbox.create();
  });

  afterEach(() => {
    this.sinon.restore();
  });

  describe('sets up redis', () => {
    it('throws an error if the redis client is not provided', () => {
      expect(() => RedisRateLimiter.create()).to.throw();
    });

    it('loads the script', (done) => {
      this.sinon.stub(redisClientMock, 'script').callsFake((command, script, callback) => {
        try {
          expect(command).to.equal('load');
          expect(script).to.be.ok;
          expect(callback).to.be.ok;
          done();
        } catch (ex) {
          done(ex);
        }
      });

      RedisRateLimiter.create({ client: redisClientMock });
    });
  });

  describe('increments the count', () => {
    it('increments the count in redis', async () => {
      const multiSpy = this.sinon.spy(redisClientMock, 'multi');
      const zremrangebyscoreSpy = this.sinon.spy(redisClientMock, 'zremrangebyscore');
      const zcardSpy = this.sinon.spy(redisClientMock, 'zcard');
      const evalshaSpy = this.sinon.spy(redisClientMock, 'evalsha');
      const expireSpy = this.sinon.spy(redisClientMock, 'expire');
      const execSpy = this.sinon.stub(redisClientMock, 'exec').callsFake((callback) => {
        callback(null, [0, 4, 0, 0, 0, 8, 0, 0]);
      });

      const rateLimiter = RedisRateLimiter.create({ client: redisClientMock });

      const counts = await rateLimiter.incrementRequest('test', [
        { amount: 1000, precision: 1000 },
        { amount: 1000, precision: 60 * 1000 }
      ]);

      expect(multiSpy.calledOnce).to.be.true;
      expect(zremrangebyscoreSpy.calledTwice).to.be.true;
      expect(zremrangebyscoreSpy.args[0][0]).to.equal('test:1000'); // key
      expect(zremrangebyscoreSpy.args[0][2]).to.at.least(Date.now() - 1000 - 2); // aged
      expect(zremrangebyscoreSpy.args[1][0]).to.equal('test:60000'); // key
      expect(zcardSpy.calledTwice).to.be.true;
      expect(evalshaSpy.calledTwice).to.be.true;
      expect(expireSpy.calledTwice).to.be.true;
      expect(expireSpy.args[0][1]).to.be.at.least(Math.ceil((Date.now() + 1000 + 1) / 1000)); // expires time
      expect(execSpy.calledOnce).to.be.true;
      expect(counts).to.deep.equal([4, 8]); // counts
    });

    it('returns error if exec fails', () => {
      this.sinon.stub(redisClientMock, 'exec').callsFake((callback) => {
        callback(new Error('test'));
      });

      const rateLimiter = RedisRateLimiter.create({ client: redisClientMock });

      return rateLimiter.incrementRequest('test', [{ amount: 1000, precision: 1000 }])
        .then(
          assert.fail,
          error => expect(error).to.have.property('message', 'test')
        );
    });

    it('returns error if load script fails', () => {
      this.sinon.stub(redisClientMock, 'script').callsFake((command, script, callback) => callback(new Error('test')));

      const rateLimiter = RedisRateLimiter.create({ client: redisClientMock });

      return rateLimiter.incrementRequest('test', [{ amount: 1000, precision: 1000 }])
        .then(
          assert.fail,
          error => expect(error).to.have.property('message', 'test')
        );
    });
  });
});
