/*eslint-env node */
'use strict';

const
  Promise = require('bluebird'),
  http = require('http'),
  httpProxy = require('http-proxy'),
  validUrl = require('valid-url'),
  parseUrl = require('url').parse,
  path = require('path'),
  _ = require('lodash'),
  bunyan = require('bunyan'),
  cluster = require('cluster'),
  hash = require('object-hash'),
  LRUCache = require("lru-cache"),
  routeCache = LRUCache({ max: 5000 }),
  safe = require('safetimeout'),
  letsencrypt = require('./letsencrypt.js');

var ONE_DAY = 60 * 60 * 24 * 1000;
var ONE_MONTH = ONE_DAY * 30;

function ReverseProxy(opts) {
  if (!(this instanceof ReverseProxy)) {
    return new ReverseProxy(opts);
  }

  this.opts = opts = opts || {};

  var log;
  if (opts.bunyan !== false) {
    log = this.log = bunyan.createLogger(opts.bunyan || {
      name: 'redbird'
    });
  }

  var _this = this;

  if (opts.cluster && typeof opts.cluster !== 'number' ||  opts.cluster > 32) {
    throw Error('cluster setting must be an integer less than 32');
  }

  if (opts.cluster && cluster.isMaster) {
    for (var i = 0; i < opts.cluster; i++) {
      cluster.fork();
    }

    cluster.on('exit', function (worker, code, signal) {
      // Fork if a worker dies.
      log && log.error({
        code: code,
        signal: signal
      },
        'worker died un-expectedly... restarting it.');
      cluster.fork();
    });
  } else {
    this.resolvers = [];
    this.addResolver(this._defaultResolver);

    this.defaultErrorHandler = opts.defaultErrorHandler || respondInternalServerError.bind(this, this.log);

    opts.port = opts.port || 8080;

    if (opts.letsencrypt) {
      this.setupLetsencrypt(log, opts);
    }

    if (opts.resolvers) {
      this.addResolver(opts.resolvers);
    }

    //
    // Routing table.
    //
    this.routing = {};

    //
    // Create a proxy server with custom application logic
    //
    var proxy = this.proxy = httpProxy.createProxyServer({
      xfwd: (opts.xfwd != false),
      prependPath: false,
      secure: (opts.secure !== false),
      /*
      agent: new http.Agent({
        keepAlive: true
      })
      */
    });

    proxy.on('proxyReq', function (p, req) {
      if (req.host != null) {
        p.setHeader('host', req.host);
      }
    });

    //
    // Support NTLM auth
    //
    if (opts.ntlm) {
      proxy.on('proxyRes', function (proxyRes) {
        var key = 'www-authenticate';
        proxyRes.headers[key] = proxyRes.headers[key] && proxyRes.headers[key].split(',');
      });
    }

    //
    // Optionally create an https proxy server.
    //
    if (opts.ssl) {
      if (_.isArray(opts.ssl)) {
        opts.ssl.forEach(function(sslOpts){
          _this.setupHttpsProxy(proxy, websocketsUpgrade, log, sslOpts);
        })
      } else {
        this.setupHttpsProxy(proxy, websocketsUpgrade, log, opts.ssl);
      }
    }

    //
    // Plain HTTP Proxy
    //
    var server = this.setupHttpProxy(proxy, websocketsUpgrade, log, opts);

    server.listen(opts.port, opts.host);

    if (opts.errorHandler && _.isFunction(opts.errorHandler)) {
      proxy.on('error', opts.errorHandler);
    } else {
      proxy.on('error', handleProxyError);
    }

    log && log.info('Started a Redbird reverse proxy server on port %s', opts.port);
  }

  function websocketsUpgrade(req, socket, head) {
    var src = this._getSource(req);
    const context = { src };

    this._getTarget(context, req, socket)
      .then(
        target => {
          if (socket.finished) {
            return;
          }
          log && log.info({ headers: req.headers, target: target }, 'upgrade to websockets');

          if (target) {
            proxy.ws(req, socket, head, { target: target });
          } else {
            respondNotFound(req, socket);
          }
        },
        error => this.defaultErrorHandler(error, req, socket)
      );
  }

  function handleProxyError(err, req, res) {
    //
    // Send a 500 http status if headers have been sent
    //

    if (err.code === 'ECONNREFUSED') {
      res.writeHead && res.writeHead(502);
    } else if (!res.headersSent) {
      res.writeHead && res.writeHead(500);
    }

    //
    // Do not log this common error
    //
    if (err.message !== 'socket hang up') {
      log && log.error(err, 'Proxy Error');
    }

    //
    // TODO: if err.code=ECONNREFUSED and there are more servers
    // for this route, try another one.
    //
    res.end(err.code)
  }
}

