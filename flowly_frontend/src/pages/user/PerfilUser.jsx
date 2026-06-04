import React, { useEffect, useState } from 'react'; //useMemo
import apiClient from '../../config/apiClient';
import Sidebar from '../../components/layout/Sidebar';
import { API_ENDPOINTS, LOCAL_STORAGE_KEYS } from '../../config/config';
import { clearProfilePhotoCache, getProfilePhotoUrl } from '../../config/profilePhotoCache';
//import { authUtils } from '../../config/authUtils';
import '../../styles/pages/admin/DashboardAdmin.css';
import '../../styles/pages/user/PerfilUser.css';

function PerfilUser() {
  const [loading, setLoading] = useState(true);
  const [savingPerfil, setSavingPerfil] = useState(false);
  const [savingSenha, setSavingSenha] = useState(false);

  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [tipo, setTipo] = useState('');

  const [arquivoFoto, setArquivoFoto] = useState(null);
  const [fotoPerfil, setFotoPerfil] = useState('');

  const [senhaAtual, setSenhaAtual] = useState('');
  const [novaSenha, setNovaSenha] = useState('');
  const [confirmarSenha, setConfirmarSenha] = useState('');

  const [mensagemPerfil, setMensagemPerfil] = useState('');
  const [mensagemSenha, setMensagemSenha] = useState('');
  const [erro, setErro] = useState('');

  const carregarPerfil = async () => {
    setLoading(true);
    setErro('');
    try {
      const res = await apiClient.get(API_ENDPOINTS.USER_ME);
      setNome(res.data.nome || '');
      setEmail(res.data.email || '');
      setTipo(res.data.tipo || '');
      if (res.data.hasFotoPerfil) {
        setFotoPerfil(await getProfilePhotoUrl());
      } else {
        clearProfilePhotoCache();
        setFotoPerfil('');
      }
    } catch (error) {
      setErro('Nao foi possivel carregar seu perfil.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    carregarPerfil();
  }, []);

  const salvarPerfil = async (e) => {
    e.preventDefault();
    setMensagemPerfil('');
    setErro('');
    setSavingPerfil(true);

    try {
      const formData = new FormData();
      formData.append('nome', nome);
      if (arquivoFoto) {
        formData.append('fotoPerfil', arquivoFoto);
      }

      const res = await apiClient.put(API_ENDPOINTS.USER_ME, formData);

      const usuarioAtualizado = res.data.user;
      localStorage.setItem(LOCAL_STORAGE_KEYS.USER_NAME, usuarioAtualizado.nome);
      localStorage.removeItem(LOCAL_STORAGE_KEYS.USER_PHOTO);
      clearProfilePhotoCache();

      if (usuarioAtualizado.hasFotoPerfil) {
        setFotoPerfil(await getProfilePhotoUrl({ forceRefresh: true }));
      } else {
        setFotoPerfil('');
      }
      setArquivoFoto(null);
      setMensagemPerfil('Perfil atualizado com sucesso.');
    } catch (error) {
      setErro(error?.response?.data?.erro || 'Erro ao atualizar perfil.');
    } finally {
      setSavingPerfil(false);
    }
  };

  const redefinirSenha = async (e) => {
    e.preventDefault();
    setMensagemSenha('');
    setErro('');

    if (novaSenha !== confirmarSenha) {
      setErro('A confirmacao da nova senha nao confere.');
      return;
    }

    setSavingSenha(true);

    try {
      await apiClient.put(
        API_ENDPOINTS.USER_ME_PASSWORD,
        { senhaAtual, novaSenha }
      );

      setSenhaAtual('');
      setNovaSenha('');
      setConfirmarSenha('');
      setMensagemSenha('Senha atualizada com sucesso.');
    } catch (error) {
      setErro(error?.response?.data?.erro || 'Erro ao redefinir senha.');
    } finally {
      setSavingSenha(false);
    }
  };

  return (
    <div className="admin-page perfil-page">
      <Sidebar />

      <main className="dashboard-user perfil-content">
        <header className="perfil-header">
          <h2>Meu Perfil</h2>
          <p>Adicione sua foto, edite seu nome e redefina sua senha.</p>
        </header>

        {loading && <p>Carregando perfil...</p>}
        {!loading && erro && <p className="perfil-erro">{erro}</p>}

        {!loading && (
          <div className="perfil-grid">
            <section className="perfil-card">
              <h3>Dados do Perfil</h3>
              <form onSubmit={salvarPerfil} className="perfil-form">
                <div className="perfil-avatar-wrap">
                  {fotoPerfil ? (
                    <img
                      src={fotoPerfil}
                      alt="Foto de perfil"
                      className="perfil-avatar-img"
                    />
                  ) : (
                    <div className="perfil-avatar-fallback">{(nome || 'U').charAt(0).toUpperCase()}</div>
                  )}
                </div>

                <label>Foto de perfil</label>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/jpg"
                  onChange={(event) => setArquivoFoto(event.target.files?.[0] || null)}
                />

                <label>Nome</label>
                <input
                  type="text"
                  value={nome}
                  onChange={(event) => setNome(event.target.value)}
                  required
                />

                <label>Email</label>
                <input type="email" value={email} disabled />

                <label>Perfil de acesso</label>
                <input type="text" value={tipo === 'admin' ? 'Administrador' : 'Colaborador'} disabled />

                <button type="submit" disabled={savingPerfil}>
                  {savingPerfil ? 'Salvando...' : 'Salvar Perfil'}
                </button>

                {mensagemPerfil && <p className="perfil-sucesso">{mensagemPerfil}</p>}
              </form>
            </section>

            <section className="perfil-card">
              <h3>Redefinir Senha</h3>
              <form onSubmit={redefinirSenha} className="perfil-form">
                <label>Senha atual</label>
                <input
                  type="password"
                  value={senhaAtual}
                  onChange={(event) => setSenhaAtual(event.target.value)}
                  required
                />

                <label>Nova senha</label>
                <input
                  type="password"
                  value={novaSenha}
                  onChange={(event) => setNovaSenha(event.target.value)}
                  required
                  minLength={6}
                />

                <label>Confirmar nova senha</label>
                <input
                  type="password"
                  value={confirmarSenha}
                  onChange={(event) => setConfirmarSenha(event.target.value)}
                  required
                  minLength={6}
                />

                <button type="submit" disabled={savingSenha}>
                  {savingSenha ? 'Atualizando...' : 'Atualizar Senha'}
                </button>

                {mensagemSenha && <p className="perfil-sucesso">{mensagemSenha}</p>}
              </form>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default PerfilUser;
