'use strict';

// Load modules

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var Events = require('events');
var Url = require('url');
var Http = require('http');
var Https = require('https');
var Stream = require('stream');
var Hoek = require('hoek');
var Boom = require('boom');
var Payload = require('./payload');
var Recorder = require('./recorder');
var Tap = require('./tap');

// Declare internals

var internals = {
    jsonRegex: /^application\/([a-z0-9.]*[+-]json|json)$/,
    shallowOptions: ['agent', 'agents', 'beforeRedirect', 'downstreamRes', 'payload', 'redirected'],
    emitSymbol: Symbol.for('wreck')
};

process[internals.emitSymbol] = process[internals.emitSymbol] || new Events.EventEmitter();

// new instance is exported as module.exports

internals.Client = function (defaults) {

    defaults = defaults || {};
    Hoek.assert(!defaults.agents || defaults.agents.https && defaults.agents.http && defaults.agents.httpsAllowUnauthorized, 'defaults.agents must include "http", "https", and "httpsAllowUnauthorized"');

    this._defaults = Hoek.cloneWithShallow(defaults, internals.shallowOptions);

    this.agents = this._defaults.agents || {
        https: new Https.Agent({ maxSockets: Infinity }),
        http: new Http.Agent({ maxSockets: Infinity }),
        httpsAllowUnauthorized: new Https.Agent({ maxSockets: Infinity, rejectUnauthorized: false })
    };

    Events.EventEmitter.call(this);

    // replay request/response events to process[Symbol.for('wreck')]
    var self = this;
    var selfEmit = this.emit;
    this.emit = function () {

        var processEmitter = process[internals.emitSymbol];
        selfEmit.apply(self, arguments);
        processEmitter.emit.apply(processEmitter, arguments);
    };
};

Hoek.inherits(internals.Client, Events.EventEmitter);

internals.Client.prototype.defaults = function (options) {

    Hoek.assert(options && (typeof options === 'undefined' ? 'undefined' : _typeof(options)) === 'object', 'options must be provided to defaults');

    options = Hoek.applyToDefaultsWithShallow(this._defaults, options, internals.shallowOptions);
    return new internals.Client(options);
};

internals.resolveUrl = function (baseUrl, path) {

    if (!path) {
        return baseUrl;
    }

    var parsedPath = Url.parse(path);
    if (parsedPath.host && parsedPath.protocol) {
        return Url.format(parsedPath);
    }

    var parsedBase = Url.parse(baseUrl);
    parsedBase.pathname = parsedBase.pathname + parsedPath.pathname;
    parsedBase.pathname = parsedBase.pathname.replace(/[/]{2,}/g, '/');
    parsedBase.search = parsedPath.search; // Always use the querystring from the path argument

    return Url.format(parsedBase);
};