ReverseProxy.prototype.setupHttpProxy = function (proxy, websocketsUpgrade, log, opts) {
  var server = this.server = http.createServer((req, res) => {
    var src = this._getSource(req);
    const context = { src };
    this._getTarget(context, req, res)
      .then(
        target => {
          if (res.finished) {
            return;
          }

          if (target){
            if (shouldRedirectToHttps(this.certs, src, target, this)) {
              redirectToHttps(req, res, target, opts.ssl, log);
            } else {
              proxy.web(req, res, { target: target });
            }
          } else {
            respondNotFound(req, res);
          }
        },
        error => this.defaultErrorHandler(error, req, res)
      );
  });

  //
  // Listen to the `upgrade` event and proxy the
  // WebSocket requests as well.
  //
  server.on('upgrade', websocketsUpgrade);

  server.on('error', function (err) {
    log && log.error(err, 'Server Error');
  });

  return server;
}

function shouldRedirectToHttps(certs, src, target, proxy) {
  return certs && src in certs && target.sslRedirect && target.host != proxy.letsencryptHost;
}

ReverseProxy.prototype.setupLetsencrypt = function (log, opts) {
  if (!opts.letsencrypt.path) {
    throw Error('Missing certificate path for Lets Encrypt');
  }
  var letsencryptPort = opts.letsencrypt.port || 3000;
  letsencrypt.init(opts.letsencrypt.path, letsencryptPort, log);

  opts.resolvers = opts.resolvers || [];
  this.letsencryptHost = '127.0.0.1:' + letsencryptPort;
  var targetHost = 'http://' + this.letsencryptHost;
  var challengeResolver = function (host, url) {
    if (/^\/.well-known\/acme-challenge/.test(url)) {
      return targetHost + '/' + host;
    }
  }
  challengeResolver.priority = 9999;
  this.addResolver(challengeResolver);
}

ReverseProxy.prototype.setupHttpsProxy = function (proxy, websocketsUpgrade, log, sslOpts){
  var _this = this;
  var https;

  this.certs = this.certs || {};

  var certs = this.certs;

  var ssl = {
    SNICallback: function (hostname, cb) {
      if (cb) {
        cb(null, certs[hostname]);
      } else {
        return certs[hostname];
      }
    },
    //
    // Default certs for clients that do not support SNI.
    //
    key: getCertData(sslOpts.key),
    cert: getCertData(sslOpts.cert)
  };

  if (sslOpts.ca) {
    ssl.ca = getCertData(sslOpts.ca, true);
  }

  if (sslOpts.opts) {
    ssl = _.defaults(ssl, sslOpts.opts);
  }

  if (sslOpts.http2) {
    https = require('spdy');
    if(_.isObject(sslOpts.http2)){
      sslOpts.spdy = sslOpts.http2;
    }
  } else {
    https = require('https');
  }

  var httpsServer = this.httpsServer = https.createServer(ssl, function (req, res) {
    var src = this._getSource(req);
    const context = { src };

    this._getTarget(context, req, res)
      .then(
        target => {
          if (res.finished) {
            return;
          }

          if (target) {
            proxy.web(req, res, { target: target });
          } else {
            respondNotFound(req, res);
          }
        },
        error => this.defaultErrorHandler(error, req, res)
      );
  });

  httpsServer.on('upgrade', websocketsUpgrade);

  httpsServer.on('error', function (err) {
    log && log.error(err, 'HTTPS Server Error');
  });

  httpsServer.on('clientError', function (err) {
    log && log.error(err, 'HTTPS Client  Error');
  });

  log && log.info('Listening to HTTPS requests on port %s', sslOpts.port);
  httpsServer.listen(sslOpts.port, sslOpts.ip);
}

