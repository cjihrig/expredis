'use strict';
const Debug = require('debug')('expredis');
const Redis = require('redis');

const ONE_DAY = 86400; // One day in seconds.
const defaults = {
  prefix: 'session',
  serializer: JSON,
  ttl: null
};


function expredis (session) {
  const Store = session.Store;

  class RedisStore extends Store {
    constructor (options) {
      options = Object.assign({}, defaults, options);
      super(options);

      this.serializer = options.serializer;
      this.clients = options.clients.map((inputOptions) => {
        const opts = Object.assign({}, inputOptions, {
          enable_offline_queue: false,
          prefix: options.prefix
        });
        const client = Redis.createClient(opts);

        if (options.unref === true) {
          client.unref();
        }

        client.on('error', (err) => {
          err.client = client;
          Debug('client error', err);
          process.nextTick(() => {
            this.emit('error', err);
          });
        });

        client.on('connect', () => {
          this.emit('connect', client);
        });

        client.on('ready', () => {
          this.emit('ready', client);
        });

        return client;
      });

      if (options.ttl === null || options.ttl === false ||
          Number.isInteger(options.ttl)) {
        this.ttl = options.ttl;
      } else {
        throw new TypeError('ttl must be an integer or false');
      }
    }

    close () {
      Debug('close');
      this.clients.forEach((client) => { client.quit(); });
    }

    get (sid, callback) {
      const state = {
        store: this,
        remaining: this.clients.length,
        error: null,
        callback
      };
      const cb = firstWithData.bind(state);

      Debug('get "%s", state=%o', sid, state);

      for (let i = 0; i < this.clients.length; ++i) {
        this.clients[i].get(sid, cb);
      }
    }

    set (sid, session, callback) {
      let sess;

      try {
        sess = this.serializer.stringify(session);
      } catch (err) {
        Debug('set "%s", failed stringify, err=%o', sid, err);
        return callback(err);
      }

      const state = {
        remaining: this.clients.length,
        succeeded: 0,
        failed: 0,
        error: null,
        callback
      };
      const cb = waitForAll.bind(state);
      const args = [sid, sess];
      const ttl = getTTL(this, session);

      if (ttl !== false) {
        args.push('EX', ttl);
      }

      Debug('set "%s", session=%o, state=%o, ttl=%s', sid, session, state, ttl);

      for (let i = 0; i < this.clients.length; ++i) {
        this.clients[i].set(args, cb);
      }
    }

    destroy (sid, callback) {
      const state = {
        remaining: this.clients.length,
        succeeded: 0,
        failed: 0,
        error: null,
        callback
      };
      const cb = waitForAll.bind(state);

      Debug('destroy "%s", state=%o', sid, state);

      for (let i = 0; i < this.clients.length; ++i) {
        this.clients[i].del(sid, cb);
      }
    }

    length (callback) {
      const state = {
        result: new Set(),
        remaining: this.clients.length,
        succeeded: 0,
        failed: 0,
        error: null,
        callback
      };
      const cb = allKeys.bind(state);

      Debug('length, state=%o', state);

      for (let i = 0; i < this.clients.length; ++i) {
        this.clients[i].keys('*', cb);
      }
    }

    clear (callback) {
      const state = {
        remaining: this.clients.length,
        succeeded: 0,
        failed: 0,
        error: null,
        callback
      };
      const cb = waitForAll.bind(state);

      Debug('clear, state=%o', state);

      for (let i = 0; i < this.clients.length; ++i) {
        this.clients[i].flushdb(cb);
      }
    }

    touch (sid, session, callback) {
      const ttl = getTTL(this, session);

      if (ttl === false) {
        Debug('touch, ttl is disabled');
        return callback(null);
      }

      const state = {
        remaining: this.clients.length,
        succeeded: 0,
        failed: 0,
        error: null,
        callback
      };
      const cb = waitForAll.bind(state);

      Debug('touch, ttl=%s, state=%o', ttl, state);

      for (let i = 0; i < this.clients.length; ++i) {
        this.clients[i].expire(sid, ttl, cb);
      }
    }
  }

  return RedisStore;
}

module.exports = expredis;


function firstWithData (err, data) {
  if (this.remaining === 0) {
    return;
  }

  if (err) {
    this.error = err;
  } else if (data !== null) {
    this.remaining = 0;

    try {
      data = this.store.serializer.parse(data);
    } catch (err) {
      Debug('firstWithData parse failure, state=%o, data=%o, err=%o',
        this, data, err);
      return this.callback(err, null);
    }

    Debug('firstWithData success, state=%o, data=%o', this, data);
    return this.callback(null, data);
  }

  this.remaining--;

  if (this.remaining === 0) {
    Debug('firstWithData failure, state=%o, data=%o', this, null);
    this.callback(this.error, null);
  }
}


function allKeys (err, keys) {
  this.remaining--;

  if (err) {
    this.failed++;
    this.error = err;
  } else {
    this.succeeded++;

    for (let i = 0; i < keys.length; ++i) {
      this.result.add(keys[i]);
    }
  }

  if (this.remaining === 0) {
    if (this.succeeded > 0) {
      Debug('allKeys success, state=%o', this);
      return this.callback(null, this.result.size);
    }

    // error could be null, meaning that there were no clients connected.
    Debug('allKeys failure, state=%o', this);
    this.callback(this.error, 0);
  }
}


function waitForAll (err) {
  if (err) {
    this.error = err;
    this.failed++;
  } else {
    this.succeeded++;
  }

  this.remaining--;

  if (this.remaining === 0) {
    Debug('waitForAll state=%o', this);
    this.callback(this.error);
  }
}


function getTTL (store, session) {
  if (store.ttl !== null) {
    return store.ttl;
  }

  const maxAge = session.cookie && session.cookie.maxAge;

  if (typeof maxAge === 'number') {
    return Math.floor(maxAge / 1000);
  }

  return ONE_DAY;
}
