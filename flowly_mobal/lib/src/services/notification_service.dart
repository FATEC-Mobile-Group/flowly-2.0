import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:meu_app/src/core/config/api_config.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/core/network/api_client.dart';
import 'package:meu_app/src/models/notification_item.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

class NotificationService {
  NotificationService({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  io.Socket? _socket;

  Future<List<NotificationItem>> listarNotificacoes() async {
    final response = await ApiClient.instance.dio.get<List<dynamic>>(
      '/api/notificacoes',
    );

    final List<dynamic> data = response.data ?? <dynamic>[];
    return data
        .whereType<Map<String, dynamic>>()
        .map(NotificationItem.fromJson)
        .toList();
  }

  Future<int> contarNaoLidas() async {
    final response = await ApiClient.instance.dio.get<Map<String, dynamic>>(
      '/api/notificacoes/count',
    );
    return (response.data?['count'] as num?)?.toInt() ?? 0;
  }

  Future<void> marcarComoLida(String id) async {
    await ApiClient.instance.dio.put('/api/notificacoes/$id/read');
  }

  Future<void> marcarTodasComoLidas() async {
    await ApiClient.instance.dio.put('/api/notificacoes/mark-all-read');
  }

  Future<void> conectar({
    required void Function(NotificationItem notification) onNotification,
  }) async {
    _socket?.disconnect();
    _socket?.dispose();

    final String? userId = await _storage.read(key: StorageKeys.userId);
    if (userId == null || userId.isEmpty) {
      return;
    }

    _socket = io.io(
      ApiConfig.baseUrl,
      io.OptionBuilder()
          .setTransports(<String>['websocket'])
          .disableAutoConnect()
          .enableReconnection()
          .build(),
    );

    _socket!.onConnect((_) {
      _socket!.emit('join_user', userId);
    });

    _socket!.on('notification_created', (dynamic data) {
      if (data is Map) {
        onNotification(NotificationItem.fromJson(Map<String, dynamic>.from(data)));
      }
    });

    _socket!.connect();
  }

  void desconectar() {
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
  }
}