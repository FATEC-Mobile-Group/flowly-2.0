const express = require("express");
const router = express.Router();
const Usuario = require("../models/User.js");
const Equipe = require("../models/Equipe.js");
const Tarefa = require("../models/Tarefa.js");
const verificarToken = require('../middlewares/auth.js');
const { isAdmin } = require('../middlewares/roles.js');
const {
  ingestAssistantInsight,
  getAssistantInsights,
} = require('../controllers/assistantInsightController.js');

// [GET] /api/admin/metricas
router.get("/metricas", verificarToken, isAdmin, async (req, res) => {
  try {
    const totalEquipes = await Equipe.countDocuments();
    const totalUsers = await Usuario.countDocuments({ tipo: "user" });
    const totalTarefas = await Tarefa.countDocuments();

    const statusCounts = await Tarefa.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const porStatus = {
      pendente: 0,
      "em andamento": 0,
      concluu00eddo: 0,
    };

    statusCounts.forEach((s) => {
      porStatus[s._id] = s.count;
    });

    res.json({ totalEquipes, totalUsers, totalTarefas, porStatus });
  } catch (err) {
    res.status(500).json({ mensagem: "Erro ao carregar métricas" });
  }
});

// [POST] /api/admin/assistant-insights/ingest
// Rota interna usada pelo agente de voz/PLN para persistir analytics no MongoDB da aplicação.
router.post("/assistant-insights/ingest", ingestAssistantInsight);

// [GET] /api/admin/assistant-insights
// Rota protegida para administradores consumirem os agregados de PLN.
router.get("/assistant-insights", verificarToken, isAdmin, getAssistantInsights);

module.exports = router;
