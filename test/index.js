'use strict';
const Artificial = require('artificial');
const Express = require('express');
const ExpressSession = require('express-session');
const Lab = require('lab');
const Reach = require('reach');
const Redis = require('redis');
const StandIn = require('stand-in');
const ThinMint = require('thin-mint');
const Expredis = require('../lib');
const RedisStore = Expredis(ExpressSession);

const lab = exports.lab = Lab.script();
const { describe, it } = lab;
const expect = Lab.expect;


function createStore (options) {
  const settings = Object.assign({}, options, {
    clients: [
      { port: 6379 },
      { port: 6380 }
    ]
  });

  return new RedisStore(settings);
}


function waitForAllReady (store, callback) {
  let remaining = store.clients.length;

  store.on('ready', () => {
    remaining--;

    if (remaining === 0) {
      callback();
    }
  });
}


describe('Expredis', () => {
  it('emits connect and ready events', (done) => {
    const store = new RedisStore({ clients: [{ port: 6379 }] });
    let connectCalled = false;

    function connectHandler (client) {
      expect(client).to.exist();
      connectCalled = true;
    }

    function readyHandler (client) {
      expect(connectCalled).to.be.true();
      expect(client).to.exist();
      done();
    }

    store.on('connect', connectHandler);
    store.on('ready', readyHandler);
  });

  it('emits error events', (done) => {
    const store = new RedisStore({ clients: [{ port: 9999 }] });

    store.on('error', (err) => {
      expect(err).to.exist();
      expect(err.code).to.equal('ECONNREFUSED');
      expect(err.errno).to.equal(err.code);
      expect(err.syscall).to.equal('connect');
      expect(err.port).to.equal(9999);
      expect(err.client).to.exist();
      done();
    });
  });

  it('sets data', (done) => {
    const store = createStore();

    waitForAllReady(store, () => {
      store.set('foo', { bar: 'baz' }, (err) => {
        expect(err).to.not.exist();
        done();
      });
    });
  });

  it('errors when data cannot be serialized', (done) => {
    const store = createStore();
    const circular = {};

    circular.self = circular;
    waitForAllReady(store, () => {
      store.set('foo', circular, (err) => {
        expect(err).to.be.an.error(Error, 'Converting circular structure to JSON');
        done();
      });
    });
  });

  it('fails to write data if the store is not ready', (done) => {
    const store = createStore();

    store.set('foo', { bar: 'baz' }, (err) => {
      expect(err).to.exist();
      expect(err.message).to.equal('SET can\'t be processed. The connection is not yet established and the offline queue is deactivated.');
      done();
    });
  });

  it('gets data that has been written', (done) => {
    const store = createStore();
    const input = { bar: 'baz' };

    waitForAllReady(store, () => {
      store.set('foo', input, (err) => {
        expect(err).to.not.exist();
        store.get('foo', (err, data) => {
          expect(err).to.not.exist();
          expect(data).to.equal(input);
          done();
        });
      });
    });
  });

  it('returns null if the data does not exist', (done) => {
    const store = createStore();

    waitForAllReady(store, () => {
      store.get('this key does not exist', (err, data) => {
        expect(err).to.not.exist();
        expect(data).to.equal(null);
        done();
      });
    });
  });

  it('errors when retrieved data cannot be parsed', (done) => {
    const store = createStore({
      serializer: {
        stringify: JSON.stringify,
        parse () {
          throw new Error('mock');
        }
      }
    });

    waitForAllReady(store, () => {
      store.set('foo', { bar: 'baz' }, (err) => {
        expect(err).to.not.exist();
        store.get('foo', (err, data) => {
          expect(err).to.be.an.error(Error, 'mock');
          expect(data).to.not.exist();
          done();
        });
      });
    });
  });

  it('destroys existing data', (done) => {
    const store = createStore();
    const input = { bar: 'baz' };

    waitForAllReady(store, () => {
      store.set('foo', input, (err) => {
        expect(err).to.not.exist();
        store.get('foo', (err, data) => {
          expect(err).to.not.exist();
          expect(data).to.equal(input);
          store.destroy('foo', (err) => {
            expect(err).to.not.exist();
            store.get('foo', (err, data) => {
              expect(err).to.not.exist();
              expect(data).to.equal(null);
              done();
            });
          });
        });
      });
    });
  });

  it('closes connection', (done) => {
    const store = createStore();

    waitForAllReady(store, () => {
      store.close();
      store.get('foo', (err, data) => {
        expect(data).to.equal(null);
        expect(err.message).to.match(/The connection is already closed/);
        done();
      });
    });
  });

  it('unrefs connection', (done) => {
    let called = false;

    StandIn.replaceOnce(Redis.RedisClient.prototype, 'unref', (stand, value) => {
      called = true;
    });

    createStore({ unref: true });
    expect(called).to.equal(true);
    done();
  });

  it('works with express', (done) => {
    const app = new Express();
    const store = createStore();

    app.use(ExpressSession({
      name: 'session',
      secret: 'foobar',
      resave: true,
      saveUninitialized: false,
      cookie: { secure: false },
      store
    }));

    app.get('/foo', (req, res, next) => {
      req.session.firstName = 'Peter';
      req.session.lastName = 'Pluck';
      res.send({ operation: 'set' });
    });

    app.get('/bar', (req, res, next) => {
      const { firstName, lastName } = req.session;
      res.send({ firstName, lastName });
    });

    Artificial(app);

    waitForAllReady(store, () => {
      app.inject('/foo', (res) => {
        expect(res.statusCode).to.equal(200);
        expect(JSON.parse(res.payload)).to.equal({ operation: 'set' });

        const session = Reach(res, 'headers.set-cookie', { default: [] }).filter((cookie) => {
          return /session=.+/.test(cookie);
        }).map((cookie) => {
          return new ThinMint(cookie);
        }).pop();

        app.inject({
          method: 'GET',
          url: '/bar',
          headers: { cookie: session.toRequestCookie() }
        }, (res) => {
          expect(res.statusCode).to.equal(200);
          expect(JSON.parse(res.payload)).to.equal({ firstName: 'Peter', lastName: 'Pluck' });
          done();
        });
      });
    });
  });
});