const Resolver = (proxy, options = {}) => {
  const middleware = [];
  const errorMiddleware = [];
  const {
    match,
    priority = 0
  } = options;
  let resolverCallback;

  if (typeof options === 'function') {
    resolverCallback = options;
    middleware.push((context, request, response, next) => {
      context.route = resolverCallback.call(proxy, context.src, request.url);
      next();
    });
  } else {
    if (!match) {
      throw new Error('options.match is required');
    }
  }

  let hashCode = hash(resolverCallback || null) + hash(match || null);

  return {
    get hashCode() { return hashCode; },
    get resolverCallback() { return resolverCallback; },
    get priority() { return priority; },
    get match() { return match; },

    execute(context, request, response) {
      if (match && !match.test(request.url)) {
        return Promise.resolve();
      }

      return new Promise((resolve, reject) => {
        const callNextError = (error, i = 0) => {
          if (!errorMiddleware[i]) {
            return reject(error);
          }

          try {
            const promise = errorMiddleware[i](error, context, request, response, nextError => {
              if (response.finished) {
                return resolve();
              }

              if (!nextError) {
                nextError = error;
              }

              callNextError(nextError, i + 1);
            });
            if (promise) {
              promise.then(
                nextError => {
                  if (!nextError) {
                    nextError = error;
                  }

                  callNextError(nextError, i + 1);
                }, 
                reject
              );
            }
          } catch (ex) {
            reject(ex);
          }
        };       
        const callNext = (i = 0) => {
          if (!middleware[i]) {
            return resolve();
          }

          try {
            const responseEnd = response.end;
            response.end = function () {
              responseEnd.apply(response, arguments);
              resolve();
            };
            const promise = middleware[i](context, request, response, error => {
              if (error) {
                return callNextError(error);
              }

              if (response.finished) {
                return resolve();
              }

              callNext(i + 1);
            });
            if (promise) {
              promise.then(() => callNext(i + 1), callNextError);
            }
          } catch (ex) {
            callNextError(ex);
          }
        };
        callNext();
      });
    },

    use(callback) {
      if (callback.length <= 4) {
        middleware.push(callback);
      } else {
        errorMiddleware.push(callback);
      }

      return this;
    }
  };
}

ReverseProxy.prototype.addResolver = function (resolvers) {
  if (this.opts.cluster && cluster.isMaster) return this;

  let r;
  if (Array.isArray(resolvers) || _.isFunction(resolvers)) {
    if (!Array.isArray(resolvers)) {
      resolvers = [resolvers];
    }

    resolvers.forEach((resolveFn) => {
      if (typeof resolveFn !== 'function') {
        throw new Error("Resolver must be an invokable function.");
      }

      this.resolvers.push(Resolver(this, resolveFn));
    });
  } else if (_.isObject(resolvers)) {
    r = Resolver(this, resolvers);
    this.resolvers.push(r);
  }

  this.resolvers = _.sortBy(_.uniqBy(this.resolvers, r => r.hashCode), r => -r.priority);

  return r;
};

ReverseProxy.prototype.removeResolver = function (resolver) {
  if (this.opts.cluster && cluster.isMaster) return this;
  // since unique resolvers are not checked for performance,
  // just remove every existence.
  const resolverToRemove = Resolver(this, resolver);
  this.resolvers = this.resolvers.filter(function (r) {
    return resolverToRemove.hashCode !== r.hashCode;
  });
};

function buildTarget(target, opts) {
  opts = opts || {};
  target = prepareUrl(target);
  target.sslRedirect = !opts.ssl || opts.ssl.redirect !== false;
  target.useTargetHostHeader = opts.useTargetHostHeader === true;
  return target;
}

/**
 Register a new route.

 @src {String|URL} A string or a url parsed by node url module.
 Note that port is ignored, since the proxy just listens to one port.

 @target {String|URL} A string or a url parsed by node url module.
 @opts {Object} Route options.
 */