internals.Client.prototype.request = function (method, url, options, callback, _trace) {
    var _this = this;

    options = Hoek.applyToDefaultsWithShallow(this._defaults, options || {}, internals.shallowOptions);

    Hoek.assert(options.payload === undefined || typeof options.payload === 'string' || _typeof(options.payload) === 'object', 'options.payload must be a string, a Buffer, a Stream, or an Object');

    Hoek.assert(options.agent === undefined || options.agent === null || typeof options.rejectUnauthorized !== 'boolean', 'options.agent cannot be set to an Agent at the same time as options.rejectUnauthorized is set');

    Hoek.assert(options.beforeRedirect === undefined || options.beforeRedirect === null || typeof options.beforeRedirect === 'function', 'options.beforeRedirect must be a function');

    Hoek.assert(options.redirected === undefined || options.redirected === null || typeof options.redirected === 'function', 'options.redirected must be a function');

    options.beforeRedirect = options.beforeRedirect || function (redirectMethod, statusCode, location, resHeaders, redirectOptions, next) {
        return next();
    };

    if (options.baseUrl) {
        url = internals.resolveUrl(options.baseUrl, url);
        delete options.baseUrl;
    }

    var uri = Url.parse(url);

    if (options.socketPath) {
        uri.socketPath = options.socketPath;
        delete options.socketPath;
    }

    uri.method = method.toUpperCase();
    uri.headers = options.headers || {};
    var hasContentLength = internals.findHeader('content-length', uri.headers) !== undefined;

    if (options.payload && _typeof(options.payload) === 'object' && !(options.payload instanceof Stream) && !Buffer.isBuffer(options.payload)) {
        options.payload = JSON.stringify(options.payload);
        if (!internals.findHeader('content-type', uri.headers)) {
            uri.headers['content-type'] = 'application/json';
        }
    }

    var payloadSupported = uri.method !== 'GET' && uri.method !== 'HEAD' && options.payload !== null && options.payload !== undefined;
    if (payloadSupported && (typeof options.payload === 'string' || Buffer.isBuffer(options.payload)) && !hasContentLength) {

        uri.headers = Hoek.clone(uri.headers);
        uri.headers['content-length'] = Buffer.isBuffer(options.payload) ? options.payload.length : Buffer.byteLength(options.payload);
    }

    var redirects = options.hasOwnProperty('redirects') ? options.redirects : false; // Needed to allow 0 as valid value when passed recursively

    _trace = _trace || [];
    _trace.push({ method: uri.method, url: url });

    var client = uri.protocol === 'https:' ? Https : Http;

    if (options.rejectUnauthorized !== undefined && uri.protocol === 'https:') {
        uri.agent = options.rejectUnauthorized ? this.agents.https : this.agents.httpsAllowUnauthorized;
    } else if (options.agent || options.agent === false) {
        uri.agent = options.agent;
    } else {
        uri.agent = uri.protocol === 'https:' ? this.agents.https : this.agents.http;
    }

    if (options.secureProtocol !== undefined) {
        uri.secureProtocol = options.secureProtocol;
    }

    this.emit('request', uri, options);

    var start = Date.now();
    var req = client.request(uri);

    var shadow = null; // A copy of the streamed request payload when redirects are enabled
    var timeoutId = void 0;

    var onError = function onError(err) {

        err.trace = _trace;
        return finishOnce(Boom.badGateway('Client request error', err));
    };
    req.once('error', onError);

    var onResponse = function onResponse(res) {

        // Pass-through response

        var statusCode = res.statusCode;
        var redirectMethod = internals.redirectMethod(statusCode, uri.method, options);

        if (redirects === false || !redirectMethod) {

            return finishOnce(null, res);
        }

        // Redirection

        res.destroy();

        if (redirects === 0) {
            return finishOnce(Boom.badGateway('Maximum redirections reached', _trace));
        }

        var location = res.headers.location;
        if (!location) {
            return finishOnce(Boom.badGateway('Received redirection without location', _trace));
        }

        if (!/^https?:/i.test(location)) {
            location = Url.resolve(uri.href, location);
        }

        var redirectOptions = Hoek.cloneWithShallow(options, internals.shallowOptions);
        redirectOptions.payload = shadow || options.payload; // shadow must be ready at this point if set
        redirectOptions.redirects = --redirects;

        return options.beforeRedirect(redirectMethod, statusCode, location, res.headers, redirectOptions, function () {

            var redirectReq = _this.request(redirectMethod, location, redirectOptions, finishOnce, _trace);

            if (options.redirected) {
                options.redirected(statusCode, location, redirectReq);
            }
        });
    };

    // Register handlers

    var finish = function finish(err, res) {

        if (err) {
            req.abort();
        }

        req.removeListener('response', onResponse);
        req.removeListener('error', onError);
        req.on('error', Hoek.ignore);
        clearTimeout(timeoutId);
        _this.emit('response', err, { req: req, res: res, start: start, uri: uri });

        if (callback) {
            return callback(err, res);
        }
    };

    var finishOnce = Hoek.once(finish);

    req.once('response', onResponse);

    if (options.timeout) {
        timeoutId = setTimeout(function () {

            return finishOnce(Boom.gatewayTimeout('Client request timeout'));
        }, options.timeout);
        delete options.timeout;
    }

    // Custom abort method to detect early aborts

    var _abort = req.abort;
    var aborted = false;
    req.abort = function () {

        if (!aborted && !req.res && !req.socket) {
            process.nextTick(function () {

                // Fake an ECONNRESET error

                var error = new Error('socket hang up');
                error.code = 'ECONNRESET';
                finishOnce(error);
            });
        }

        aborted = true;
        return _abort.call(req);
    };

    // Write payload

    if (payloadSupported) {
        if (options.payload instanceof Stream) {
            var stream = options.payload;

            if (redirects) {
                var collector = new Tap();
                collector.once('finish', function () {

                    shadow = collector.collect();
                });

                stream = options.payload.pipe(collector);
            }

            stream.pipe(req);
            return req;
        }

        req.write(options.payload);
    }

    // Finalize request

    req.end();

    return req;
};

internals.redirectMethod = function (code, method, options) {

    switch (code) {
        case 301:
        case 302:
            return method;

        case 303:
            if (options.redirect303) {
                return 'GET';
            }
            break;

        case 307:
        case 308:
            return method;
    }

    return null;
};

// read()

