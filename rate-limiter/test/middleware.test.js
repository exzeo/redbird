'use strict';

const expect = require('chai').expect;
const assert = require('assert');
const sinon = require('sinon');

context('middleware', () => {
  const rateLimit = require('../lib/middleware');
  const inMemoryRateLimiter = require('../lib/rate-limiters/in-memory-rate-limiter');

  const mockRateLimiter = { 
    validateRequest() { return Promise.resolve(); }
  };

  beforeEach(() => {
    this.sinon = sinon.sandbox.create();
  });

  afterEach(() => {
    this.sinon.restore();
  });

  describe('configuration', () => {
    it('uses the default rate limiter', () => {
      this.sinon.stub(inMemoryRateLimiter, 'create').returns(mockRateLimiter);
      const validateRequestSpy = this.sinon.spy(mockRateLimiter, 'validateRequest');
      const middleware = rateLimit();

      middleware({}, {}, {});

      expect(validateRequestSpy.calledOnce).to.be.true;
    });
  });

  describe('Validates the request', () => {
    let middleware = null;

    before(() => {
      middleware = rateLimit({ rateLimiter: mockRateLimiter });
    });

    it('passes the context id and alternate limits', () => {
      const validateRequestSpy = this.sinon.spy(mockRateLimiter, 'validateRequest');

      middleware({ id: 'test id', alternateLimits: [{ amount: 1234, precision: 1234 }] }, {}, {});

      expect(validateRequestSpy.calledOnce).to.be.true;
      const [contextId, alternateLimits] = validateRequestSpy.args[0];
      expect(contextId).to.equal('test id');
      expect(alternateLimits).to.deep.equal([{ amount: 1234, precision: 1234 }]);
    });

    it('projects an error during validation up the chain', () => {
      this.sinon.stub(mockRateLimiter, 'validateRequest')
        .returns(Promise.reject(new Error('test')));
      
      return middleware({}, {}, {})
        .then(
          assert.fail,
          error => expect(error).to.have.property('message', 'test')
        );
    });

    it('bypasses the validation if the bypassRateLimits flag is set', () => {
      const validateRequestSpy = this.sinon.spy(mockRateLimiter, 'validateRequest');
      
      return middleware({ bypassRateLimits: true }, {}, {}, () => {})
        .then(
          () => {
            expect(validateRequestSpy.called).to.be.false;
          },
          assert.fail
        );
    });
  });
});
