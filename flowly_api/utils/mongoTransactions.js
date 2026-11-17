const mongoose = require('mongoose');

// Transacoes so existem em replica set ou cluster fragmentado (o Atlas e replica set).
// Um MongoDB standalone, como o mongo:5 do k8s local, nao suporta.
let cachedSupport;

const supportsTransactions = async (connection = mongoose.connection) => {
  if (cachedSupport !== undefined) {
    return cachedSupport;
  }

  const db = connection?.db;
  if (!db) {
    return false;
  }

  try {
    const hello = await db.admin().command({ hello: 1 });
    cachedSupport = Boolean(hello?.setName) || hello?.msg === 'isdbgrid';
  } catch (_err) {
    return false;
  }
  return cachedSupport;
};

// Tudo o que work gravar com { session } entra ou sai junto. Erro dentro de work aborta e e relancado.
const runInTransaction = async (work, connection = mongoose) => {
  const session = await connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const resetTransactionSupportCache = () => {
  cachedSupport = undefined;
};

module.exports = {
  resetTransactionSupportCache,
  runInTransaction,
  supportsTransactions,
};
