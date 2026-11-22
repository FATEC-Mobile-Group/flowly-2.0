import 'dart:async';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import 'package:meu_app/src/core/config/api_config.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/core/network/api_client.dart';
import 'package:meu_app/src/models/chat_message.dart';

/// Resultado de um envio do chat. Só [ChatSendStatus.sent] significa mensagem gravada pelo servidor.
enum ChatSendStatus { sent, blocked, error, offline, uncertain }

class ChatSendResult {
  const ChatSendResult(this.status, {this.message = '', this.messageId});

  static const String blockedMessage =
      'Sua mensagem não foi enviada porque viola as regras do chat. '
      'Revise o texto e tente novamente.';
  static const String errorMessage =
      'Não foi possível enviar a mensagem agora. Seu texto foi mantido; '
      'tente novamente.';
  static const String offlineMessage =
      'Sem conexão com o chat no momento. Seu texto foi mantido; '
      'tente de novo quando a conexão voltar.';
  static const String uncertainMessage =
      'Não recebemos a confirmação do servidor. Confira se a mensagem '
      'apareceu no chat antes de enviar de novo.';

  static const ChatSendResult offline = ChatSendResult(
    ChatSendStatus.offline,
    message: offlineMessage,
  );
  static const ChatSendResult uncertain = ChatSendResult(
    ChatSendStatus.uncertain,
    message: uncertainMessage,
  );

  final ChatSendStatus status;
  final String message;
  final String? messageId;

  bool get isSent => status == ChatSendStatus.sent;

  /// Interpreta o ACK de `send_message`: `{ok, messageId}` ou `{ok: false, blocked, message}`.
  factory ChatSendResult.fromAck(dynamic response) {
    final Map<dynamic, dynamic> data = _unwrap(response);
    final String text = _text(data['message']);
    if (data['ok'] == true) {
      final dynamic id = data['messageId'];
      return ChatSendResult(
        ChatSendStatus.sent,
        messageId: id == null ? null : '$id',
      );
    }
    if (data['blocked'] == true) {
      return ChatSendResult(
        ChatSendStatus.blocked,
        message: text.isEmpty ? blockedMessage : text,
      );
    }
    return ChatSendResult(
      ChatSendStatus.error,
      message: text.isEmpty ? errorMessage : text,
    );
  }

  /// Servidor anterior ao ACK: recusas chegam só pelo evento `message_blocked`.
  factory ChatSendResult.fromLegacyBlocked(dynamic payload) {
    final Map<dynamic, dynamic> data = _unwrap(payload);
    final String text = _text(data['message']);
    final bool accessProblem = <String>[
      'team_access_denied',
      'invalid_user',
    ].contains(data['reason']);
    return ChatSendResult(
      accessProblem ? ChatSendStatus.error : ChatSendStatus.blocked,
      message: text.isNotEmpty
          ? text
          : accessProblem
          ? errorMessage
          : blockedMessage,
    );
  }

  static Map<dynamic, dynamic> _unwrap(dynamic value) {
    dynamic current = value;
    // Alguns servidores entregam o ACK como lista de argumentos.
    if (current is List && current.isNotEmpty) {
      current = current.first;
    }
    return current is Map ? current : <dynamic, dynamic>{};
  }

  static String _text(dynamic value) => value is String ? value.trim() : '';
}

/// Envia `send_message` e espera a confirmação do servidor uma única vez.
/// Sem conexão, não emite (o pacote ficaria no buffer e sairia sozinho na reconexão).
/// Sem resposta no prazo ou com queda da conexão, o resultado é incerto e nada é reenviado.
Future<ChatSendResult> sendChatMessageWithAck(
  io.Socket? socket, {
  required String equipeId,
  required String texto,
  Duration timeout = ChatService.sendTimeout,
}) {
  if (socket == null || !socket.connected) {
    return Future<ChatSendResult>.value(ChatSendResult.offline);
  }

  final Completer<ChatSendResult> completer = Completer<ChatSendResult>();
  Timer? timer;
  late final dynamic Function(dynamic) onLegacyBlocked;
  late final dynamic Function(dynamic) onDisconnect;

  void finish(ChatSendResult result) {
    if (completer.isCompleted) {
      return;
    }
    timer?.cancel();
    socket.off('message_blocked', onLegacyBlocked);
    socket.off('disconnect', onDisconnect);
    completer.complete(result);
  }

  onLegacyBlocked = (dynamic payload) =>
      finish(ChatSendResult.fromLegacyBlocked(payload));
  onDisconnect = (dynamic _) => finish(ChatSendResult.uncertain);

  socket.on('message_blocked', onLegacyBlocked);
  socket.on('disconnect', onDisconnect);
  timer = Timer(timeout, () => finish(ChatSendResult.uncertain));

  socket.emitWithAck(
    'send_message',
    <String, dynamic>{'equipeId': equipeId, 'texto': texto},
    ack: (dynamic response) => finish(ChatSendResult.fromAck(response)),
  );
  return completer.future;
}

class ChatService {
  ChatService({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const Duration sendTimeout = Duration(seconds: 10);

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

  Future<ChatSendResult> enviarMensagem({
    required String equipeId,
    required String texto,
  }) {
    return sendChatMessageWithAck(_socket, equipeId: equipeId, texto: texto);
  }

  void desconectar() {
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
  }
}
