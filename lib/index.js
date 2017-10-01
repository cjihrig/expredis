'use strict';
const Debug = require('debug')('expredis');
const Redis = require('redis');

const defaults = { prefix: 'session', scanCount: 100, serializer: JSON };


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
      // TODO: Handle TTL case.
      const args = [sid, sess];

      Debug('set "%s", session=%o, state=%o', sid, session, state);

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

    /*  TODO: Session middleware APIs not yet implemented
    all (callback) {
      // callback(err, sessions)
    }

    clear (callback) {
      // callback(err)
    }

    length (callback) {
      // callback(err, len)
    }

    touch (sid, session, callback) {
      // callback(err)
    }
    */
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
