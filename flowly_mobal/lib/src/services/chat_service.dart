import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import 'package:meu_app/src/core/config/api_config.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/core/network/api_client.dart';
import 'package:meu_app/src/models/chat_message.dart';
import 'package:meu_app/src/services/chat_attachments.dart';

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

/// Resultado do upload: a mensagem gravada e se era uma repetição reconhecida (HTTP 200).
class ChatAttachmentUploadResult {
  const ChatAttachmentUploadResult(this.message, {this.duplicate = false});

  final ChatMessage message;
  final bool duplicate;
}

class ChatService {
  ChatService({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const Duration sendTimeout = Duration(seconds: 10);
  static const Duration attachmentTimeout = Duration(seconds: 120);

  final FlutterSecureStorage _storage;
  io.Socket? _socket;
  final StreamController<void> _reconnections =
      StreamController<void>.broadcast();

  /// Emite a cada reconexão do socket (não na primeira conexão): a tela busca o que chegou com `?after=`.
  Stream<void> get reconexoes => _reconnections.stream;

  @protected
  void notificarReconexao() {
    if (!_reconnections.isClosed) {
      _reconnections.add(null);
    }
  }

  /// Mensagens gravadas depois de [after] (sincronização após reconexão).
  Future<List<ChatMessage>> carregarNovasMensagens(
    String equipeId,
    DateTime after,
  ) async {
    try {
      final response = await ApiClient.instance.dio.get<List<dynamic>>(
        '/api/equipes/$equipeId/messages',
        queryParameters: <String, dynamic>{
          'after': after.toUtc().toIso8601String(),
        },
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

  /// Upload autenticado (o ApiClient injeta o JWT). Sem nova tentativa automática: quem repete é a
  /// pessoa, com o mesmo [clientMessageId], e o backend reconhece a repetição (200) sem duplicar.
  Future<ChatAttachmentUploadResult> enviarAnexo({
    required String equipeId,
    required PickedChatFile file,
    required String clientMessageId,
    String legenda = '',
    void Function(double? progress)? onProgress,
    CancelToken? cancelToken,
  }) async {
    final String? mimetype = file.mimetype;
    if (mimetype == null) {
      throw validateChatFile(file)!;
    }
    final DioMediaType contentType = DioMediaType.parse(mimetype);
    final MultipartFile part = file.bytes != null
        ? MultipartFile.fromBytes(
            file.bytes!,
            filename: file.name,
            contentType: contentType,
          )
        : await MultipartFile.fromFile(
            file.path!,
            filename: file.name,
            contentType: contentType,
          );
    final FormData form = FormData()
      ..fields.add(
        MapEntry<String, String>('clientMessageId', clientMessageId),
      );
    if (legenda.isNotEmpty) {
      form.fields.add(MapEntry<String, String>('legenda', legenda));
    }
    form.files.add(MapEntry<String, MultipartFile>('file', part));

    try {
      final Response<dynamic> response = await ApiClient.instance.dio
          .post<dynamic>(
            '/api/equipes/$equipeId/mensagens/anexos',
            data: form,
            cancelToken: cancelToken,
            options: Options(
              sendTimeout: attachmentTimeout,
              receiveTimeout: attachmentTimeout,
            ),
            onSendProgress: onProgress == null
                ? null
                : (int sent, int total) => onProgress(
                    total > 0 ? (sent / total).clamp(0, 1).toDouble() : null,
                  ),
          );
      final dynamic data = response.data;
      final dynamic message = data is Map ? data['message'] : null;
      if (message is! Map) {
        throw const ChatAttachmentException(
          'Falha no envio',
          'O servidor respondeu de forma inesperada. Confira se o arquivo apareceu no chat.',
        );
      }
      return ChatAttachmentUploadResult(
        ChatMessage.fromJson(Map<String, dynamic>.from(message)),
        duplicate: data['duplicate'] == true || response.statusCode == 200,
      );
    } catch (error) {
      throw describeChatUploadError(error);
    }
  }

  /// Bytes do anexo pela rota privada (JWT no cabeçalho, nunca na URL). Nada é gravado em disco aqui.
  Future<Uint8List> baixarAnexo(String path, {CancelToken? cancelToken}) async {
    if (!isValidAttachmentPath(path)) {
      throw invalidAttachmentPath;
    }
    try {
      final Response<List<int>> response = await ApiClient.instance.dio
          .get<List<int>>(
            path,
            cancelToken: cancelToken,
            options: Options(
              responseType: ResponseType.bytes,
              receiveTimeout: attachmentTimeout,
            ),
          );
      final List<int> bytes = response.data ?? <int>[];
      return bytes is Uint8List ? bytes : Uint8List.fromList(bytes);
    } catch (error) {
      throw describeChatDownloadError(error);
    }
  }

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

    bool connectedBefore = false;
    _socket!.onConnect((_) {
      _socket!.emit('join_equipe', equipeId);
      if (connectedBefore) {
        notificarReconexao();
      }
      connectedBefore = true;
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
