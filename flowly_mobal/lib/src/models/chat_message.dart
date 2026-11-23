/// Arquivo anexado a uma mensagem do chat (contrato: flowly_api/services/chatAttachmentService.js).
/// As URLs são caminhos relativos da API (`/api/equipes/:id/mensagens/:mid/anexo`), sempre autenticados.
class ChatAttachment {
  const ChatAttachment({
    required this.nomeOriginal,
    required this.mimetype,
    required this.size,
    required this.downloadUrl,
    this.previewUrl,
  });

  final String nomeOriginal;
  final String mimetype;
  final int size;
  final String downloadUrl;
  final String? previewUrl;

  bool get isImage => mimetype == 'image/png' || mimetype == 'image/jpeg';

  static ChatAttachment? fromJson(dynamic json) {
    if (json is! Map) {
      return null;
    }
    final String downloadUrl = (json['downloadUrl'] ?? '').toString();
    if (downloadUrl.isEmpty) {
      return null;
    }
    final dynamic size = json['size'];
    final String preview = (json['previewUrl'] ?? '').toString();
    return ChatAttachment(
      nomeOriginal: (json['nomeOriginal'] ?? 'arquivo').toString(),
      mimetype: (json['mimetype'] ?? '').toString(),
      size: size is num ? size.toInt() : int.tryParse('$size') ?? 0,
      downloadUrl: downloadUrl,
      previewUrl: preview.isEmpty ? null : preview,
    );
  }
}

class ChatMessage {
  final String id;
  final String texto;
  final String userId;
  final String userName;
  final DateTime? createdAt;

  /// `texto` ou `anexo`. Mensagens antigas (sem o campo) são texto.
  final String tipo;
  final ChatAttachment? anexo;
  final String? clientMessageId;

  const ChatMessage({
    required this.id,
    required this.texto,
    required this.userId,
    required this.userName,
    this.createdAt,
    this.tipo = 'texto',
    this.anexo,
    this.clientMessageId,
  });

  bool get isAttachment => tipo == 'anexo' && anexo != null;

  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    final dynamic user = json['user'];
    final String resolvedUserId = user is Map
        ? (user['_id'] ?? '').toString()
        : (json['user'] ?? '').toString();
    final String resolvedUserName = user is Map
        ? (user['nome'] ?? '').toString()
        : '';
    final dynamic clientId = json['clientMessageId'];

    return ChatMessage(
      id: (json['_id'] ?? json['id'] ?? '').toString(),
      texto: (json['texto'] ?? '').toString(),
      userId: resolvedUserId,
      userName: resolvedUserName,
      createdAt: json['createdAt'] == null
          ? null
          : DateTime.tryParse(json['createdAt'].toString()),
      tipo: json['tipo'] == 'anexo' ? 'anexo' : 'texto',
      anexo: json['tipo'] == 'anexo'
          ? ChatAttachment.fromJson(json['anexo'])
          : null,
      clientMessageId: clientId == null ? null : '$clientId',
    );
  }
}

/// Uma lista só, sem repetir `_id` (a resposta HTTP do upload, o evento do socket, o histórico e a
/// sincronização da reconexão podem trazer a mesma mensagem), em ordem cronológica estável.
/// A versão mais recente de uma mensagem repetida substitui a anterior.
List<ChatMessage> mergeChatMessages(
  List<ChatMessage> current,
  Iterable<ChatMessage> incoming,
) {
  final List<ChatMessage> list = List<ChatMessage>.of(current);
  final Map<String, int> index = <String, int>{
    for (int i = 0; i < list.length; i++)
      if (list[i].id.isNotEmpty) list[i].id: i,
  };
  for (final ChatMessage message in incoming) {
    final int? position = message.id.isEmpty ? null : index[message.id];
    if (position != null) {
      list[position] = message;
    } else {
      if (message.id.isNotEmpty) {
        index[message.id] = list.length;
      }
      list.add(message);
    }
  }
  final List<MapEntry<int, ChatMessage>> ordered = list.asMap().entries.toList()
    ..sort((MapEntry<int, ChatMessage> a, MapEntry<int, ChatMessage> b) {
      final DateTime? ta = a.value.createdAt;
      final DateTime? tb = b.value.createdAt;
      if (ta != null && tb != null && ta != tb) {
        return ta.compareTo(tb);
      }
      if (ta == null && tb != null) {
        return 1;
      }
      if (ta != null && tb == null) {
        return -1;
      }
      return a.key.compareTo(b.key);
    });
  return ordered.map((MapEntry<int, ChatMessage> e) => e.value).toList();
}
