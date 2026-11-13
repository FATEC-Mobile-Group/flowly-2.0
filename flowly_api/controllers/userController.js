const argon2 = require('argon2');
const User = require('../models/User');
const upload = require('../middlewares/upload');
const path = require('path');
const bucket = require('../services/storage');
const { getSignedUrl } = require('../services/storage');
const validatePassword = require('../utils/validatePassword');

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const assinarFotoPerfil = async (user) => {
  const userObject = typeof user.toObject === 'function' ? user.toObject() : user;

  return {
    ...userObject,
    fotoPerfil: await getSignedUrl(userObject.fotoPerfil),
  };
};

exports.listarUsers = async (req, res) => {
  try {
    const users = await User.find().select('nome email tipo fotoPerfil');
    res.json(await Promise.all(users.map(assinarFotoPerfil)));
  } catch (error) {
    console.error('Erro ao buscar usuarios:', error);
    res.status(500).json({ error: 'Erro ao buscar usuarios' });
  }
};

exports.searchUsers = async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length === 0) {
      return res.json([]);
    }

    const searchQuery = q.trim().slice(0, 100);
    const escapedSearchQuery = escapeRegex(searchQuery);
    const users = await User.find({
      tipo: { $in: ['admin', 'user'] },
      $or: [
        { nome: { $regex: escapedSearchQuery, $options: 'i' } },
        { email: { $regex: escapedSearchQuery, $options: 'i' } },
      ],
    })
      .select('_id nome email fotoPerfil tipo')
      .limit(10);

    res.json(await Promise.all(users.map(assinarFotoPerfil)));
  } catch (error) {
    console.error('Erro ao buscar usuarios:', error);
    res.status(500).json({ error: 'Erro ao buscar usuarios' });
  }
};

exports.me = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      'nome email tipo fotoPerfil faceEnrollmentOffered faceEnrollmentSkipped'
    );

    if (!user) {
      return res.status(404).json({ erro: 'Usuario nao encontrado' });
    }

    res.json(await assinarFotoPerfil(user));
  } catch (error) {
    console.error('Erro ao buscar perfil:', error);
    res.status(500).json({ erro: 'Erro ao buscar perfil' });
  }
};

exports.atualizarPerfil = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ erro: 'Usuario nao encontrado' });
    }

    if (typeof req.body.nome === 'string' && req.body.nome.trim()) {
      user.nome = req.body.nome.trim();
    }

    // Se arquivo foi fornecido, fazer upload
    // A validação de tipo e tamanho já foi feita pela middleware
    if (req.file) {
      try {
        // Upload para Cloud Storage
        const filePath = await uploadFotoParaGCS(req.file, user._id.toString());
        user.fotoPerfil = filePath;
      } catch (uploadError) {
        console.error('Erro ao fazer upload para Google Cloud Storage:', uploadError);
        
        // Diferenciar tipos de erro
        if (uploadError.message.includes('timeout') || uploadError.code === 'ETIMEDOUT') {
          return res.status(504).json({ erro: 'Timeout ao conectar com Cloud Storage' });
        }
        if (uploadError.message.includes('auth') || uploadError.code === 403) {
          return res.status(500).json({ erro: 'Erro de autenticação com Cloud Storage' });
        }
        if (uploadError.message.includes('quota') || uploadError.code === 429) {
          return res.status(429).json({ erro: 'Limite de armazenamento atingido' });
        }
        
        return res.status(500).json({ erro: 'Erro ao fazer upload da foto de perfil' });
      }
    }

    // Salvar usuário apenas após sucesso do upload (se houver)
    await user.save();

    res.json({
      msg: 'Perfil atualizado com sucesso',
      user: {
        id: user._id,
        nome: user.nome,
        email: user.email,
        tipo: user.tipo,
        fotoPerfil: await getSignedUrl(user.fotoPerfil),
      },
    });
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.status(500).json({ erro: 'Erro ao atualizar perfil' });
  }
};

/**
 * Função auxiliar para upload de foto usando bucket.file().save()
 * Armazena em: fotos/{userId}/{timestamp}-{random}.{ext}
 * @param {Object} file - Objeto do arquivo (req.file)
 * @param {string} userId - ID do usuário
 * @returns {Promise<string>} URL pública do arquivo
 */
const uploadFotoParaGCS = async (file, userId) => {
  try {
    const uniqueName =
      Date.now() +
      '-' +
      Math.round(Math.random() * 1e9) +
      path.extname(file.originalname);

    // Organizar em pasta: fotos/{userId}/{arquivo}
    const filePath = `fotos/${userId}/${uniqueName}`;
    const blob = bucket.file(filePath);

    // Usar save() em vez de createWriteStream() para evitar race conditions
    await blob.save(file.buffer, {
      metadata: {
        contentType: file.mimetype,
        cacheControl: 'public, max-age=31536000'
      },
      timeout: 60000 // 60 segundos de timeout
    });

    console.log('✅ Upload de foto concluído em:', filePath);
    return filePath;
  } catch (error) {
    console.error('❌ Erro ao fazer upload:', error.message);
    throw error;
  }
};

exports.atualizarSenha = async (req, res) => {
  try {
    const { senhaAtual, novaSenha } = req.body;

    if (typeof senhaAtual !== 'string' || !senhaAtual || novaSenha === undefined) {
      return res.status(400).json({ erro: 'Senha atual e nova senha sao obrigatorias' });
    }

    const passwordValidationResult = validatePassword(novaSenha);
    if (passwordValidationResult !== true) {
      return res.status(400).json({ erro: passwordValidationResult });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ erro: 'Usuario nao encontrado' });
    }

    const senhaValida = await argon2.verify(user.senha, senhaAtual);

    if (!senhaValida) {
      return res.status(400).json({ erro: 'Senha atual invalida' });
    }

    user.senha = await argon2.hash(novaSenha);
    await user.save();

    res.json({ msg: 'Senha atualizada com sucesso' });
  } catch (error) {
    console.error('Erro ao atualizar senha:', error);
    res.status(500).json({ erro: 'Erro ao atualizar senha' });
  }
};
