import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:go_router/go_router.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/screens/auth/login_screen.dart';
import 'package:meu_app/src/screens/auth/register_screen.dart';
import 'package:meu_app/src/screens/auth/verify_email_screen.dart';
import 'package:meu_app/src/screens/home/home_screen.dart';
import 'package:meu_app/src/screens/profile/profile_screen.dart';
import 'package:meu_app/src/screens/profile/user_settings_screen.dart';
import 'package:meu_app/src/screens/notifications/notifications_screen.dart';
import 'package:meu_app/src/screens/chats/chats_screen.dart';
import 'package:meu_app/src/screens/tasks/task_detail_screen.dart';
import 'package:meu_app/src/screens/teams/create_team_screen.dart';
import 'package:meu_app/src/screens/teams/my_teams_screen.dart';
import 'package:meu_app/src/screens/teams/team_chat_screen.dart';
import 'package:meu_app/src/screens/user/backlog_user_screen.dart';
import 'package:meu_app/src/screens/user/dashboard_user_screen.dart';
import 'package:meu_app/src/screens/user/kanban_user_screen.dart';
import 'package:meu_app/src/screens/user/tasks_user_screen.dart';

const FlutterSecureStorage _storage = FlutterSecureStorage();

final GoRouter flowlyRouter = GoRouter(
  initialLocation: '/login',
  redirect: (BuildContext context, GoRouterState state) async {
    final String? token = await _storage.read(key: StorageKeys.jwtToken);
    final bool isLoggedIn = token != null && token.isNotEmpty;

    final bool isAuthRoute =
        state.matchedLocation == '/login' ||
        state.matchedLocation == '/register' ||
        state.matchedLocation == '/verify-email';

    if (!isLoggedIn && !isAuthRoute) {
      return '/login';
    }

    if (isLoggedIn && isAuthRoute) {
      return '/dashboard';
    }

    return null;
  },
  errorBuilder: (context, state) => Scaffold(
    appBar: AppBar(title: const Text('Erro')),
    body: Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text('Erro: ${state.error}'),
          const SizedBox(height: 16),
          ElevatedButton(
            onPressed: () => context.go('/login'),
            child: const Text('Voltar'),
          ),
        ],
      ),
    ),
  ),
  routes: <RouteBase>[
    // Auth Routes
    GoRoute(
      path: '/login',
      builder: (BuildContext context, GoRouterState state) {
        final String? initialEmail = state.uri.queryParameters['email'];
        return LoginScreen(initialEmail: initialEmail);
      },
    ),
    GoRoute(
      path: '/register',
      builder: (BuildContext context, GoRouterState state) =>
          const RegisterScreen(),
    ),
    GoRoute(
      path: '/verify-email',
      builder: (BuildContext context, GoRouterState state) {
        final String email = state.uri.queryParameters['email'] ?? '';
        return VerifyEmailScreen(email: email);
      },
    ),
    GoRoute(
      path: '/home',
      builder: (BuildContext context, GoRouterState state) =>
          const HomeScreen(),
    ),
    GoRoute(
      path: '/dashboard',
      builder: (BuildContext context, GoRouterState state) =>
          const DashboardUserScreen(),
    ),
    GoRoute(
      path: '/perfil',
      builder: (BuildContext context, GoRouterState state) =>
          const ProfileScreen(),
    ),
    GoRoute(
      path: '/notificacoes',
      builder: (BuildContext context, GoRouterState state) =>
          const NotificationsScreen(),
    ),
    GoRoute(
      path: '/perfil/configuracoes',
      builder: (BuildContext context, GoRouterState state) =>
          const UserSettingsScreen(),
    ),
    GoRoute(
      path: '/equipes/minhas',
      builder: (BuildContext context, GoRouterState state) =>
          const MyTeamsScreen(),
    ),
    GoRoute(
      path: '/chats',
      builder: (BuildContext context, GoRouterState state) =>
          const ChatsScreen(),
    ),
    GoRoute(
      path: '/chats/:teamId',
      builder: (BuildContext context, GoRouterState state) {
        final String teamId = state.pathParameters['teamId'] ?? '';
        final String teamName = state.uri.queryParameters['nome'] ?? 'Equipe';
        return TeamChatScreen(teamId: teamId, teamName: teamName);
      },
    ),
    GoRoute(
      path: '/equipes/:teamId/chat',
      builder: (BuildContext context, GoRouterState state) {
        final String teamId = state.pathParameters['teamId'] ?? '';
        final String teamName = state.uri.queryParameters['nome'] ?? 'Equipe';
        return TeamChatScreen(teamId: teamId, teamName: teamName);
      },
    ),
    GoRoute(
      path: '/equipes/criar',
      builder: (BuildContext context, GoRouterState state) =>
          const CreateTeamScreen(),
    ),
    GoRoute(
      path: '/equipes/editar/:teamId',
      builder: (BuildContext context, GoRouterState state) {
        final String teamId = state.pathParameters['teamId'] ?? '';
        return CreateTeamScreen(teamId: teamId);
      },
    ),
    GoRoute(
      path: '/user/tarefas',
      builder: (BuildContext context, GoRouterState state) =>
          const TasksUserScreen(),
    ),
    GoRoute(
      path: '/backlog',
      builder: (BuildContext context, GoRouterState state) =>
          const BacklogUserScreen(),
    ),
    GoRoute(
      path: '/kanban',
      builder: (BuildContext context, GoRouterState state) =>
          const KanbanUserScreen(),
    ),
    GoRoute(
      path: '/user/tarefas/:taskId',
      builder: (BuildContext context, GoRouterState state) {
        final String taskId = state.pathParameters['taskId'] ?? '';
        return TaskDetailScreen(taskId: taskId, userType: 'user');
      },
    ),
  ],
);
