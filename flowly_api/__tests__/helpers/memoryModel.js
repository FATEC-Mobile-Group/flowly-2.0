// Modelo Mongoose simulado em memoria com o subconjunto de consultas usado pela recuperacao facial.
// Os filtros e updates sao interpretados de verdade, para que condicoes de consumo unico sejam testadas.
const mongoose = require('mongoose');

const same = (a, b) => a === b || (a != null && b != null && String(a) === String(b));
const isOperatorObject = (value) =>
  value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value) &&
  Object.keys(value).some((key) => key.startsWith('$'));

const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([key, condition]) => {
    const value = doc[key];
    if (!isOperatorObject(condition)) {
      return same(value, condition);
    }
    return Object.entries(condition).every(([operator, argument]) => {
      switch (operator) {
        case '$gt': return value != null && value > argument;
        case '$lt': return value != null && value < argument;
        case '$in': return argument.some((item) => same(item, value));
        case '$ne': return !same(value, argument);
        case '$exists': return (value !== undefined) === argument;
        default: throw new Error(`operador nao suportado no teste: ${operator}`);
      }
    });
  });

const applyUpdate = (doc, update) => {
  Object.assign(doc, update.$set || {});
  Object.keys(update.$unset || {}).forEach((key) => delete doc[key]);
  Object.entries(update.$inc || {}).forEach(([key, amount]) => {
    doc[key] = (Number(doc[key]) || 0) + amount;
  });
  Object.entries(update.$addToSet || {}).forEach(([key, value]) => {
    const list = Array.isArray(doc[key]) ? doc[key] : [];
    doc[key] = list.some((item) => same(item, value)) ? list : [...list, value];
  });
};

const query = (value) => {
  const promise = Promise.resolve(value);
  promise.select = () => promise;
  promise.lean = () => promise;
  return promise;
};

const newId = () => new mongoose.Types.ObjectId().toString();

const createMemoryModel = (db, collection) => {
  const rows = () => db[collection];
  const model = {
    sessionsSeen: [],
    track(options) {
      if (options?.session) {
        model.sessionsSeen.push(options.session);
      }
    },
  };

  Object.assign(model, {
    // Como o Mongoose: create(doc) devolve o documento; create([docs], { session }) devolve a lista.
    create: jest.fn(async (data, options) => {
      model.track(options);
      const insert = (item) => {
        const doc = { _id: newId(), ...item };
        rows().push(doc);
        return doc;
      };
      return Array.isArray(data) ? data.map(insert) : insert(data);
    }),
    findOne: jest.fn((filter) => query(rows().find((doc) => matches(doc, filter)) || null)),
    findById: jest.fn((id) => query(rows().find((doc) => same(doc._id, id)) || null)),
    find: jest.fn((filter) => query(rows().filter((doc) => matches(doc, filter)))),
    findOneAndUpdate: jest.fn(async (filter, update, options) => {
      model.track(options);
      const doc = rows().find((item) => matches(item, filter));
      if (!doc) {
        return null;
      }
      applyUpdate(doc, update);
      return doc;
    }),
    findOneAndDelete: jest.fn(async (filter, options) => {
      model.track(options);
      const index = rows().findIndex((item) => matches(item, filter));
      return index === -1 ? null : rows().splice(index, 1)[0];
    }),
    updateOne: jest.fn(async (filter, update, options) => {
      model.track(options);
      const doc = rows().find((item) => matches(item, filter));
      if (doc) {
        applyUpdate(doc, update);
      }
      return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
    }),
    updateMany: jest.fn(async (filter, update) => {
      const docs = rows().filter((item) => matches(item, filter));
      docs.forEach((doc) => applyUpdate(doc, update));
      return { matchedCount: docs.length, modifiedCount: docs.length };
    }),
    deleteOne: jest.fn(async (filter) => {
      const index = rows().findIndex((item) => matches(item, filter));
      if (index !== -1) {
        rows().splice(index, 1);
      }
      return { deletedCount: index === -1 ? 0 : 1 };
    }),
    deleteMany: jest.fn(async (filter) => {
      const before = rows().length;
      db[collection] = rows().filter((item) => !matches(item, filter));
      return { deletedCount: before - rows().length };
    }),
  });

  return model;
};

// Transacao simulada: copia o banco antes e restaura tudo se o trabalho falhar (como um abort).
// Uma transacao por vez, como o MongoDB faz com escritas conflitantes no mesmo documento.
const createMemoryTransactions = (db, collections, state) => {
  let queue = Promise.resolve();

  const runInTransaction = jest.fn((work) => {
    const run = async () => {
      const snapshot = Object.fromEntries(collections.map((name) => [name, structuredClone(db[name])]));
      const session = { id: (state.sessions = (state.sessions || 0) + 1) };
      try {
        return await work(session);
      } catch (err) {
        collections.forEach((name) => {
          db[name] = snapshot[name];
        });
        state.aborted = (state.aborted || 0) + 1;
        throw err;
      }
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  });

  return {
    supportsTransactions: jest.fn(async () => state.supported),
    runInTransaction,
  };
};

module.exports = { createMemoryModel, createMemoryTransactions, matches, newId };
