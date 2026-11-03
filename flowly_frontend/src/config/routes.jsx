/**
 * Definição centralizada de rotas da aplicação
 */

import AuthPage from '../pages/auth/AuthPage';
import Verify from '../pages/auth/Verify';
import DashboardAdmin from '../pages/admin/DashboardAdmin';
import DashboardUser from '../pages/user/DashboardUser';
import DashboardGeral from '../pages/dashboard/DashboardGeral';
import DashboardTarefasAdmin from '../pages/admin/DashboardTarefasAdmin';
import TarefasAdmin from '../pages/admin/TarefasAdmin';
import TarefasUser from '../pages/user/TarefasUser';
import BacklogUser from '../pages/user/BacklogUser';
import BacklogTaskDetailUser from '../pages/user/BacklogTaskDetailUser';
import EquipesUser from '../pages/user/EquipesUser';
import PerfilUser from '../pages/user/PerfilUser';
import Equipes from '../pages/admin/Equipes';
import ChatsPage from '../pages/common/ChatsPage';
import NotificationsPage from '../pages/common/NotificationsPage';
import VoiceAssistantPage from '../pages/common/VoiceAssistantPage';
import { USER_TYPES } from './config';

/**
 * Rotas públicas (não autenticadas)
 */
export const publicRoutes = [
  {
    path: '/',
    element: <AuthPage />,
  },
  {
    path: '/register',
    element: <AuthPage />,
  },
  {
    path: '/verificar-2fa',
    element: <Verify />,
  },
];

/**
 * Rotas protegidas de admin
 */
export const adminRoutes = [
  {
    path: '/admin',
    element: <DashboardAdmin />,
    requiredRole: USER_TYPES.ADMIN,
  },
  {
    path: '/admin/equipe/:id',
    element: <Equipes />,
    requiredRole: USER_TYPES.ADMIN,
  },
  {
    path: '/admin/criar-equipe',
    element: <Equipes />,
    requiredRole: USER_TYPES.ADMIN,
  },
  {
    path: '/admin/tarefas',
    element: <DashboardTarefasAdmin />,
    requiredRole: USER_TYPES.ADMIN,
  },
  {
    path: '/admin/criar-tarefa',
    element: <TarefasAdmin />,
    requiredRole: USER_TYPES.ADMIN,
  },
  {
    path: '/admin/editar-tarefa/:id',
    element: <TarefasAdmin />,
    requiredRole: USER_TYPES.ADMIN,
  },
  {
    path: '/admin/geral',
    element: <DashboardGeral />,
    requiredRole: USER_TYPES.ADMIN,
  },
  {
    path: '/admin/chats',
    element: <ChatsPage />,
    requiredRole: USER_TYPES.ADMIN,
  },
  {
    path: '/perfil',
    element: <PerfilUser />,
  },
];

/**
 * Rotas protegidas de usuário comum
 */
export const userRoutes = [
  {
    path: '/dashboard',
    element: <DashboardUser />,
    requiredRole: USER_TYPES.USER,
  },
  {
    path: '/minhas-tarefas',
    element: <TarefasUser />,
    requiredRole: USER_TYPES.USER,
  },
  {
    path: '/backlog',
    element: <BacklogUser />,
    requiredRole: USER_TYPES.USER,
  },
  {
    path: '/backlog/:id',
    element: <BacklogTaskDetailUser />,
    requiredRole: USER_TYPES.USER,
  },
  {
    path: '/equipes',
    element: <EquipesUser />,
    requiredRole: USER_TYPES.USER,
  },
  {
    path: '/chats',
    element: <ChatsPage />,
    requiredRole: USER_TYPES.USER,
  },
  {
    path: '/assistente',
    element: <VoiceAssistantPage />,
  },
  {
    path: '/notificacoes',
    element: <NotificationsPage />,
  },
  {
    path: '/perfil',
    element: <PerfilUser />,
    requiredRole: USER_TYPES.USER,
  },
];

/**
 * Combina todas as rotas
 */
export const allRoutes = [...publicRoutes, ...adminRoutes, ...userRoutes];