ReverseProxy.prototype.register = function (src, target, opts) {
  if (this.opts.cluster && cluster.isMaster) return this;

  if (!src || !target) {
    throw Error('Cannot register a new route with unspecified src or target');
  }

  var routing = this.routing;

  src = prepareUrl(src);

  if (opts) {
    var ssl = opts.ssl;
    if (ssl) {
      if (!this.httpsServer) {
        throw Error('Cannot register https routes without defining a ssl port');
      }

      if (!this.certs[src.hostname]) {
        if (ssl.key || ssl.cert || ssl.ca) {
          this.certs[src.hostname] = createCredentialContext(ssl.key, ssl.cert, ssl.ca);
        } else if (ssl.letsencrypt) {
          if (!this.opts.letsencrypt || !this.opts.letsencrypt.path) {
            console.error('Missing certificate path for Lets Encrypt');
            return;
          }
          this.log && this.log.info('Getting Lets Encrypt certificates for %s', src.hostname);
          this.updateCertificates(
            src.hostname,
            ssl.letsencrypt.email,
            ssl.letsencrypt.production,
            this.opts.letsencrypt.renewWithin || ONE_MONTH);
        } else {
          // Trigger the use of the default certificates.
          this.certs[src.hostname] = void 0;
        }
      }
    }
  }
  target = buildTarget(target, opts);

  var host = routing[src.hostname] = routing[src.hostname] || [];
  var pathname = src.pathname || '/';
  var route = _.find(host, { path: pathname });

  if (!route) {
    route = { path: pathname, rr: 0, urls: [] };
    host.push(route);

    //
    // Sort routes
    //
    routing[src.hostname] = _.sortBy(host, function (_route) {
      return -_route.path.length;
    });
  }

  route.urls.push(target);

  this.log && this.log.info({ from: src, to: target }, 'Registered a new route');
  return this;
};

ReverseProxy.prototype.updateCertificates = function (domain, email, production, renewWithin, renew) {
  var _this = this;
  return letsencrypt.getCertificates(domain, email, production, renew, this.log).then(function (certs) {
    if (certs) {
      var opts = {
        key: certs.privkey,
        cert: certs.cert + certs.chain
      }
      _this.certs[domain] = tls.createSecureContext(opts).context;

      //
      // TODO: cluster friendly
      //
      var renewTime = (certs.expiresAt - Date.now()) - renewWithin;
      renewTime = renewTime > 0 ? renewTime : _this.opts.letsencrypt.minRenewTime || 60 * 60 * 1000;

      _this.log && _this.log.info('Renewal of %s in %s days', domain, Math.floor(renewTime / ONE_DAY));

      function renewCertificate() {
        _this.log && _this.log.info('Renewing letscrypt certificates for %s', domain);
        _this.updateCertificates(domain, email, production, renewWithin, true);
      }

      _this.certs[domain].renewalTimeout = safe.setTimeout(renewCertificate, renewTime);
    } else {
      //
      // TODO: Try again, but we need an exponential backof to avoid getting banned.
      //
      _this.log && _this.log.info('Could not get any certs for %s', domain);
    }
  }, function (err) {
    console.error('Error getting LetsEncrypt certificates', err);
  });
};

ReverseProxy.prototype.unregister = function (src, target) {
  if (this.opts.cluster && cluster.isMaster) return this;

  if (!src) {
    return this;
  }

  src = prepareUrl(src);
  var routes = this.routing[src.hostname] || [];
  var pathname = src.pathname || '/';
  var i;

  for (i = 0; i < routes.length; i++) {
    if (routes[i].path === pathname) {
      break;
    }
  }

  if (i < routes.length) {
    var route = routes[i];

    if (target) {
      target = prepareUrl(target);
      _.remove(route.urls, function (url) {
        return url.href === target.href;
      });
    } else {
      route.urls = [];
    }

    if (route.urls.length === 0) {
      routes.splice(i, 1);
      var certs = this.certs;
      if (certs) {
        if (certs[src.hostname] && certs[src.hostname].renewalTimeout) {
          safe.clearTimeout(certs[src.hostname].renewalTimeout);
        }
        delete certs[src.hostname];
      }
    }

    this.log && this.log.info({ from: src, to: target }, 'Unregistered a route');
  }
  return this;
};

