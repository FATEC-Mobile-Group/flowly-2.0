import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import 'package:meu_app/src/core/config/api_config.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/core/network/api_client.dart';
import 'package:meu_app/src/models/chat_message.dart';

class ChatService {
  ChatService({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  io.Socket? _socket;

  Future<List<ChatMessage>> carregarHistorico(String equipeId) async {
    try {
      final response = await ApiClient.instance.dio.get<List<dynamic>>(
        '/api/equipes/$equipeId/messages',
      );

      final List<dynamic> data = response.data ?? <dynamic>[];
      return data
          .whereType<Map<String, dynamic>>()
          .map(ChatMessage.fromJson)
          .toList();
    } catch (error) {
      throw ApiClient.mapError(error);
    }
  }

  Future<void> conectar({
    required String equipeId,
    required void Function(ChatMessage message) onMessage,
  }) async {
    _socket?.disconnect();
    _socket?.dispose();

    final String? token = await _storage.read(key: StorageKeys.jwtToken);
    if (token == null || token.isEmpty) {
      return;
    }

    _socket = io.io(
      ApiConfig.baseUrl,
      io.OptionBuilder()
          .setTransports(<String>['websocket'])
          .setAuth(<String, dynamic>{'token': token})
          .disableAutoConnect()
          .enableReconnection()
          .build(),
    );

    _socket!.onConnect((_) {
      _socket!.emit('join_equipe', equipeId);
    });

    _socket!.on('receive_message', (dynamic data) {
      if (data is Map) {
        onMessage(ChatMessage.fromJson(Map<String, dynamic>.from(data)));
      }
    });

    _socket!.connect();
  }

  void enviarMensagem({required String equipeId, required String texto}) {
    _socket?.emit('send_message', <String, dynamic>{
      'equipeId': equipeId,
      'texto': texto,
    });
  }

  void desconectar() {
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
  }
}
