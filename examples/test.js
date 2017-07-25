'use strict';

const server = require('../index.js')({ port: 8080 });


const redis = require('redis');
const redisClient = redis.createClient();

const { middleware: rateLimit, redisRateLimiter } = require('exframe-rate-limiter');

const authService = {
  checkClaim() {
    return new Promise(resolve => {
      setTimeout(() => resolve(true), 200);
    });
  }
};

server.addResolver({
  match: /^\/test-route(\/*)?/,
  priority: 100
})
  .use((context, request, response, next) => {
    const match = /(bypass)|(preferred)/.exec(request.url);
    if (match) {
      switch (match[0]) {
        case 'bypass':
          context.bypassRateLimits = true;
          break;
        case 'preferred':
          context.alternateLimits = [
            { amount: 5, precision: 1000 }
          ];
          break;
      }
    }

    next();
  })
  .use(rateLimit({
    rateLimiter: redisRateLimiter.create({ 
      client: redisClient,
      limits: [
        { amount: 2, precision: 1000 },
        { amount: 100, precision: 60 * 1000 }
      ]
    })
  }))
  .use((context, request, response, next) => {
    authService.checkClaim()
      .then(
        authorized => {
          console.log(`1 setting route ${authorized}`);
          context.route = 'http://127.0.0.1:8181';
          next();
        }
      );
  })
  .use((context, request, response, next) => {
    console.log('1 next thing');
    next();
  });

server.addResolver({
  match: /^\/test*/,
  priority: 50
})
  .use((context, request, response, next) => {
    return authService.checkClaim()
      .then(
        authorized => {
          console.log(`2 setting route ${authorized}`);
          context.route = 'http://127.0.0.1:8181';
        }
      );
  })
  .use((context, request, response, next) => {
    console.log('2 next thing');
    next();
  });

server.addResolver({
  match: /^\/error/
})
  .use((context, request, response, next) => {
    response.writeHead(401);
    response.end();
  });

server.addResolver({
  match: /^\/exception/
})
  .use((context, request, response, next) => {
    throw new Error('test');
  })
  .use((error, context, request, response, next) => {
    response.write('error captured');
    response.end();
  });

server.addResolver({
  match: /^\/unhandled-exception/
})
  .use((context, request, response, next) => {
    throw new Error('test');
  });

const http = require('http');
http.createServer((request, response) => {
  response.writeHead(200);
  request.pipe(response);
}).listen(8181);