import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:go_router/go_router.dart';
import 'package:meu_app/src/app/flowly_theme.dart';
import 'package:meu_app/src/core/config/api_config.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/core/network/api_client.dart';

class AppNavigationDrawer extends StatefulWidget {
  const AppNavigationDrawer({
    super.key,
    required this.currentRoute,
    required this.onLogout,
  });

  final String currentRoute;
  final Future<void> Function() onLogout;

  @override
  State<AppNavigationDrawer> createState() => _AppNavigationDrawerState();
}

class _AppNavigationDrawerState extends State<AppNavigationDrawer> {
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  String _userName = 'Usuário';
  String _userPhoto = '';
  bool _loadingUser = true;

  @override
  void initState() {
    super.initState();
    _loadUserData();
  }

  Future<void> _loadUserData() async {
    String savedName =
        (await _storage.read(key: StorageKeys.userName))?.trim() ?? '';
    String savedPhoto =
        (await _storage.read(key: StorageKeys.userPhoto))?.trim() ?? '';

    try {
      final response = await ApiClient.instance.dio.get<Map<String, dynamic>>(
        '/api/users/me',
      );
      final Map<String, dynamic> data = response.data ?? <String, dynamic>{};
      savedName = (data['nome'] ?? savedName).toString().trim();
      savedPhoto = (data['fotoPerfil'] ?? savedPhoto).toString().trim();
      if (savedName.isNotEmpty) {
        await _storage.write(key: StorageKeys.userName, value: savedName);
      }
      await _storage.write(key: StorageKeys.userPhoto, value: savedPhoto);
    } catch (_) {
      // Mantém fallback dos dados salvos no storage.
    }

    if (!mounted) {
      return;
    }

    setState(() {
      _userName = savedName.isEmpty ? 'Usuário' : savedName;
      _userPhoto = savedPhoto;
      _loadingUser = false;
    });
  }

  String _buildPhotoUrl() {
    if (_userPhoto.isEmpty) {
      return '';
    }
    if (_userPhoto.startsWith('http')) {
      return _userPhoto;
    }
    final String normalizedPath = _userPhoto.startsWith('/')
        ? _userPhoto
        : '/$_userPhoto';
    return '${ApiConfig.baseUrl}$normalizedPath';
  }

  Widget _buildAvatar() {
    final String photoUrl = _buildPhotoUrl();
    final String initial = _userName.isNotEmpty
        ? _userName.substring(0, 1).toUpperCase()
        : 'U';

    return CircleAvatar(
      foregroundImage: photoUrl.isEmpty ? null : NetworkImage(photoUrl),
      child: photoUrl.isEmpty ? Text(initial) : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    const List<_DrawerItem> items = <_DrawerItem>[
      _DrawerItem(
        title: 'Dashboard',
        icon: Icons.dashboard_outlined,
        route: '/dashboard',
      ),
      _DrawerItem(
        title: 'Minhas tarefas',
        icon: Icons.task_alt_outlined,
        route: '/user/tarefas',
      ),
      _DrawerItem(
        title: 'Kanban',
        icon: Icons.view_kanban_outlined,
        route: '/kanban',
      ),
      _DrawerItem(
        title: 'Backlog',
        icon: Icons.inbox_outlined,
        route: '/backlog',
      ),
      _DrawerItem(
        title: 'Chats',
        icon: Icons.forum_outlined,
        route: '/chats',
      ),
      _DrawerItem(
        title: 'Notificações',
        icon: Icons.notifications_outlined,
        route: '/notificacoes',
      ),
      _DrawerItem(
        title: 'Minhas Equipes',
        icon: Icons.groups_outlined,
        route: '/equipes/minhas',
      ),
      _DrawerItem(
        title: 'Meu Perfil',
        icon: Icons.person_outline,
        route: '/perfil',
      ),
    ];

    return Drawer(
      backgroundColor: flowlySurface,
      child: SafeArea(
        child: Column(
          children: <Widget>[
            UserAccountsDrawerHeader(
              margin: EdgeInsets.zero,
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: <Color>[flowlyPrimary, flowlySecondary],
                ),
              ),
              currentAccountPicture: _buildAvatar(),
              accountName: Text(
                _loadingUser ? 'Carregando...' : _userName,
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w700,
                ),
              ),
              accountEmail: const Text(
                'Painel usuário',
                style: TextStyle(color: Color(0xE6FFFFFF)),
              ),
            ),
            Expanded(
              child: ListView(
                children: <Widget>[
                  ...items.map((item) {
                    final bool selected = _isSelected(
                      item.route,
                      widget.currentRoute,
                    );
                    return ListTile(
                      leading: Icon(item.icon),
                      title: Text(item.title),
                      selectedTileColor: flowlyPrimary.withValues(alpha: 0.18),
                      selected: selected,
                      onTap: () {
                        Navigator.of(context).pop();
                        if (!selected) {
                          context.go(item.route);
                        }
                      },
                    );
                  }),
                ],
              ),
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.logout),
              title: const Text('Sair'),
              onTap: () async {
                Navigator.of(context).pop();
                await widget.onLogout();
              },
            ),
          ],
        ),
      ),
    );
  }

  bool _isSelected(String itemRoute, String route) {
    if (itemRoute == route) {
      return true;
    }
    return route.startsWith(itemRoute);
  }
}

class _DrawerItem {
  const _DrawerItem({
    required this.title,
    required this.icon,
    required this.route,
  });

  final String title;
  final IconData icon;
  final String route;
}
