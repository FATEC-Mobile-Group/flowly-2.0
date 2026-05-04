import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:meu_app/src/app/flowly_theme.dart';
import 'package:meu_app/src/core/config/api_config.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/core/network/api_client.dart';
import 'package:meu_app/src/services/auth_service.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  String _userName = '';
  String _userEmail = '';
  String _userPhoto = '';

  @override
  void initState() {
    super.initState();
    _loadUserData();
  }

  Future<void> _loadUserData() async {
    try {
      final response = await ApiClient.instance.dio.get<Map<String, dynamic>>(
        '/api/users/me',
      );
      final Map<String, dynamic> data = response.data ?? <String, dynamic>{};

      final name = (data['nome'] ?? 'Usuário').toString();
      final email = (data['email'] ?? '').toString();
      final photo = (data['fotoPerfil'] ?? '').toString();

      await _storage.write(key: StorageKeys.userName, value: name);
      await _storage.write(key: StorageKeys.userEmail, value: email);
      await _storage.write(key: StorageKeys.userPhoto, value: photo);

      setState(() {
        _userName = name;
        _userEmail = email;
        _userPhoto = photo;
      });
    } catch (_) {
      final name = await _storage.read(key: StorageKeys.userName) ?? 'Usuário';
      final email = await _storage.read(key: StorageKeys.userEmail) ?? '';
      final photo = await _storage.read(key: StorageKeys.userPhoto) ?? '';
      setState(() {
        _userName = name;
        _userEmail = email;
        _userPhoto = photo;
      });
    }
  }

  String _buildPhotoUrl() {
    if (_userPhoto.isEmpty) {
      return '';
    }
    if (_userPhoto.startsWith('http')) {
      return _userPhoto;
    }
    return '${ApiConfig.baseUrl}$_userPhoto';
  }

  Future<void> _logout() async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Desconectar'),
        content: const Text('Tem certeza que deseja sair?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Sair', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );

    if (result == true) {
      await AuthService().logout();
      if (mounted) {
        context.go('/login');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Perfil'),
        centerTitle: true,
        elevation: 0,
      ),
      body: SingleChildScrollView(
        child: Column(
          children: [
            // Header with Profile Picture
            Container(
              width: double.infinity,
              color: flowlySurface,
              padding: const EdgeInsets.symmetric(vertical: 32),
              child: Column(
                children: [
                  // Avatar
                  CircleAvatar(
                    radius: 60,
                    backgroundColor: flowlyPrimary,
                    backgroundImage: _buildPhotoUrl().isEmpty
                        ? null
                        : NetworkImage(_buildPhotoUrl()),
                    child: _buildPhotoUrl().isEmpty
                        ? Text(
                            _userName.isNotEmpty
                                ? _userName[0].toUpperCase()
                                : 'U',
                            style: const TextStyle(
                              fontSize: 40,
                              fontWeight: FontWeight.bold,
                              color: Colors.white,
                            ),
                          )
                        : null,
                  ),
                  const SizedBox(height: 16),
                  // Name
                  Text(
                    _userName,
                    style: GoogleFonts.poppins(
                      fontSize: 22,
                      fontWeight: FontWeight.w700,
                      color: flowlyText,
                    ),
                  ),
                  const SizedBox(height: 4),
                  // Email
                  Text(
                    _userEmail,
                    style: GoogleFonts.poppins(
                      fontSize: 14,
                      color: flowlyMutedText,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            // Menu Items
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Column(
                children: [
                  _buildMenuTile(
                    icon: Icons.person,
                    title: 'Meus Dados',
                    subtitle: 'Ver e editar informações',
                    onTap: () => context.go('/perfil/configuracoes'),
                  ),
                  const SizedBox(height: 12),
                  _buildMenuTile(
                    icon: Icons.lock,
                    title: 'Alterar Senha',
                    subtitle: 'Atualize sua senha',
                    onTap: () => context.go('/perfil/configuracoes'),
                  ),
                  const SizedBox(height: 12),
                  _buildMenuTile(
                    icon: Icons.notifications,
                    title: 'Notificações',
                    subtitle: 'Gerenciar notificações',
                    onTap: () => context.go('/notificacoes'),
                  ),
                  const SizedBox(height: 12),
                  _buildMenuTile(
                    icon: Icons.info,
                    title: 'Sobre',
                    subtitle: 'Versão 1.0.0',
                    onTap: () {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Flowly v1.0.0')),
                      );
                    },
                  ),
                ],
              ),
            ),
            const SizedBox(height: 32),
            // Logout Button
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: _logout,
                  icon: const Icon(Icons.logout),
                  label: const Text('Desconectar'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: flowlyAccent,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }

  Widget _buildMenuTile({
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
  }) {
    return Card(
      color: flowlySurface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: flowlyBorder),
      ),
      child: ListTile(
        leading: Container(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: flowlyPrimary.withValues(alpha: 0.1),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Icon(icon, color: flowlyPrimary),
        ),
        title: Text(
          title,
          style: GoogleFonts.poppins(
            fontWeight: FontWeight.w600,
            fontSize: 16,
            color: flowlyText,
          ),
        ),
        subtitle: Text(
          subtitle,
          style: GoogleFonts.poppins(fontSize: 12, color: flowlyMutedText),
        ),
        trailing: const Icon(Icons.chevron_right, color: flowlyMutedText),
        onTap: onTap,
      ),
    );
  }
}
