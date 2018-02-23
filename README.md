# expredis

[![Current Version](https://img.shields.io/npm/v/expredis.svg)](https://www.npmjs.org/package/expredis)
[![Build Status via Travis CI](https://travis-ci.org/continuationlabs/expredis.svg?branch=master)](https://travis-ci.org/continuationlabs/expredis)
![Dependencies](http://img.shields.io/david/continuationlabs/expredis.svg)
[![belly-button-style](https://img.shields.io/badge/eslint-bellybutton-4B32C3.svg)](https://github.com/continuationlabs/belly-button)


Express session store for use with redundant Redis instances. All operations are performed simultaneously on an arbitrary number of independent Redis instances. When retrieving data, the result is taken from the first Redis instance to respond.

Expredis implements the [Express Session Store API](https://github.com/expressjs/session#session-store-implementation), with the exception of the `store.all(callback)` method.

## Basic Usage

Expredis exports a single function, which accepts the [`express-session`](https://www.npmjs.com/package/express-session) module as it's only argument. The result is a Redis store that can be passed to Express session middleware.

```javascript
'use strict';
const Expredis = require('expredis');
const Express = require('express');
const ExpressSession = require('express-session');
const RedisStore = Expredis(ExpressSession);
const app = new Express();

app.use(ExpressSession({
  name: 'session',
  secret: 'foobar',
  resave: true,
  saveUninitialized: false,
  cookie: { secure: true, maxAge: 5000 },
  store: new RedisStore({
    clients: [
      { port: 6379 },
      { port: 6380 }
    ]
  })
}));

app.get('/setter', (req, res, next) => {
  req.session.firstName = 'Peter';
  req.session.lastName = 'Pluck';
  res.send({ operation: 'set' });
});

app.get('/getter', (req, res, next) => {
  const { firstName, lastName } = req.session;
  res.send({ firstName, lastName });
});
```

## API

This section describes the options that can be passed to the `RedisStore` constructor.

- `serializer` (Object) - An object that is API compatible with the built-in `JSON` object. This is used to parse and stringify data as it is read from and written to Redis. Defaults to `JSON`.
- `prefix` (String) - A string that is prepended to keys stored in Redis. This prevents collisions with data unrelated to the session storage. Defaults to `'session'`.
- `unref` (Boolean) - When `true`, Redis clients are unref'ed. Defaults to `false`.
- `ttl` (`false` or Integer) - Defines the TTL for data written to Redis. If `ttl` is `false`, then no TTL is used, and data must be evicted in some other manner. If `ttl` is an integer, then it is used as the TTL value in seconds. If a value is not provided, then Expredis will try to use the session cookie's `maxAge` value. If a `maxAge` is not available, a default value of one day is used.
- `clients` (Array of Objects) - Each array element is a configuration object used to instantiate a Redis client. See the [`redis` module's documentation](https://github.com/NodeRedis/node_redis) for more details. Note that the `enable_offline_queue` option is unconditionally set to `false`.

## Events

`RedisStore` extends Node's `EventEmitter`. As such, it emits several events, which are documented here.

- `error` - Emitted when an error occurs on one of the Redis clients. The handler takes an `Error` object as the only argument. The client that generated the error is attached to the `Error` object via the `client` property.
- `connect` - Emitted each time one of the Redis clients successfully connects. The client that connected is passed to the handler as the only argument.
- `ready` - Emitted each time one of the Redis clients emits its own `ready` event. The client that became ready is passed to the handler as the only argument.