ReverseProxy.prototype._defaultResolver = function (host, url) {
  // Given a src resolve it to a target route if any available.
  if (!host) {
    return;
  }

  url = url || '/';

  var routes = this.routing[host];
  var i = 0;

  if (routes) {
    var len = routes.length;

    //
    // Find path that matches the start of req.url
    //
    for (i = 0; i < len; i++) {
      var route = routes[i];

      if (route.path === '/' || startsWith(url, route.path)) {
        return route;
      }
    }
  }
};

ReverseProxy.prototype._defaultResolver.priority = 0;

function buildRoute(route) {
  if (!_.isString(route) && !_.isObject(route)) {
    return null;
  }

  if (_.isObject(route) && route.hasOwnProperty('urls') && route.hasOwnProperty('path')) {
    // default route type matched.
    return route;
  }

  var cacheKey = _.isString(route) ? route : hash(route);
  var entry = routeCache.get(cacheKey);
  if (entry) {
    return entry;
  }

  var routeObject = { rr: 0, isResolved: true };
  if (_.isString(route)) {
    routeObject.urls = [buildTarget(route)];
    routeObject.path = '/';
  } else {
    if (!route.hasOwnProperty('url')) {
      return null;
    }

    routeObject.urls = (_.isArray(route.url) ? route.url : [route.url]).map(function (url) {
      return buildTarget(url, route.opts || {});
    });

    routeObject.path = route.path || '/';
  }
  routeCache.set(cacheKey, routeObject);
  return routeObject;
}
ReverseProxy.buildRoute = buildRoute;

/**
 * Resolves to route
 * @param host
 * @param url
 * @returns {*}
 */
ReverseProxy.prototype.resolve = function (context, request, response) {
  return new Promise((resolve, reject) => {
    const resolveRequest = i => {
      if (!this.resolvers[i]) {
        return resolve();
      }
      this.resolvers[i].execute(context, request, response)
        .then(
          () => {
            let route = context.route;

            if (route && (route = buildRoute(route))) {
              return resolve(route);
            }

            resolveRequest(i + 1);
          },
          reject
        );       
    };
    resolveRequest(0);
  });
};

ReverseProxy.prototype._getTarget = function (context, req, res) {
  return this.resolve(context, req, res)
    .then(route => {
      if (res.finished) {
        this.log && this.log.info('Request completed without proxying');
        return;
      }

      if (!route) {
        this.log && this.log.warn({ src: context.src, url: req.url }, 'no valid route found for given source');
        return;
      }

      var pathname = route.path;
      if (pathname.length > 1) {
        //
        // remove prefix from src
        //
        req._url = req.url; // save original url
        req.url = req.url.substr(pathname.length) || '/';
      }

      //
      // Perform Round-Robin on the available targets
      // TODO: if target errors with EHOSTUNREACH we should skip this
      // target and try with another.
      //
      var urls = route.urls;
      var j = route.rr;
      route.rr = (j + 1) % urls.length; // get and update Round-robin index.
      var target = route.urls[j];

      //
      // Fix request url if targetname specified.
      //
      if (target.pathname) {
        req.url = path.join(target.pathname, req.url);
      }

      //
      // Host headers are passed through from the source by default
      // Often we want to use the host header of the target instead
      //
      if (target.useTargetHostHeader === true) {
        req.host = target.host;
      }

      this.log && this.log.info('Proxying %s to %s', context.src + req.url, path.join(target.host, req.url));

      return target;
    });
};

ReverseProxy.prototype._getSource = function (req) {
  let host;
  if (this.opts.preferForwardedHost === true && req.headers['x-forwarded-host']) {
    host = req.headers['x-forwarded-host'].split(':')[0];
  } else if (req.headers.host) {
    host = req.headers.host.split(':')[0];
  }

  if (host) {
    host = host.toLowerCase();
  }

  return host;
}

