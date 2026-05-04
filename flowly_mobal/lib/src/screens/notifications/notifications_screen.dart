import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:meu_app/src/app/flowly_theme.dart';
import 'package:meu_app/src/models/notification_item.dart';
import 'package:meu_app/src/services/notification_service.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  final NotificationService _service = NotificationService();
  List<NotificationItem> _notifications = <NotificationItem>[];
  bool _loading = true;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _loadNotifications();
    _service.conectar(
      onNotification: (notification) {
        if (!mounted) {
          return;
        }
        setState(() {
          _notifications = <NotificationItem>[notification, ..._notifications];
        });
      },
    );
  }

  @override
  void dispose() {
    _service.desconectar();
    super.dispose();
  }

  Future<void> _loadNotifications() async {
    try {
      setState(() {
        _loading = true;
        _error = '';
      });

      final notifications = await _service.listarNotificacoes();
      if (!mounted) {
        return;
      }
      setState(() {
        _notifications = notifications;
      });
    } catch (_) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = 'Não foi possível carregar as notificações.';
      });
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
        });
      }
    }
  }

  Future<void> _marcarComoLida(NotificationItem notification) async {
    try {
      await _service.marcarComoLida(notification.id);
      if (!mounted) {
        return;
      }
      setState(() {
        _notifications = _notifications
            .map((item) => item.id == notification.id
                ? NotificationItem(
                    id: item.id,
                    text: item.text,
                    read: true,
                    type: item.type,
                    createdAt: item.createdAt,
                    originId: item.originId,
                    metadata: item.metadata,
                  )
                : item)
            .toList();
      });
    } catch (_) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Falha ao marcar notificação como lida')),
      );
    }
  }

  Future<void> _marcarTodasComoLidas() async {
    try {
      await _service.marcarTodasComoLidas();
      if (!mounted) {
        return;
      }
      setState(() {
        _notifications = _notifications
            .map((item) => NotificationItem(
                  id: item.id,
                  text: item.text,
                  read: true,
                  type: item.type,
                  createdAt: item.createdAt,
                  originId: item.originId,
                  metadata: item.metadata,
                ))
            .toList();
      });
    } catch (_) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Falha ao marcar notificações como lidas')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notificações'),
        centerTitle: true,
        actions: [
          TextButton(
            onPressed: _marcarTodasComoLidas,
            child: const Text(
              'Ler todas',
              style: TextStyle(color: Colors.white),
            ),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _loadNotifications,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_error.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: Text(
                        _error,
                        style: const TextStyle(color: Colors.redAccent),
                      ),
                    ),
                  if (_notifications.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(top: 120),
                      child: Center(
                        child: Text('Nenhuma notificação no momento.'),
                      ),
                    )
                  else
                    ..._notifications.map((notification) => _buildCard(notification)),
                ],
              ),
      ),
    );
  }

  Widget _buildCard(NotificationItem notification) {
    final Color accentColor;
    switch (notification.type) {
      case 'chat':
        accentColor = Colors.blueAccent;
        break;
      case 'task':
        accentColor = Colors.orangeAccent;
        break;
      case 'team':
        accentColor = Colors.greenAccent;
        break;
      default:
        accentColor = flowlyPrimary;
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: InkWell(
        onTap: notification.read ? null : () => _marcarComoLida(notification),
        borderRadius: BorderRadius.circular(16),
        child: Container(
          decoration: BoxDecoration(
            color: flowlySurface,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: notification.read ? flowlyBorder : accentColor.withValues(alpha: 0.4),
            ),
          ),
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(
                      color: accentColor.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      notification.type.toUpperCase(),
                      style: TextStyle(
                        color: accentColor,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  const Spacer(),
                  if (!notification.read)
                    const Icon(Icons.circle, size: 10, color: Colors.redAccent),
                ],
              ),
              const SizedBox(height: 12),
              Text(
                notification.text,
                style: GoogleFonts.poppins(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: flowlyText,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                _formatDate(notification.createdAt),
                style: GoogleFonts.poppins(
                  fontSize: 12,
                  color: flowlyMutedText,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _formatDate(DateTime dateTime) {
    return '${dateTime.day.toString().padLeft(2, '0')}/${dateTime.month.toString().padLeft(2, '0')}/${dateTime.year} ${dateTime.hour.toString().padLeft(2, '0')}:${dateTime.minute.toString().padLeft(2, '0')}';
  }
}