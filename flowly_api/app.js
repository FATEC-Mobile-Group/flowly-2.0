const express = require('express');
const cors = require('cors');
const config = require('./config/config');
const errorHandler = require('./middlewares/errorHandler');
const { HTTP_STATUS, ERROR_MESSAGES } = require('./config/constants');

// Routes
const authRoutes = require('./routes/authRoutes');
const equipeRoutes = require('./routes/equipesRoutes');
const tarefaRoutes = require('./routes/tarefaRoutes');
const adminRoutes = require('./routes/adminRoutes');
const userRoutes = require('./routes/userRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const storageRoutes = require('./routes/storageRoutes');
const faceRoutes = require('./routes/faceRoutes');

const app = express();

const allowedOrigins = config.corsOrigin
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origem nao permitida pelo CORS.'));
  },
};

// Middleware
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(cors(corsOptions));
app.use(express.json({ limit: config.bodySizeLimit }));
app.use(express.urlencoded({ extended: true, limit: config.bodySizeLimit }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/equipes', equipeRoutes);
app.use('/api/tarefas', tarefaRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notificacoes', notificationRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/face', faceRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json({
    success: false,
    error: ERROR_MESSAGES.ROUTE_NOT_FOUND,
  });
});

// Error Handler (deve ser o último middleware)
app.use(errorHandler);

module.exports = app;
