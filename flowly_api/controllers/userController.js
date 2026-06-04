const argon2 = require('argon2');
const User = require('../models/User');
const upload = require('../middlewares/upload');
const path = require('path');
const bucket = require('../services/storage');

exports.listarUsers = async (req, res) => {
  try {
    const users = await User.find().select('nome email tipo');
    res.json(users);
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

    const searchQuery = q.trim();
    const users = await User.find({
      tipo: { $in: ['admin', 'user'] },
      $or: [
        { nome: { $regex: searchQuery, $options: 'i' } },
        { email: { $regex: searchQuery, $options: 'i' } },
      ],
    })
      .select('_id nome email tipo')
      .limit(10);

    res.json(users);
  } catch (error) {
    console.error('Erro ao buscar usuarios:', error);
    res.status(500).json({ error: 'Erro ao buscar usuarios' });
  }
};

exports.me = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('nome email tipo fotoPerfil fotoPerfilObjectName');

    if (!user) {
      return res.status(404).json({ erro: 'Usuario nao encontrado' });
    }

    res.json({
      id: user._id,
      nome: user.nome,
      email: user.email,
      tipo: user.tipo,
      hasFotoPerfil: Boolean(user.fotoPerfilObjectName || user.fotoPerfil),
    });
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
    // A validaÃ§Ã£o de tipo e tamanho jÃ¡ foi feita pela middleware
    if (req.file) {
      try {
        // Upload privado para Cloud Storage
        const uploadedFile = await uploadFotoParaGCS(req.file, user._id.toString());
        user.fotoPerfil = '';
        user.fotoPerfilObjectName = uploadedFile.objectName;
        user.fotoPerfilMimetype = req.file.mimetype;
      } catch (uploadError) {
        console.error('Erro ao fazer upload para Google Cloud Storage:', uploadError);
        
        // Diferenciar tipos de erro
        if (uploadError.message.includes('timeout') || uploadError.code === 'ETIMEDOUT') {
          return res.status(504).json({ erro: 'Timeout ao conectar com Cloud Storage' });
        }
        if (uploadError.message.includes('auth') || uploadError.code === 403) {
          return res.status(500).json({ erro: 'Erro de autenticaÃ§Ã£o com Cloud Storage' });
        }
        if (uploadError.message.includes('quota') || uploadError.code === 429) {
          return res.status(429).json({ erro: 'Limite de armazenamento atingido' });
        }
        
        return res.status(500).json({ erro: 'Erro ao fazer upload da foto de perfil' });
      }
    }

    // Salvar usuÃ¡rio apenas apÃ³s sucesso do upload (se houver)
    await user.save();

    res.json({
      msg: 'Perfil atualizado com sucesso',
      user: {
        id: user._id,
        nome: user.nome,
        email: user.email,
        tipo: user.tipo,
        hasFotoPerfil: Boolean(user.fotoPerfilObjectName || user.fotoPerfil),
      },
    });
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.status(500).json({ erro: 'Erro ao atualizar perfil' });
  }
};

exports.obterUrlAssinadaFotoPerfil = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('fotoPerfil fotoPerfilObjectName fotoPerfilMimetype');

    if (!user) {
      return res.status(404).json({ erro: 'Usuario nao encontrado' });
    }

    const objectName = user.fotoPerfilObjectName || getObjectNameFromPublicUrl(user.fotoPerfil);
    if (!objectName) {
      return res.status(404).json({ erro: 'Foto de perfil nao encontrada' });
    }

    const signed = await bucket.getSignedReadUrl(objectName, {
      contentType: user.fotoPerfilMimetype || undefined,
    });

    res.json({
      url: signed.url,
      expiresAt: signed.expiresAt,
    });
  } catch (error) {
    console.error('Erro ao gerar URL assinada da foto de perfil:', error);
    res.status(500).json({ erro: 'Erro ao gerar URL assinada da foto de perfil' });
  }
};

/**
 * FunÃ§Ã£o auxiliar para upload de foto usando bucket.file().save()
 * Armazena em: fotos/{userId}/{timestamp}-{random}.{ext}
 * @param {Object} file - Objeto do arquivo (req.file)
 * @param {string} userId - ID do usuÃ¡rio
 * @returns {Promise<string>} URL pÃºblica do arquivo
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
    const uploadedFile = await bucket.uploadPrivateFile(filePath, file.buffer, {
      contentType: file.mimetype,
    });

    console.log('Upload de foto privado concluido em:', filePath);
    return uploadedFile;
  } catch (error) {
    console.error('Erro ao fazer upload:', error.message);
    throw error;
  }
};

const getObjectNameFromPublicUrl = (url = '') => {
  if (!url) return '';

  try {
    const parsedUrl = new URL(url);
    const publicHostPath = `/${bucket.name}/`;

    if (
      parsedUrl.hostname === 'storage.googleapis.com' &&
      parsedUrl.pathname.startsWith(publicHostPath)
    ) {
      return decodeURIComponent(parsedUrl.pathname.slice(publicHostPath.length));
    }
  } catch (error) {
    if (url.startsWith('fotos/')) {
      return url;
    }
  }

  return '';
};

exports.atualizarSenha = async (req, res) => {
  try {
    const { senhaAtual, novaSenha } = req.body;

    if (!senhaAtual || !novaSenha) {
      return res.status(400).json({ erro: 'Senha atual e nova senha sao obrigatorias' });
    }

    if (novaSenha.length < 6) {
      return res.status(400).json({ erro: 'Nova senha deve ter ao menos 6 caracteres' });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ erro: 'Usuario nao encontrado' });
    }

    const senhaValida = await argon2.verify(user.senha, senhaAtual);

    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha atual invalida' });
    }

    user.senha = await argon2.hash(novaSenha);
    await user.save();

    res.json({ msg: 'Senha atualizada com sucesso' });
  } catch (error) {
    console.error('Erro ao atualizar senha:', error);
    res.status(500).json({ erro: 'Erro ao atualizar senha' });
  }
};