ReverseProxy.prototype.close = function () {
  try {
    this.server.close();
    this.httpsServer && this.httpsServer.close();
  } catch (err) {
    // Ignore for now...
  }
};

//
// Helpers
//
/**
  Routing table structure. An object with hostname as key, and an array as value.
  The array has one element per path associated to the given hostname.
  Every path has a Round-Robin value (rr) and urls array, with all the urls available
  for this target route.

  {
    hostA :
      [
        {
          path: '/',
          rr: 3,
          urls: []
        }
      ]
  }
*/

function respondNotFound(req, res) {
  res.statusCode = 404;
  res.write('Not Found');
  res.end();
};

function respondInternalServerError(log, error, req, res) {
  log && log.error(error, {}, 'Error processing request');

  res.statusCode = 500;
  res.write('Internal Server Error');
  res.end();
}

ReverseProxy.prototype.notFound = function (callback) {
  if (typeof callback == "function")
    respondNotFound = callback;
  else
    throw Error('notFound callback is not a function');
};

//
// Redirect to the HTTPS proxy
//
function redirectToHttps(req, res, target, ssl, log) {
  req.url = req._url || req.url; // Get the original url since we are going to redirect.

  var targetPort = ssl.redirectPort || ssl.port;
  var hostname = req.headers.host.split(':')[0] + ( targetPort ? ':' + targetPort : '' );
  var url = 'https://' + path.join(hostname, req.url);
  log && log.info('Redirecting %s to %s', path.join(req.headers.host, req.url), url);
  //
  // We can use 301 for permanent redirect, but its bad for debugging, we may have it as
  // a configurable option.
  //
  res.writeHead(302, { Location: url });
  res.end();
}

function startsWith(input, str) {
  return input.slice(0, str.length) === str &&
    (input.length === str.length || input[str.length] === '/')
}

function prepareUrl(url) {
  url = _.clone(url);
  if (_.isString(url)) {
    url = setHttp(url);

    if (!validUrl.isHttpUri(url) && !validUrl.isHttpsUri(url)) {
      throw Error('uri is not a valid http uri ' + url);
    }

    url = parseUrl(url);
  }
  return url;
}

function getCertData(pathname, unbundle) {
  var fs = require('fs');

  // TODO: Support input as Buffer, Stream or Pathname.

  if (pathname) {
    if (_.isArray(pathname)) {
      var pathnames = pathname;
      return _.flatten(_.map(pathnames, function (_pathname) {
        return getCertData(_pathname, unbundle);
      }));
    } else if (fs.existsSync(pathname)) {
      if (unbundle) {
        return unbundleCert(fs.readFileSync(pathname, 'utf8'));
      } else {
        return fs.readFileSync(pathname, 'utf8');
      }
    }
  }
}

/**
 Unbundles a file composed of several certificates.
 http://www.benjiegillam.com/2012/06/node-dot-js-ssl-certificate-chain/
 */
function unbundleCert(bundle) {
  var chain = bundle.trim().split('\n');

  var ca = [];
  var cert = [];

  for (var i = 0, len = chain.length; i < len; i++) {
    var line = chain[i].trim();
    if (!(line.length !== 0)) {
      continue;
    }
    cert.push(line);
    if (line.match(/-END CERTIFICATE-/)) {
      var joined = cert.join('\n');
      ca.push(joined);
      cert = [];
    }
  }
  return ca;
}

var tls = require('tls');
function createCredentialContext(key, cert, ca) {
  var opts = {};

  opts.key = getCertData(key);
  opts.cert = getCertData(cert);
  if (ca) {
    opts.ca = getCertData(ca, true);
  }

  var credentials = tls.createSecureContext(opts);

  return credentials.context;
}

//
// https://stackoverflow.com/questions/18052919/javascript-regular-expression-to-add-protocol-to-url-string/18053700#18053700
// Adds http protocol if non specified.
function setHttp(link) {
  if (link.search(/^http[s]?\:\/\//) === -1) {
    link = 'http://' + link;
  }
  return link;
}

module.exports = ReverseProxy;
