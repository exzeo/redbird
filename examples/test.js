'use strict';

const server = require('../index.js')({ port: 8080, 
  defaultErrorHandler(error, request, response) {
    console.log(error.message);
    response.writeHead(500);
    response.write('default error handler');
    response.end();
  }
});

const authService = {
  checkClaim() {
    return new Promise(resolve => {
      setTimeout(() => resolve(true), 200);
    });
  }
};
server.addResolver({
  method: 'GET',
  match: /^\/test-route/,
  priority: 100
})
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
    console.log('GET next thing');
    next();
  });

server.addResolver({
  method: 'POST',
  match: /^\/test-route/,
  priority: 100
})
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
    console.log('POST next thing');
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