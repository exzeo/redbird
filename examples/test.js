'use strict';

const server = require('../index.js')({ port: 8080 });

const authService = {
  checkClaim() {
    return new Promise(resolve => {
      setTimeout(() => resolve(true), 200);
    });
  }
};

server.addResolver(/^\/test-route/)
  .use((context, request, response, next) => {
    authService.checkClaim()
      .then(
        authorized => {
          console.log(`setting route ${authorized}`);
          context.route = 'http://127.0.0.1:8181';
          next();
        }
      );
  })
  .use((context, request, response, next) => {
    console.log('next thing');
    next();
  });

server.addResolver(/^\/error/)
  .use((context, request, response, next) => {
    response.writeHead(401);
    response.end();

    next();
  });

const http = require('http');
http.createServer((request, response) => {
  response.writeHead(200);
  request.pipe(response);
}).listen(8181);