const app = require('./app');
const http = require('http');
const mongoose = require('mongoose');
const config = require('./config/config');
const setupSocketInteractions = require('./socket_handler');

const configurationWarnings = config.validateRuntime();
configurationWarnings.forEach((warning) => {
  console.warn(`[config] ${warning}`);
});

const server = http.createServer(app);
setupSocketInteractions(server);

const startServer = async () => {
  try {
    // Conectar ao MongoDB
    await mongoose.connect(config.mongodb.uri);
    console.log('✓ MongoDB conectado com sucesso');

    // Iniciar servidor HTTP/WS
    server.listen(config.port, () => {
      console.log(`✓ Servidor rodando em http://localhost:${config.port}`);
      console.log(`✓ Ambiente: ${config.env}`);
    });
  } catch (err) {
    console.error('✗ Erro ao conectar ao servidor:', err.message);
    process.exit(1);
  }
};

startServer();