internals.Client.prototype.read = function (res, options, callback) {

    options = Hoek.applyToDefaultsWithShallow(this._defaults, options || {}, internals.shallowOptions);

    // Set stream timeout

    var clientTimeout = options.timeout;
    var clientTimeoutId = null;

    // Finish once

    var finish = function finish(err, buffer) {

        clearTimeout(clientTimeoutId);
        reader.removeListener('error', onReaderError);
        reader.removeListener('finish', onReaderFinish);
        res.removeListener('error', onResError);
        res.removeListener('close', onResClose);
        res.on('error', Hoek.ignore);

        if (err || !options.json) {

            return callback(err, buffer);
        }

        // Parse JSON

        var result = void 0;
        if (buffer.length === 0) {
            return callback(null, null);
        }

        if (options.json === 'force') {
            result = internals.tryParseBuffer(buffer);
            return callback(result.err, result.json);
        }

        // mode is "smart", "strict" or true

        var contentType = res.headers && internals.findHeader('content-type', res.headers) || '';
        var mime = contentType.split(';')[0].trim().toLowerCase();

        if (!internals.jsonRegex.test(mime)) {
            if (options.json === 'strict') {
                return callback(Boom.notAcceptable('The content-type is not JSON compatible'));
            }
            return callback(null, buffer);
        }

        result = internals.tryParseBuffer(buffer);
        return callback(result.err, result.json);
    };

    var finishOnce = Hoek.once(finish);

    if (clientTimeout && clientTimeout > 0) {

        clientTimeoutId = setTimeout(function () {

            finishOnce(Boom.clientTimeout());
        }, clientTimeout);
    }

    // Hander errors

    var onResError = function onResError(err) {

        return finishOnce(Boom.internal('Payload stream error', err));
    };

    var onResClose = function onResClose() {

        return finishOnce(Boom.internal('Payload stream closed prematurely'));
    };

    res.once('error', onResError);
    res.once('close', onResClose);

    // Read payload

    var reader = new Recorder({ maxBytes: options.maxBytes });

    var onReaderError = function onReaderError(err) {

        if (res.destroy) {
            // GZip stream has no destroy() method
            res.destroy();
        }

        return finishOnce(err);
    };

    reader.once('error', onReaderError);

    var onReaderFinish = function onReaderFinish() {

        return finishOnce(null, reader.collect());
    };

    reader.once('finish', onReaderFinish);

    res.pipe(reader);
};

// toReadableStream()

internals.Client.prototype.toReadableStream = function (payload, encoding) {

    return new Payload(payload, encoding);
};

// parseCacheControl()

internals.Client.prototype.parseCacheControl = function (field) {

    /*
        Cache-Control   = 1#cache-directive
        cache-directive = token [ "=" ( token / quoted-string ) ]
        token           = [^\x00-\x20\(\)<>@\,;\:\\"\/\[\]\?\=\{\}\x7F]+
        quoted-string   = "(?:[^"\\]|\\.)*"
    */

    //                             1: directive                                        =   2: token                                              3: quoted-string
    var regex = /(?:^|(?:\s*\,\s*))([^\x00-\x20\(\)<>@\,;\:\\"\/\[\]\?\=\{\}\x7F]+)(?:\=(?:([^\x00-\x20\(\)<>@\,;\:\\"\/\[\]\?\=\{\}\x7F]+)|(?:\"((?:[^"\\]|\\.)*)\")))?/g;

    var header = {};
    var error = field.replace(regex, function ($0, $1, $2, $3) {

        var value = $2 || $3;
        header[$1] = value ? value.toLowerCase() : true;
        return '';
    });

    if (header['max-age']) {
        try {
            var maxAge = parseInt(header['max-age'], 10);
            if (isNaN(maxAge)) {
                return null;
            }

            header['max-age'] = maxAge;
        } catch (err) {}
    }

    return error ? null : header;
};

// Shortcuts

internals.Client.prototype.get = function (uri, options, callback) {

    return this._shortcutWrap('GET', uri, options, callback);
};

internals.Client.prototype.post = function (uri, options, callback) {

    return this._shortcutWrap('POST', uri, options, callback);
};

internals.Client.prototype.patch = function (uri, options, callback) {

    return this._shortcutWrap('PATCH', uri, options, callback);
};

internals.Client.prototype.put = function (uri, options, callback) {

    return this._shortcutWrap('PUT', uri, options, callback);
};

internals.Client.prototype.delete = function (uri, options, callback) {

    return this._shortcutWrap('DELETE', uri, options, callback);
};

// Wrapper so that shortcut can be optimized with required params

internals.Client.prototype._shortcutWrap = function (method, uri /* [options], callback */) {

    var options = typeof arguments[2] === 'function' ? {} : arguments[2];
    var callback = typeof arguments[2] === 'function' ? arguments[2] : arguments[3];

    return this._shortcut(method, uri, options, callback);
};

internals.Client.prototype._shortcut = function (method, uri, options, callback) {
    var _this2 = this;

    return this.request(method, uri, options, function (err, res) {

        if (err) {
            return callback(err);
        }

        _this2.read(res, options, function (err, payload) {

            if (!err && res.statusCode >= 400) {
                return callback(Boom.create(res.statusCode, new Error('Response Error: ' + res.statusCode + ' ' + res.statusMessage), {
                    isResponseError: true,
                    headers: res.headers,
                    response: res,
                    payload: payload
                }));
            }

            return callback(err, res, payload);
        });
    });
};

internals.tryParseBuffer = function (buffer) {

    var result = {
        json: null,
        err: null
    };
    try {
        var json = JSON.parse(buffer.toString());
        result.json = json;
    } catch (err) {
        result.err = err;
    }
    return result;
};

internals.findHeader = function (headerName, headers) {

    var foundKey = Object.keys(headers).find(function (key) {
        return key.toLowerCase() === headerName.toLowerCase();
    });

    return foundKey && headers[foundKey];
};

module.exports = new internals.Client();
