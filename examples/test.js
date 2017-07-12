'use strict';

const server = require('../index.js')({ port: 8080 });

server.addResolver(/^\/test-route/)
  .use((context, request, response, next) => {
    console.log('setting route');
    context.route = 'http://127.0.0.1:8181';
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